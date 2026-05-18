import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { appError, debugLog, describe, err, errResult, ok } from "./result.js"
import { isPidRunning } from "./shell.js"
import { daemonPidFile, daemonSocketFile, stateRoot } from "./state.js"
import type { Result } from "./result.js"
import type { DaemonCommand, DaemonResponse, DaemonResultType } from "./types.js"
import { DAEMON_PROTOCOL_VERSION } from "./types.js"

const DAEMON_START_TIMEOUT_MS = 3000
const SEND_TIMEOUT_MS = 5000
const PING_INTERVAL_MS = 50

export type DaemonStatus = { running: boolean; pid: number | null }

export async function daemonStatus(): Promise<DaemonStatus> {
  const pid = await readDaemonPid()

  if (pid && isPidRunning(pid)) {
    const ping = await sendDaemon({ type: "ping" })
    if (ping.ok) {
      return { running: true, pid }
    }
  }

  // Pidfile may be missing or stale; the daemon may still be reachable.
  const probe = await sendDaemon({ type: "ping" })
  if (probe.ok) {
    return { running: true, pid: probe.value.data.pid }
  }

  return { running: false, pid }
}

export async function ensureDaemon(): Promise<Result<number>> {
  const status = await daemonStatus()

  if (status.running && status.pid !== null) {
    return ok(status.pid)
  }

  await killStaleDaemon(status.pid)

  const ensureDir = await safeMkdir(stateRoot())
  if (!ensureDir.ok) return ensureDir

  const entrypoint = await daemonEntrypoint()

  let stderrBuffer = ""
  const child = spawn(entrypoint.command, entrypoint.args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  })

  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    stderrBuffer += chunk
    if (stderrBuffer.length > 4096) {
      stderrBuffer = stderrBuffer.slice(-4096)
    }
  })

  type ExitInfo = { code: number | null; signal: NodeJS.Signals | null }
  const exitState: { value: ExitInfo | null } = { value: null }
  child.on("exit", (code, signal) => {
    exitState.value = { code, signal }
  })

  child.unref()

  const ready = await waitForDaemon(() => exitState.value)

  // Release stderr so the parent event loop can exit. The daemon is detached;
  // we no longer need its output.
  child.stderr?.removeAllListeners("data")
  child.stderr?.destroy()

  if (!ready.ok) {
    if (exitState.value) {
      const detail = stderrBuffer.trim() || `signal=${exitState.value.signal} code=${exitState.value.code}`
      return errResult("DaemonError", `workd crashed during startup: ${detail}`)
    }

    return ready
  }

  const final = await daemonStatus()

  if (final.pid === null) {
    return errResult("DaemonError", "workd started but no pid file was written")
  }

  return ok(final.pid)
}

export async function stopDaemon(): Promise<Result<void>> {
  const status = await daemonStatus()

  if (!status.running) {
    await killStaleDaemon(status.pid)
    await cleanupDaemonFiles()
    return ok(undefined)
  }

  const response = await sendDaemon({ type: "shutdown" })

  if (!response.ok) {
    debugLog("daemon", `shutdown send failed: ${response.error.message}`)
  }

  const stopped = await waitForDaemonStop(status.pid, 1000)

  if (!stopped) {
    return errResult("DaemonError", `workd pid=${status.pid} did not stop within 1000ms`)
  }

  await cleanupDaemonFiles()
  return ok(undefined)
}

async function waitForDaemonStop(pid: number | null, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (pid === null || !isPidRunning(pid)) {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return false
}

export async function sendDaemon<T extends DaemonCommand>(
  command: T,
): Promise<Result<{ message?: string; data: DaemonResultType<T["type"]> }>> {
  const response = await sendRaw<T>(command)

  if (!response.ok) return response

  const payload = response.value

  if (!payload.ok) {
    return errResult(payload.tag ?? "DaemonError", payload.error)
  }

  const { data, message } = payload
  return ok(message !== undefined ? { data, message } : { data })
}

async function cleanupDaemonFiles() {
  await fs.rm(daemonSocketFile(), { force: true }).catch((cause) => debugLog("daemon", `rm socket: ${describe(cause)}`))
  await fs.rm(daemonPidFile(), { force: true }).catch((cause) => debugLog("daemon", `rm pid: ${describe(cause)}`))
}

async function killStaleDaemon(pid: number | null) {
  if (pid === null || !isPidRunning(pid)) return

  try {
    process.kill(pid, "SIGKILL")
  } catch (cause) {
    debugLog("daemon", `kill stale pid=${pid}: ${describe(cause)}`)
  }
}

async function waitForDaemon(exited: () => { code: number | null; signal: NodeJS.Signals | null } | null): Promise<Result<void>> {
  const startedAt = Date.now()
  let lastError = "ping never returned"

  while (Date.now() - startedAt < DAEMON_START_TIMEOUT_MS) {
    if (exited()) {
      return errResult("DaemonError", "workd exited before responding to ping")
    }

    const ping = await sendDaemon({ type: "ping" })

    if (ping.ok) {
      return ok(undefined)
    }

    lastError = ping.error.message
    await new Promise((resolve) => setTimeout(resolve, PING_INTERVAL_MS))
  }

  return errResult("DaemonError", `workd did not respond within ${DAEMON_START_TIMEOUT_MS}ms: ${lastError}`)
}

async function sendRaw<T extends DaemonCommand>(command: T): Promise<Result<DaemonResponse<T["type"]>>> {
  return new Promise((resolve) => {
    const socket = net.createConnection(daemonSocketFile())
    let data = ""
    let settled = false

    const settle = (result: Result<DaemonResponse<T["type"]>>) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setEncoding("utf8")
    socket.setTimeout(SEND_TIMEOUT_MS)
    socket.on("timeout", () => {
      settle(errResult("DaemonError", `daemon did not respond within ${SEND_TIMEOUT_MS}ms`))
    })
    socket.on("connect", () => socket.write(`${JSON.stringify({ ...command, version: DAEMON_PROTOCOL_VERSION })}\n`))
    socket.on("data", (chunk) => {
      data += chunk

      if (data.includes("\n")) {
        settle(parseResponse(data))
      }
    })
    socket.on("error", (cause) => {
      settle(err(appError("DaemonError", `daemon socket error`, cause)))
    })
    socket.on("end", () => {
      if (data) {
        settle(parseResponse(data))
        return
      }

      settle(errResult("DaemonError", "daemon closed the connection without responding"))
    })
  })
}

function parseResponse<T extends DaemonCommand>(data: string): Result<DaemonResponse<T["type"]>> {
  try {
    return ok(JSON.parse(data) as DaemonResponse<T["type"]>)
  } catch (cause) {
    return err(appError("DaemonError", "daemon returned invalid JSON", cause))
  }
}

async function safeMkdir(dir: string): Promise<Result<void>> {
  try {
    await fs.mkdir(dir, { recursive: true })
    return ok(undefined)
  } catch (cause) {
    return err(appError("IOError", `failed to create ${dir}`, cause))
  }
}

async function readDaemonPid() {
  try {
    const text = await fs.readFile(daemonPidFile(), "utf8")
    const pid = Number(text.trim())
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch (cause) {
    debugLog("daemon", `read pid: ${describe(cause)}`)
    return null
  }
}

async function daemonEntrypoint() {
  const override = process.env["WORK_DAEMON_ENTRYPOINT"]

  if (override) {
    return { command: "sh", args: ["-c", override] }
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  const builtEntrypoint = path.join(currentDir, "workd.js")

  try {
    await fs.access(builtEntrypoint)
    return { command: process.execPath, args: [builtEntrypoint] }
  } catch {
    return {
      command: "bun",
      args: [path.resolve(currentDir, "../src/workd.ts")],
    }
  }
}
