#!/usr/bin/env node
import fs from "node:fs/promises"
import net from "node:net"
import { syncCloudflareTunnel } from "./cloudflare.js"
import { debugLog, describe, formatError } from "./result.js"
import { pruneDeadCommands, restartTrackedCommand, startCommand, stopCommand } from "./processes.js"
import { processCommand } from "./shell.js"
import { daemonLockFile, daemonPidFile, daemonSocketFile, listWorkspaceStates, readWorkspaceState, stateRoot } from "./state.js"
import type { Result } from "./result.js"
import type { DaemonCommand, DaemonResponse, DaemonResultType, DevConfig, Exposure, WorkspaceRecord } from "./types.js"
import { DAEMON_PROTOCOL_VERSION } from "./types.js"

const KNOWN_COMMAND_TYPES: ReadonlySet<string> = new Set(
  ["run", "down", "stop", "restart", "restartTracked", "prune", "ping", "shutdown"] satisfies Array<DaemonCommand["type"]>,
)

type DesiredCommand = {
  config: DevConfig
  workspace: WorkspaceRecord
  command: string
  exposure: Exposure
  environment: Record<string, string>
}

const desired = new Map<string, DesiredCommand>()
const inflight = new Map<string, Promise<unknown>>()

async function serialize<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = inflight.get(lockKey) ?? Promise.resolve()
  const next = previous.then(() => fn(), () => fn())
  inflight.set(lockKey, next as Promise<unknown>)

  try {
    return await next
  } finally {
    if (inflight.get(lockKey) === (next as Promise<unknown>)) {
      inflight.delete(lockKey)
    }
  }
}

function workspaceLock(project: string, workspace: string) {
  return `${project}/${workspace}`
}

await fs.mkdir(stateRoot(), { recursive: true, mode: 0o700 })
await fs.chmod(stateRoot(), 0o700)
const acquiredDaemonLock = await acquireDaemonLock()
if (!acquiredDaemonLock) process.exit(0)
const daemonLock = acquiredDaemonLock as import("node:fs/promises").FileHandle
await fs.rm(daemonSocketFile(), { force: true })
await fs.writeFile(daemonPidFile(), `${process.pid}\n`)

const server = net.createServer((socket) => {
  let data = ""
  let handled = false

  socket.setEncoding("utf8")
  socket.on("data", (chunk) => {
    data += chunk

    if (!handled && data.includes("\n")) {
      handled = true
      void respond(socket, data).catch((cause) => {
        socket.end(`${JSON.stringify({ ok: false, tag: "DaemonError", error: describe(cause) })}\n`)
      })
    }
  })
  socket.on("error", () => undefined)
})

server.listen(daemonSocketFile())

setInterval(() => {
  void maintain().catch((cause) => debugLog("workd", `maintenance failed: ${describe(cause)}`))
}, 1000).unref()

process.on("SIGTERM", () => void shutdown().catch((cause) => debugLog("workd", `shutdown failed: ${describe(cause)}`)))
process.on("SIGINT", () => void shutdown().catch((cause) => debugLog("workd", `shutdown failed: ${describe(cause)}`)))

async function respond(socket: net.Socket, payload: string) {
  const response = await handlePayload(payload)
  socket.end(`${JSON.stringify(response)}\n`)
}

async function handlePayload(payload: string): Promise<DaemonResponse> {
  let parsed: unknown

  try {
    parsed = JSON.parse(payload)
  } catch (cause) {
    return { ok: false, error: `invalid daemon payload: ${describe(cause)}`, tag: "DaemonError" }
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "daemon payload must be a JSON object", tag: "DaemonError" }
  }

  const envelope = parsed as Record<string, unknown>

  if (envelope["version"] !== DAEMON_PROTOCOL_VERSION) {
    return {
      ok: false,
      tag: "DaemonError",
      error: `daemon protocol version mismatch: client=${envelope["version"]}, server=${DAEMON_PROTOCOL_VERSION}. Restart workd or upgrade the CLI.`,
    }
  }

  if (typeof envelope["type"] !== "string" || !KNOWN_COMMAND_TYPES.has(envelope["type"])) {
    return { ok: false, error: `unknown daemon command type: ${envelope["type"]}`, tag: "DaemonError" }
  }

  const command = parsed as DaemonCommand
  const result = await handleCommand(command)

  if (!result.ok) {
    return { ok: false, error: formatError(result.error), tag: result.error.tag }
  }

  return { ok: true, data: result.value as DaemonResultType<typeof command.type> }
}

async function handleCommand(command: DaemonCommand): Promise<Result<unknown>> {
  switch (command.type) {
    case "ping":
      return { ok: true, value: { pid: process.pid } }

    case "run":
      return serialize(workspaceLock(command.config.project, command.workspace.workspace), () =>
        startDesired(command.config, command.workspace, command.command, command.exposure, command.environment),
      )

    case "down":
      return serialize(workspaceLock(command.project, command.workspace), async () => {
        const desiredPrefix = `${command.project}/${command.workspace}/`
        for (const targetKey of desired.keys()) {
          if (targetKey.startsWith(desiredPrefix)) desired.delete(targetKey)
        }
        const stateResult = await readWorkspaceState(command.project, command.workspace)
        if (!stateResult.ok) return stateResult
        const ids = Object.keys(stateResult.value?.commands ?? {})

        const stopped: Array<string> = []
        const errors: Array<string> = []

        for (const id of ids) {
          desired.delete(key(command.project, command.workspace, id))
          const r = await stopCommand(command.project, command.workspace, id, { syncCloudflare: false, environment: command.environment })

          if (!r.ok) {
            errors.push(`${id}: ${r.error.message}`)
            continue
          }

          if (r.value) {
            stopped.push(id)
          }
        }

        const synced = await syncCloudflareTunnel(command.environment)
        if (!synced.ok) return synced

        if (errors.length > 0) {
          return { ok: false, error: { tag: "ProcessError", message: `partial down: stopped [${stopped.join(", ")}]; failed [${errors.join("; ")}]` } }
        }

        return { ok: true, value: stopped }
      })

    case "stop":
      return serialize(workspaceLock(command.project, command.workspace), async () => {
        desired.delete(key(command.project, command.workspace, command.command))
        const r = await stopCommand(command.project, command.workspace, command.command, { environment: command.environment })
        if (!r.ok) return r
        return { ok: true, value: r.value }
      })

    case "restart":
      return serialize(workspaceLock(command.config.project, command.workspace.workspace), async () => {
        const state = await readWorkspaceState(command.config.project, command.workspace.workspace)
        if (!state.ok) return state
        const existing = state.value?.commands[command.command]
        if (existing && (existing.exposure?.mode ?? "local") !== command.exposure.mode) {
          return { ok: false, error: { tag: "ProcessError", message: `command ${command.command} is tracked in ${existing.exposure?.mode ?? "local"} mode. Run work down ${command.workspace.workspace} before switching.` } } as const
        }
        const stop = await stopCommand(command.config.project, command.workspace.workspace, command.command, { syncCloudflare: false, environment: command.environment })
        if (!stop.ok) return stop
        return startDesired(command.config, command.workspace, command.command, command.exposure, command.environment)
      })

    case "restartTracked":
      return serialize(workspaceLock(command.project, command.workspace), async () => {
        const targetKey = key(command.project, command.workspace, command.command)
        const existing = desired.get(targetKey)
        const result = await restartTrackedCommand(command.project, command.workspace, command.command, command.environment)
        if (result.ok && existing) desired.set(targetKey, { ...existing, environment: command.environment })
        return result
      })

    case "prune":
      return pruneDeadCommands(command.environment, (project, workspace, task) =>
        serialize(workspaceLock(project, workspace), task),
      )

    case "shutdown":
      setTimeout(() => void shutdown().catch((cause) => debugLog("workd", `shutdown failed: ${describe(cause)}`)), 10)
      return { ok: true, value: { stopping: true as const } }
  }
}

async function startDesired(
  config: DevConfig,
  workspace: WorkspaceRecord,
  command: string,
  exposure: Exposure,
  environment: Record<string, string>,
) {
  const result = await startCommand(config, workspace, command, exposure, environment)
  const commandConfig = config.commands[command]

  if (result.ok && commandConfig?.restart === "on-exit") {
    desired.set(key(config.project, workspace.workspace, command), { config, workspace, command, exposure, environment })
  }

  return result
}

let reconcileFailureCount = 0
let maintenanceRunning = false
let maintenanceTicks = 0

async function maintain() {
  if (maintenanceRunning) return
  maintenanceRunning = true
  try {
    await reconcile()
    maintenanceTicks++
    if (maintenanceTicks % 5 === 0) {
      const pruned = await pruneDeadCommands(process.env, (project, workspace, task) =>
        serialize(workspaceLock(project, workspace), task),
      )
      if (!pruned.ok) debugLog("workd", `automatic prune failed: ${pruned.error.message}`)
    }
  } finally {
    maintenanceRunning = false
  }
}

async function reconcile() {
  for (const [targetKey, target] of desired.entries()) {
    const result = await serialize(workspaceLock(target.config.project, target.workspace.workspace), async () => {
      if (!desired.has(targetKey)) return { ok: true, value: { skipped: true } } as const
      return startCommand(target.config, target.workspace, target.command, target.exposure, target.environment)
    })

    if (!result.ok) {
      reconcileFailureCount++
      if (reconcileFailureCount === 1 || reconcileFailureCount % 30 === 0) {
        debugLog("workd", `reconcile ${target.config.project}/${target.workspace.workspace}/${target.command} failed (${reconcileFailureCount}x): ${result.error.message}`)
      }
      continue
    }

    reconcileFailureCount = 0
  }
}

function key(project: string, workspace: string, command: string) {
  return `${project}/${workspace}/${command}`
}

let shuttingDown = false

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true

  server.close()
  desired.clear()

  const states = await listWorkspaceStates()
  for (const state of states) {
    for (const id of Object.keys(state.commands)) {
      const result = await stopCommand(state.project, state.workspace, id, { syncCloudflare: false })
      if (!result.ok) {
        debugLog("workd", `shutdown stop ${state.project}/${state.workspace}/${id}: ${result.error.message}`)
      }
    }
  }

  await syncCloudflareTunnel()

  await fs.rm(daemonSocketFile(), { force: true }).catch((cause) => debugLog("workd", `rm socket: ${describe(cause)}`))
  await fs.rm(daemonPidFile(), { force: true }).catch((cause) => debugLog("workd", `rm pid: ${describe(cause)}`))
  await releaseDaemonLock()
  process.exit(0)
}

async function acquireDaemonLock() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const handle = await fs.open(daemonLockFile(), "wx", 0o600)
      await handle.writeFile(`${process.pid}\n`)
      return handle
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause
      const owner = await readLockOwner()
      if (owner && await isWorkdProcess(owner)) return null
      if (await lockIsFresh()) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        continue
      }
      await fs.rm(daemonLockFile(), { force: true })
    }
  }
  return null
}

async function lockIsFresh() {
  try {
    const stat = await fs.stat(daemonLockFile())
    return Date.now() - stat.mtimeMs < 3000
  } catch {
    return false
  }
}

async function releaseDaemonLock() {
  await daemonLock.close().catch(() => undefined)
  const owner = await readLockOwner()
  if (owner === process.pid) {
    await fs.rm(daemonLockFile(), { force: true }).catch((cause) => debugLog("workd", `rm lock: ${describe(cause)}`))
  }
}

async function readLockOwner() {
  try {
    const pid = Number((await fs.readFile(daemonLockFile(), "utf8")).trim())
    return Number.isInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

async function isWorkdProcess(pid: number) {
  const command = await processCommand(pid)
  return Boolean(command && /(?:^|\/)workd\.(?:js|ts)(?:\s|$)/.test(command))
}

function isAlreadyExists(cause: unknown) {
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "EEXIST")
}
