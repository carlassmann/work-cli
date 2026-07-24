import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { appError, debugLog, describe, err, errResult, ok, tryAsync, trySync } from "./result.js"
import { commandLogFile, listWorkspaceStates, readWorkspaceState, writeWorkspaceState } from "./state.js"
import { routeName, routeUrl } from "./names.js"
import { portlessUrl, routeEnvironment, routeEnvironmentForConfig, spawnCommand } from "./portless.js"
import { isPidRunning } from "./shell.js"
import type { Result } from "./result.js"
import type { CommandRecord, DevConfig, ProcessCommandRecord, WorkspaceRecord, WorkspaceState } from "./types.js"

export async function startCommand(config: DevConfig, workspace: WorkspaceRecord, id: string): Promise<Result<{ record: ProcessCommandRecord; started: boolean }>> {
  const command = config.commands[id]

  if (!command) {
    return errResult("ProcessError", `unknown command: ${id}`)
  }

  const cwd = path.resolve(workspace.root, command.cwd ?? ".")
  const log = commandLogFile(config.project, workspace.workspace, id)

  const stateResult = await readWorkspaceState(config.project, workspace.workspace)
  if (!stateResult.ok) return stateResult
  const state = stateResult.value
  const existing = state?.commands[id]

  if (existing?.runner === "process" && isPidRunning(existing.pid)) {
    return ok({ record: existing, started: false })
  }

  const mkdir = await tryAsync("IOError", "failed to create log directory", async () =>
    await fsp.mkdir(path.dirname(log), { recursive: true }),
  )
  if (!mkdir.ok) return mkdir

  const openLog = trySync("IOError", `failed to open log file ${log}`, () => fs.openSync(log, "a"))
  if (!openLog.ok) return openLog

  const commandProcess = spawnCommand(config, workspace.workspace, id, command)
  const spawned = await spawnWithLog(commandProcess.executable, commandProcess.args, {
    cwd,
    shell: commandProcess.shell,
    output: openLog.value,
    env: {
      ...process.env,
      WORK_PROJECT: config.project,
      WORK_WORKSPACE: workspace.workspace,
      WORK_COMMAND: id,
      ...routeEnvironmentForConfig(config, workspace.workspace),
      ...command.env,
    },
  })

  if (!spawned.ok) return spawned
  spawned.value.unref()

  if (!spawned.value.pid) {
    return errResult("ProcessError", `spawn produced no pid for ${id}`)
  }

  const record: ProcessCommandRecord = {
    id,
    label: command.label ?? id,
    runner: "process",
    pid: spawned.value.pid,
    command: commandProcess.display,
    cwd,
    log,
    url: portlessUrl(config, workspace.workspace, id, command),
    startedAt: new Date().toISOString(),
  }

  const nextState: WorkspaceState = state ?? freshState(workspace)
  nextState.root = workspace.root
  nextState.branch = workspace.branch
  nextState.commands[id] = record

  const write = await writeWorkspaceState(nextState)
  if (!write.ok) {
    await stopProcessTree(spawned.value.pid)
    return write
  }

  return ok({ record, started: true })
}

function freshState(workspace: WorkspaceRecord): WorkspaceState {
  return {
    project: workspace.project,
    workspace: workspace.workspace,
    branch: workspace.branch,
    root: workspace.root,
    commands: {},
  }
}

export async function stopCommand(project: string, workspace: string, id: string): Promise<Result<boolean>> {
  const stateResult = await readWorkspaceState(project, workspace)
  if (!stateResult.ok) return stateResult
  const state = stateResult.value
  const command = state?.commands[id]

  if (!state || !command) {
    return ok(false)
  }

  if (isPidRunning(command.pid)) {
    await stopProcessTree(command.pid)
  }

  delete state.commands[id]
  const write = await writeWorkspaceState(state)
  if (!write.ok) return write

  return ok(true)
}

export async function restartTrackedCommand(project: string, workspace: string, id: string): Promise<Result<{ record: CommandRecord; started: boolean }>> {
  const stateResult = await readWorkspaceState(project, workspace)
  if (!stateResult.ok) return stateResult

  const state = stateResult.value
  const command = state?.commands[id]

  if (!state || !command) {
    return errResult("ProcessError", `no tracked command: ${workspace}/${id}`)
  }

  if (isPidRunning(command.pid)) {
    await stopProcessTree(command.pid)
  }

  const mkdir = await tryAsync("IOError", "failed to create log directory", async () =>
    await fsp.mkdir(path.dirname(command.log), { recursive: true }),
  )
  if (!mkdir.ok) return mkdir

  const openLog = trySync("IOError", `failed to open log file ${command.log}`, () => fs.openSync(command.log, "a"))
  if (!openLog.ok) return openLog

  const commandProcess = trackedProcessCommand(state, command)
  const spawned = await spawnWithLog(commandProcess.executable, commandProcess.args, {
    cwd: command.cwd,
    shell: commandProcess.shell,
    output: openLog.value,
    env: {
      ...process.env,
      WORK_PROJECT: project,
      WORK_WORKSPACE: workspace,
      WORK_COMMAND: id,
      ...routeEnvironment(stateRouteUrls(state)),
    },
  })
  if (!spawned.ok) return spawned
  spawned.value.unref()

  if (!spawned.value.pid) {
    return errResult("ProcessError", `spawn produced no pid for ${id}`)
  }

  const record: ProcessCommandRecord = {
    ...command,
    pid: spawned.value.pid,
    command: commandProcess.display,
    url: commandProcess.url,
    startedAt: new Date().toISOString(),
  }

  state.commands[id] = record
  const write = await writeWorkspaceState(state)
  if (!write.ok) {
    await stopProcessTree(spawned.value.pid)
    return write
  }

  return ok({ record, started: true })
}

function stateRouteUrls(state: WorkspaceState) {
  return Object.fromEntries(
    Object.entries(state.commands)
      .map(([id, command]) => [id, command.url])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
}

function trackedProcessCommand(state: WorkspaceState, command: ProcessCommandRecord) {
  const routed = parsePortlessCommand(command.command)

  if (!routed) {
    return {
      executable: command.command,
      args: [],
      shell: true,
      display: command.command,
      url: command.url,
    }
  }

  const route = routeName(state.project, state.workspace, command.id, routePrefix(state, command, routed.route))
  const run = routed.run

  return {
    executable: "portless",
    args: [route, "sh", "-lc", run],
    shell: false,
    display: `portless ${route} sh -lc ${JSON.stringify(run)}`,
    url: routeUrl(state.project, state.workspace, command.id, routePrefix(state, command, routed.route)),
  }
}

function parsePortlessCommand(command: string): { route: string; run: string } | null {
  const match = command.match(/^portless\s+(\S+)\s+sh\s+-lc\s+(.+)$/)
  if (!match) return null

  try {
    return { route: match[1], run: JSON.parse(match[2]) as string }
  } catch {
    return null
  }
}

function routePrefix(state: WorkspaceState, command: ProcessCommandRecord, route: string) {
  if (route.includes(".")) return route.split(".")[0]

  const suffix = `-${state.workspace}-${state.project}`
  if (route.endsWith(suffix)) return route.slice(0, -suffix.length)

  return command.id
}

export async function pruneDeadCommands(): Promise<Result<number>> {
  const states = await listWorkspaceStates()
  let pruned = 0

  for (const state of states) {
    let changed = false

    for (const [id, command] of Object.entries(state.commands)) {
      if (!await commandIsUp(command)) {
        delete state.commands[id]
        changed = true
        pruned++
      }
    }

    if (changed) {
      const write = await writeWorkspaceState(state)
      if (!write.ok) return write
    }
  }

  return ok(pruned)
}

export async function commandRuntimeStatus(command: CommandRecord): Promise<"up" | "dead"> {
  return isPidRunning(command.pid) ? "up" : "dead"
}

async function commandIsUp(command: CommandRecord) {
  return await commandRuntimeStatus(command) === "up"
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
    if (!isPidRunning(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  if (isPidRunning(pid)) {
    sendSignal(pid, "SIGKILL")
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

