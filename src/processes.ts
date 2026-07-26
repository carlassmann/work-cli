import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { appError, debugLog, describe, err, errResult, ok, tryAsync, trySync } from "./result.js"
import { commandLogFile, listWorkspaceStates, readWorkspaceState, writeWorkspaceState } from "./state.js"
import { commandProcess, commandRoute, portlessUrl, routeEnvironment, routeEnvironmentForConfig } from "./portless.js"
import { isPidRunning } from "./shell.js"
import type { Result } from "./result.js"
import type { CommandRecord, DevConfig, WorkspaceRecord, WorkspaceState } from "./types.js"

export async function startCommand(config: DevConfig, workspace: WorkspaceRecord, id: string): Promise<Result<{ record: CommandRecord; started: boolean }>> {
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

  if (existing && isPidRunning(existing.pid)) {
    return ok({ record: existing, started: false })
  }

  const route = commandRoute(config, workspace.workspace, id, command)
  const commandExec = commandProcess(command.run, route)
  const pid = await spawnLogged(id, commandExec, {
    cwd,
    log,
    env: {
      ...process.env,
      WORK_PROJECT: config.project,
      WORK_WORKSPACE: workspace.workspace,
      WORK_COMMAND: id,
      ...routeEnvironmentForConfig(config, workspace.workspace),
      ...command.env,
    },
  })
  if (!pid.ok) return pid

  const record: CommandRecord = {
    id,
    label: command.label ?? id,
    pid: pid.value,
    command: commandExec.display,
    run: command.run,
    route,
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
    await stopProcessTree(pid.value)
    return write
  }

  return ok({ record, started: true })
}

async function spawnLogged(
  id: string,
  commandExec: ReturnType<typeof commandProcess>,
  options: { cwd: string; log: string; env: NodeJS.ProcessEnv },
): Promise<Result<number>> {
  const mkdir = await tryAsync("IOError", "failed to create log directory", async () =>
    await fsp.mkdir(path.dirname(options.log), { recursive: true }),
  )
  if (!mkdir.ok) return mkdir

  const openLog = trySync("IOError", `failed to open log file ${options.log}`, () => fs.openSync(options.log, "a"))
  if (!openLog.ok) return openLog

  const spawned = await spawnWithLog(commandExec.executable, commandExec.args, {
    cwd: options.cwd,
    shell: commandExec.shell,
    output: openLog.value,
    env: options.env,
  })
  if (!spawned.ok) return spawned
  spawned.value.unref()

  if (!spawned.value.pid) {
    return errResult("ProcessError", `spawn produced no pid for ${id}`)
  }

  return ok(spawned.value.pid)
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

  if (typeof command.run !== "string") {
    return errResult("ProcessError", `tracked record for ${workspace}/${id} predates this work version. Run: work stop ${id} && work run ${id}`)
  }

  if (isPidRunning(command.pid)) {
    await stopProcessTree(command.pid)
  }

  const commandExec = commandProcess(command.run, command.route)
  const pid = await spawnLogged(id, commandExec, {
    cwd: command.cwd,
    log: command.log,
    env: {
      ...process.env,
      WORK_PROJECT: project,
      WORK_WORKSPACE: workspace,
      WORK_COMMAND: id,
      ...routeEnvironment(stateRouteUrls(state)),
    },
  })
  if (!pid.ok) return pid

  const record: CommandRecord = {
    ...command,
    pid: pid.value,
    command: commandExec.display,
    startedAt: new Date().toISOString(),
  }

  state.commands[id] = record
  const write = await writeWorkspaceState(state)
  if (!write.ok) {
    await stopProcessTree(pid.value)
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

