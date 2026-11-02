import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { reserveBackendPort } from "./cloudflare.js"
import { syncExposures } from "./exposure.js"
import { resolveMaxTtlSeconds } from "./config.js"
import { childEnvironment, loadWorkspaceEnvironment } from "./environment.js"
import { exitMarker, forEachLogChunk, isMarkerLine, parseExitMarker, rotateLargeLog, startMarker, writeMarker } from "./logs.js"
import type { CommandExit } from "./logs.js"
import { appError, debugLog, describe, err, errResult, ok, tryAsync, trySync } from "./result.js"
import { commandLogFile, listWorkspaceStates, readWorkspaceState, writeWorkspaceState } from "./state.js"
import { portlessLabel } from "./names.js"
import { commandProcess, commandRoute, portlessPorts, portlessPortsForConfig, portlessUrl, publicUrl, refreshRouteUrl, routeEnvironment, routeEnvironmentForConfig, routeUrlsForConfig } from "./portless.js"
import { existsAt, isPidRunning, isTrackedPidRunning } from "./shell.js"
import type { Result } from "./result.js"
import type { CommandRecord, DevConfig, Exposure, StartResult, WorkspaceRecord, WorkspaceState } from "./types.js"

const STARTUP_GRACE_MS = 1_500
const STARTUP_TAIL_LINES = 10

// Exit statuses of commands this process spawned, kept until prune records them.
const exits = new Map<number, CommandExit>()

export async function startCommand(
  config: DevConfig,
  workspace: WorkspaceRecord,
  id: string,
  exposure: Exposure = { mode: "local" },
  invokingEnvironment: NodeJS.ProcessEnv = process.env,
  { preserveTtl = false }: { preserveTtl?: boolean } = {},
): Promise<Result<{ record: CommandRecord; started: boolean }>> {
  const command = config.commands[id]

  if (!command) {
    return errResult("ProcessError", `unknown command: ${id}`)
  }

  const environment = await loadWorkspaceEnvironment(
    workspace.sourceRoot ?? workspace.root,
    workspace.root,
    invokingEnvironment,
  )
  if (!environment.ok) return environment

  const cwd = path.resolve(workspace.root, command.cwd ?? ".")
  const log = commandLogFile(config.project, workspace.workspace, id)

  const stateResult = await readWorkspaceState(config.project, workspace.workspace)
  if (!stateResult.ok) return stateResult
  const state = stateResult.value
  const existing = state?.commands[id]
  if (preserveTtl && !existing) return errResult("ProcessError", `no tracked command: ${workspace.workspace}/${id}`)
  if (preserveTtl && existing && commandTtlExpired(existing)) return ok({ record: existing, started: false })
  const ttl = preserveTtl ? ok(existing?.maxTtlSeconds ?? 0) : await resolveMaxTtlSeconds(config, invokingEnvironment)
  if (!ttl.ok) return ttl
  const stateMode = state?.exposure?.mode ?? "local"
  const commandStatuses = await Promise.all(Object.values(state?.commands ?? {}).map(commandRuntimeStatus))
  const hasLiveCommand = commandStatuses.includes("up")

  if (hasLiveCommand && stateMode !== exposure.mode) {
    return errResult("ProcessError", `workspace ${workspace.workspace} is already running in ${stateMode} mode. Run work down ${workspace.workspace} before switching.`)
  }

  if (existing && await commandRuntimeStatus(existing) === "up") {
    if ((existing.exposure?.mode ?? "local") !== exposure.mode) {
      return errResult("ProcessError", `command ${id} is tracked in ${existing.exposure?.mode ?? "local"} mode. Run work down ${workspace.workspace} before switching.`)
    }
    return ok({ record: existing, started: false })
  }

  if (existing) {
    const stopped = await stopTrackedProcess(existing)
    if (!stopped.ok) return stopped
  }

  const route = commandRoute(config, workspace.workspace, id, command)
  const ports = await portlessPortsForConfig(config, environment.value)
  const port = ports[id] ?? 443
  if (exposure.mode !== "local" && command.route === true && !route) {
    return errResult("ProcessError", `command ${id} must use Portless to publish through ${exposure.mode === "cloudflare" ? "Cloudflare Tunnel" : "Tailscale"}`)
  }

  const published = exposure.mode === "cloudflare" && Boolean(route)
  const backendPortResult = published ? await reserveBackendPort() : ok<number | undefined>(undefined)
  if (!backendPortResult.ok) return backendPortResult
  const backendPort = backendPortResult.value
  const commandExec = commandProcess(command.run, route, backendPort)
  if (preserveTtl && existing && commandTtlExpired(existing)) return ok({ record: existing, started: false })
  const spawned = await spawnLogged(id, commandExec, {
    cwd,
    log,
    env: {
      ...childEnvironment({ ...config.env, ...environment.value }),
      WORK_PROJECT: config.project,
      WORK_WORKSPACE: workspace.workspace,
      WORK_COMMAND: id,
      ...routeEnvironmentForConfig(config, workspace.workspace, ports, exposure),
      ...command.env,
    },
  })
  if (!spawned.ok) return spawned

  const { pid, logOffset } = spawned.value
  const startedAt = new Date().toISOString()
  const maxTtlSeconds = ttl.value
  const record: CommandRecord = {
    id,
    label: command.label ?? id,
    pid,
    command: commandExec.display,
    run: command.run,
    route,
    cwd,
    log,
    url: publicUrl(config, workspace.workspace, id, command, exposure, port),
    localUrl: portlessUrl(config, workspace.workspace, id, command, port),
    exposure,
    ...(backendPort ? { backendPort } : {}),
    ...(command.env ? { env: command.env } : {}),
    ...(command.restart ? { restart: command.restart } : {}),
    ...(command.ready ? { ready: command.ready } : {}),
    startedAt,
    logOffset,
    ...(maxTtlSeconds > 0 ? {
      maxTtlSeconds,
      ttlStartedAt: preserveTtl && existing ? existing.ttlStartedAt ?? existing.startedAt : startedAt,
    } : {}),
  }

  const nextState: WorkspaceState = state ?? freshState(workspace)
  nextState.root = workspace.root
  nextState.branch = workspace.branch
  nextState.sourceRoot = workspace.sourceRoot ?? workspace.root
  if (config.maxTtlSeconds !== undefined) nextState.maxTtlSeconds = config.maxTtlSeconds
  else delete nextState.maxTtlSeconds
  if (config.env) nextState.env = childEnvironment(config.env)
  else delete nextState.env
  nextState.exposure = exposure
  nextState.urls = routeUrlsForConfig(config, workspace.workspace, ports, exposure)
  nextState.commands[id] = record

  const write = await writeWorkspaceState(nextState)
  if (!write.ok) {
    await stopProcessTree(pid)
    return write
  }

  if (exposure.mode !== "local" && route) {
    const synced = await syncExposures(environment.value)
    if (!synced.ok) {
      delete nextState.commands[id]
      clearEmptyWorkspaceExposure(nextState)
      await writeWorkspaceState(nextState)
      await stopProcessTree(pid)
      await syncExposures(environment.value)
      return synced
    }
  }

  return ok({ record, started: true })
}

async function spawnLogged(
  id: string,
  commandExec: ReturnType<typeof commandProcess>,
  options: { cwd: string; log: string; env: NodeJS.ProcessEnv },
): Promise<Result<{ pid: number; logOffset: number }>> {
  const mkdir = await tryAsync("IOError", "failed to create log directory", async () =>
    await fsp.mkdir(path.dirname(options.log), { recursive: true }),
  )
  if (!mkdir.ok) return mkdir
  await rotateLargeLog(options.log)

  const openLog = trySync("IOError", `failed to open log file ${options.log}`, () => fs.openSync(options.log, "a+"))
  if (!openLog.ok) return openLog
  const marked = trySync("IOError", `failed to write log file ${options.log}`, () =>
    writeMarker(openLog.value, startMarker(id, new Date().toISOString())),
  )
  if (!marked.ok) {
    fs.closeSync(openLog.value)
    return marked
  }

  const spawned = await spawnWithLog(commandExec.executable, commandExec.args, {
    cwd: options.cwd,
    shell: commandExec.shell,
    output: openLog.value,
    env: options.env,
  })
  if (!spawned.ok) return spawned
  spawned.value.unref()

  const pid = spawned.value.pid
  if (!pid) {
    return errResult("ProcessError", `spawn produced no pid for ${id}`)
  }

  exits.delete(pid)
  spawned.value.once("exit", (code, signal) => {
    const exit = { code, signal, at: new Date().toISOString() }
    exits.set(pid, exit)
    const written = trySync("IOError", `failed to write log file ${options.log}`, () => {
      const fd = fs.openSync(options.log, "a+")
      try {
        writeMarker(fd, exitMarker(id, pid, exit))
      } finally {
        fs.closeSync(fd)
      }
    })
    if (!written.ok) debugLog("processes", `exit marker for ${id} failed: ${written.error.message}`)
  })

  return ok({ pid, logOffset: marked.value })
}

function freshState(workspace: WorkspaceRecord): WorkspaceState {
  return {
    project: workspace.project,
    workspace: workspace.workspace,
    branch: workspace.branch,
    root: workspace.root,
    ...(workspace.sourceRoot ? { sourceRoot: workspace.sourceRoot } : {}),
    commands: {},
  }
}

export async function stopCommand(
  project: string,
  workspace: string,
  id: string,
  options: { syncExposures?: boolean; environment?: NodeJS.ProcessEnv } = {},
): Promise<Result<boolean>> {
  const stateResult = await readWorkspaceState(project, workspace)
  if (!stateResult.ok) return stateResult
  const state = stateResult.value
  const command = state?.commands[id]

  if (!state || !command) {
    return ok(false)
  }

  const stopped = await stopTrackedProcess(command)
  if (!stopped.ok) return stopped

  delete state.commands[id]
  clearEmptyWorkspaceExposure(state)
  const write = await writeWorkspaceState(state)
  if (!write.ok) return write

  if (command.exposure && command.exposure.mode !== "local" && options.syncExposures !== false) {
    const environment = await loadWorkspaceEnvironment(
      state.sourceRoot ?? state.root,
      state.root,
      options.environment,
    )
    if (!environment.ok) return environment
    const synced = await syncExposures(environment.value)
    if (!synced.ok) return synced
  }

  return ok(true)
}

export async function restartTrackedCommand(
  project: string,
  workspace: string,
  id: string,
  invokingEnvironment: NodeJS.ProcessEnv = process.env,
  { preserveTtl = false }: { preserveTtl?: boolean } = {},
): Promise<Result<{ record: CommandRecord; started: boolean }>> {
  const stateResult = await readWorkspaceState(project, workspace)
  if (!stateResult.ok) return stateResult

  const state = stateResult.value
  const command = state?.commands[id]

  if (!state || !command) {
    return errResult("ProcessError", `no tracked command: ${workspace}/${id}`)
  }

  if (typeof command.run !== "string") {
    return errResult("ProcessError", `tracked record for ${workspace}/${id} predates this work version. Run: work stop ${id} && work run ${id}`)
  }

  if (preserveTtl && commandTtlExpired(command)) return ok({ record: command, started: false })
  const ttl = preserveTtl ? ok(command.maxTtlSeconds ?? 0) : await resolveMaxTtlSeconds(state, invokingEnvironment)
  if (!ttl.ok) return ttl

  const environment = await loadWorkspaceEnvironment(
    state.sourceRoot ?? state.root,
    state.root,
    invokingEnvironment,
  )
  if (!environment.ok) return environment

  const stopped = await stopTrackedProcess(command)
  if (!stopped.ok) return stopped

  // Recompute what older records or a moved Portless proxy left stale; tailnet and Cloudflare URLs pass through.
  const recordedUrls = stateRouteUrls(state)
  const ports = await portlessPorts({ ...state.env, ...environment.value }, Object.fromEntries(
    [...new Set([...Object.keys(recordedUrls), ...(command.url || command.localUrl ? [id] : [])])].map((other) => [other, state.commands[other]?.env]),
  ))
  const urls = Object.fromEntries(Object.entries(recordedUrls).map(([other, url]) => [other, refreshRouteUrl(url, ports[other] ?? 443)]))
  const route = command.route ? portlessLabel(command.route) : null
  const port = ports[id] ?? 443

  const commandExec = commandProcess(command.run, route, command.backendPort)
  if (preserveTtl && commandTtlExpired(command)) return ok({ record: command, started: false })
  const spawned = await spawnLogged(id, commandExec, {
    cwd: command.cwd,
    log: command.log,
    env: {
      ...childEnvironment({ ...state.env, ...environment.value }),
      WORK_PROJECT: project,
      WORK_WORKSPACE: workspace,
      WORK_COMMAND: id,
      ...routeEnvironment(urls),
      ...command.env,
    },
  })
  if (!spawned.ok) return spawned

  const pid = spawned.value.pid
  const record: CommandRecord = {
    ...command,
    route,
    url: command.url ? refreshRouteUrl(command.url, port) : command.url,
    ...(command.localUrl ? { localUrl: refreshRouteUrl(command.localUrl, port) } : {}),
    pid,
    command: commandExec.display,
    startedAt: new Date().toISOString(),
    logOffset: spawned.value.logOffset,
  }
  delete record.exitedAt
  delete record.exitCode
  delete record.exitSignal
  if (ttl.value > 0) {
    record.maxTtlSeconds = ttl.value
    record.ttlStartedAt = preserveTtl ? command.ttlStartedAt ?? command.startedAt : record.startedAt
  } else {
    delete record.maxTtlSeconds
    delete record.ttlStartedAt
  }

  state.commands[id] = record
  if (state.urls) state.urls = urls
  const write = await writeWorkspaceState(state)
  if (!write.ok) {
    await stopProcessTree(pid)
    return write
  }

  if (command.exposure && command.exposure.mode !== "local") {
    const synced = await syncExposures(environment.value)
    if (!synced.ok) {
      await stopProcessTree(pid)
      delete state.commands[id]
      clearEmptyWorkspaceExposure(state)
      await writeWorkspaceState(state)
      await syncExposures(environment.value)
      return synced
    }
  }

  return ok({ record, started: true })
}

export type StartupExit = { code: number | null; signal: string | null; tail: Array<string> }

// A command that dies on launch (missing proxy, bad config, port taken) is still
// "started" when spawn returns. Watch fresh starts briefly and report those that already exited.
export async function startupExits(starts: Array<StartResult>, graceMs = STARTUP_GRACE_MS): Promise<Map<number, StartupExit>> {
  const deadline = Date.now() + graceMs
  const pending = new Map(starts.filter((start) => start.started).map((start) => [start.record.pid, start.record]))
  const exited: Array<CommandRecord> = []

  while (pending.size > 0) {
    for (const [pid, record] of pending) {
      if (isPidRunning(pid)) continue
      pending.delete(pid)
      exited.push(record)
    }
    if (pending.size === 0 || Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())))
  }

  return new Map(await Promise.all(exited.map(async (record) => [record.pid, await startupExit(record)] as const)))
}

async function startupExit(record: CommandRecord): Promise<StartupExit> {
  // workd writes the exit marker from its exit handler, which can trail the process by a moment.
  for (let waited = 0; ; waited += 50) {
    const run = await startupRun(record)
    if (run.code !== null || run.signal !== null || waited >= 500) return run
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function startupRun(record: CommandRecord): Promise<StartupExit> {
  const decoder = new StringDecoder("utf8")
  let pending = ""
  let tail: Array<string> = []
  // Assigned inside the callback, which TypeScript's narrowing does not follow.
  let exit = null as ReturnType<typeof parseExitMarker>
  const keep = (line: string) => {
    if (line.trim() && !isMarkerLine(line)) tail = [...tail, line].slice(-STARTUP_TAIL_LINES)
  }

  await forEachLogChunk(record.log, record.logOffset ?? 0, (chunk) => {
    const lines = (pending + decoder.write(chunk)).split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) {
      const marker = parseExitMarker(line)
      if (marker?.pid === record.pid) {
        exit = marker
        return true
      }
      keep(line)
    }
    return false
  })

  if (!exit) keep(pending)
  return { code: exit?.code ?? null, signal: exit?.signal ?? null, tail }
}

function stateRouteUrls(state: WorkspaceState) {
  if (state.urls) return state.urls

  return Object.fromEntries(
    Object.entries(state.commands)
      .map(([id, command]) => [id, command.url])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
}

type WorkspaceSerializer = <T>(project: string, workspace: string, task: () => Promise<T>) => Promise<T>

export async function pruneDeadCommands(
  environment: NodeJS.ProcessEnv = process.env,
  serializeWorkspace: WorkspaceSerializer = (_project, _workspace, task) => task(),
  isSupervised: (project: string, workspace: string, id: string) => boolean = () => false,
  { keepDead = false }: { keepDead?: boolean } = {},
): Promise<Result<number>> {
  const states = await listWorkspaceStates()
  let pruned = 0
  let changed = false

  for (const listedState of states) {
    const result = await serializeWorkspace(listedState.project, listedState.workspace, async () => {
      const current = await readWorkspaceState(listedState.project, listedState.workspace)
      if (!current.ok || !current.value) return current.ok ? ok({ removed: 0, marked: 0 }) : current
      // Dead records stay for ps and logs until the next start, down, or prune, unless their worktree is gone.
      const keep = keepDead && await existsAt(current.value.root)
      let removed = 0
      let marked = 0

      for (const [id, command] of Object.entries(current.value.commands)) {
        if (isSupervised(listedState.project, listedState.workspace, id)) continue
        if (await commandIsUp(command)) continue
        if (keep && command.exitedAt) continue
        const exit = exits.get(command.pid)
        const stopped = await stopTrackedProcess(command)
        if (!stopped.ok) return stopped
        if (keep) {
          markExited(command, exit)
          marked++
        } else {
          delete current.value.commands[id]
          removed++
        }
      }

      if (removed + marked === 0) return ok({ removed, marked })
      clearEmptyWorkspaceExposure(current.value)
      const write = await writeWorkspaceState(current.value)
      return write.ok ? ok({ removed, marked }) : write
    })
    if (!result.ok) return result
    pruned += result.value.removed
    if (result.value.removed + result.value.marked > 0) changed = true
  }

  if (changed) {
    const synced = await syncExposures(environment)
    if (!synced.ok) return synced
  }

  return ok(pruned)
}

function markExited(command: CommandRecord, exit: CommandExit | undefined) {
  command.exitedAt = exit?.at ?? new Date().toISOString()
  if (typeof exit?.code === "number") command.exitCode = exit.code
  if (exit?.signal) command.exitSignal = exit.signal
}

function clearEmptyWorkspaceExposure(state: WorkspaceState) {
  if (Object.keys(state.commands).length > 0) return
  delete state.exposure
  delete state.urls
}

export async function commandRuntimeStatus(command: CommandRecord): Promise<"up" | "dead"> {
  if (command.exitedAt) return "dead"
  return await isTrackedPidRunning(command.pid, command.startedAt) ? "up" : "dead"
}

export function commandTtlExpired(command: CommandRecord): boolean {
  return Boolean(command.maxTtlSeconds &&
    (Date.now() - Date.parse(command.ttlStartedAt ?? command.startedAt)) / 1000 >= command.maxTtlSeconds)
}

async function commandIsUp(command: CommandRecord) {
  return await commandRuntimeStatus(command) === "up"
}

async function stopTrackedProcess(command: CommandRecord): Promise<Result<void>> {
  if (await commandRuntimeStatus(command) === "up" ||
    (!isPidRunning(command.pid) && processGroupIsRunning(command.pid))) {
    await stopProcessTree(command.pid)
  }
  exits.delete(command.pid)

  return ok(undefined)
}

async function spawnWithLog(
  executable: string,
  args: Array<string>,
  options: {
    cwd: string
    shell: boolean
    output: number
    env: NodeJS.ProcessEnv
  },
): Promise<Result<import("node:child_process").ChildProcess>> {
  return new Promise((resolve) => {
    try {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        shell: options.shell,
        detached: true,
        stdio: ["ignore", options.output, options.output],
        env: options.env,
      })

      let settled = false

      child.once("spawn", () => {
        if (settled) return
        settled = true
        fs.closeSync(options.output)
        resolve(ok(child))
      })

      child.once("error", (cause) => {
        if (settled) return
        settled = true
        try { fs.closeSync(options.output) } catch {}
        resolve(err(appError("ProcessError", `failed to spawn ${executable}`, cause)))
      })
    } catch (cause) {
      try { fs.closeSync(options.output) } catch {}
      resolve(err(appError("ProcessError", `failed to spawn ${executable}`, cause)))
    }
  })
}

async function stopProcessTree(pid: number) {
  if (!sendSignal(pid, "SIGTERM")) {
    return
  }

  for (let waited = 0; waited < 1000; waited += 50) {
    if (!processGroupIsRunning(pid) && !isPidRunning(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  if (processGroupIsRunning(pid) || isPidRunning(pid)) {
    sendSignal(pid, "SIGKILL")
  }
}

function processGroupIsRunning(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (cause) {
    debugLog("processes", `kill -${pid} ${signal} failed: ${describe(cause)}`)
    try {
      process.kill(pid, signal)
      return true
    } catch (innerCause) {
      debugLog("processes", `kill ${pid} ${signal} failed: ${describe(innerCause)}`)
      return false
    }
  }
}
