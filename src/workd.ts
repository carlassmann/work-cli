#!/usr/bin/env node
import fs from "node:fs/promises"
import net from "node:net"
import { debugLog, describe, formatError } from "./result.js"
import { pruneDeadCommands, restartTrackedCommand, startCommand, stopCommand } from "./processes.js"
import { daemonPidFile, daemonSocketFile, listWorkspaceStates, readWorkspaceState, stateRoot } from "./state.js"
import type { Result } from "./result.js"
import type { DaemonCommand, DaemonResponse, DaemonResultType, DevConfig, WorkspaceRecord } from "./types.js"
import { DAEMON_PROTOCOL_VERSION } from "./types.js"

const KNOWN_COMMAND_TYPES: ReadonlySet<string> = new Set(
  ["run", "down", "stop", "restart", "restartTracked", "prune", "ping", "shutdown"] satisfies Array<DaemonCommand["type"]>,
)

type DesiredCommand = {
  config: DevConfig
  workspace: WorkspaceRecord
  command: string
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

await fs.mkdir(stateRoot(), { recursive: true })
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
      void respond(socket, data)
    }
  })
  socket.on("error", () => undefined)
})

server.listen(daemonSocketFile())

setInterval(() => {
  void reconcile()
}, 1000).unref()

process.on("SIGTERM", () => shutdown())
process.on("SIGINT", () => shutdown())

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
        startDesired(command.config, command.workspace, command.command),
      )

    case "down":
      return serialize(workspaceLock(command.project, command.workspace), async () => {
        const stateResult = await readWorkspaceState(command.project, command.workspace)
        if (!stateResult.ok) return stateResult
        const ids = Object.keys(stateResult.value?.commands ?? {})

        const stopped: Array<string> = []
        const errors: Array<string> = []

        for (const id of ids) {
          desired.delete(key(command.project, command.workspace, id))
          const r = await stopCommand(command.project, command.workspace, id)

          if (!r.ok) {
            errors.push(`${id}: ${r.error.message}`)
            continue
          }

          if (r.value) {
            stopped.push(id)
          }
        }

        if (errors.length > 0) {
          return { ok: false, error: { tag: "ProcessError", message: `partial down: stopped [${stopped.join(", ")}]; failed [${errors.join("; ")}]` } }
        }

        return { ok: true, value: stopped }
      })

    case "stop":
      return serialize(workspaceLock(command.project, command.workspace), async () => {
        desired.delete(key(command.project, command.workspace, command.command))
        const r = await stopCommand(command.project, command.workspace, command.command)
        if (!r.ok) return r
        return { ok: true, value: r.value }
      })

    case "restart":
      return serialize(workspaceLock(command.config.project, command.workspace.workspace), async () => {
        const stop = await stopCommand(command.config.project, command.workspace.workspace, command.command)
        if (!stop.ok) return stop
        return startDesired(command.config, command.workspace, command.command)
      })

    case "restartTracked":
      return serialize(workspaceLock(command.project, command.workspace), async () => {
        desired.delete(key(command.project, command.workspace, command.command))
        return restartTrackedCommand(command.project, command.workspace, command.command)
      })

    case "prune":
      return pruneDeadCommands()

    case "shutdown":
      setTimeout(() => shutdown(), 10)
      return { ok: true, value: { stopping: true as const } }
  }
}

async function startDesired(config: DevConfig, workspace: WorkspaceRecord, command: string) {
  const result = await startCommand(config, workspace, command)
  const commandConfig = config.commands[command]

  if (result.ok && commandConfig?.restart === "on-exit") {
    desired.set(key(config.project, workspace.workspace, command), { config, workspace, command })
  }

  return result
}

let reconcileFailureCount = 0

async function reconcile() {
  for (const target of desired.values()) {
    const result = await startCommand(target.config, target.workspace, target.command)

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
      const result = await stopCommand(state.project, state.workspace, id)
      if (!result.ok) {
        debugLog("workd", `shutdown stop ${state.project}/${state.workspace}/${id}: ${result.error.message}`)
      }
    }
  }

  await fs.rm(daemonSocketFile(), { force: true }).catch((cause) => debugLog("workd", `rm socket: ${describe(cause)}`))
  await fs.rm(daemonPidFile(), { force: true }).catch((cause) => debugLog("workd", `rm pid: ${describe(cause)}`))
  process.exit(0)
}
