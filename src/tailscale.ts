import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { childEnvironment } from "./environment.js"
import { dnsLabel } from "./names.js"
import { errResult, ok } from "./result.js"
import { commandExists, isPidRunning, isTrackedPidRunning, processCommand } from "./shell.js"
import { listWorkspaceStates, stateRoot } from "./state.js"
import type { Result } from "./result.js"
import type { CommandRecord, Exposure } from "./types.js"

type TailscaleExposure = Extract<Exposure, { mode: "tailscale" }>

export type TailnetProxyConfig = {
  port: number
  certFile: string
  keyFile: string
  // Port of the Portless proxy that serves the local URLs.
  portlessPort: number
  // Public hostname → local Portless URL of the same command.
  routes: Record<string, string>
}

const exec = promisify(execFile)
const DEFAULT_PORT = 47443
const SERVE_PORT = "443"
const domainPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/

export function tailscaleExposure(environment: NodeJS.ProcessEnv = process.env): Result<Exposure> {
  const domain = environment["WORK_TAILSCALE_DOMAIN"]?.trim().toLowerCase()
  const certFile = environment["WORK_TAILSCALE_CERT"]?.trim()
  const keyFile = environment["WORK_TAILSCALE_KEY"]?.trim()
  const port = Number(environment["WORK_TAILSCALE_PORT"] ?? DEFAULT_PORT)

  if (!domain || !domainPattern.test(domain) || !domain.includes(".") || domain.length > 189) {
    return errResult("ConfigError", "WORK_TAILSCALE_DOMAIN must be a domain whose wildcard record points to this machine's Tailscale IP, for example dev.example.com.")
  }

  if (!certFile || !keyFile) {
    return errResult("ConfigError", `WORK_TAILSCALE_CERT and WORK_TAILSCALE_KEY must point to a certificate and key for *.${domain}.`)
  }

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return errResult("ConfigError", "WORK_TAILSCALE_PORT must be a free local port between 1024 and 65535.")
  }

  return ok({ mode: "tailscale", domain, certFile: resolveHome(certFile), keyFile: resolveHome(keyFile), port })
}

export function tailscaleHostname(route: string, exposure: Exposure) {
  if (exposure.mode !== "tailscale") return null
  return `${dnsLabel(route)}.${exposure.domain}`
}

let pendingSync: Promise<Result<void>> = Promise.resolve(ok(undefined))

export function syncTailnetProxy(environment: NodeJS.ProcessEnv = process.env): Promise<Result<void>> {
  pendingSync = pendingSync.then(() => runSync(environment), () => runSync(environment))
  return pendingSync
}

async function runSync(environment: NodeJS.ProcessEnv): Promise<Result<void>> {
  const records: Array<CommandRecord> = []
  for (const record of (await listWorkspaceStates()).flatMap((state) => Object.values(state.commands))) {
    if (await isActiveTailscaleRecord(record)) records.push(record)
  }

  if (records.length === 0) return stopTailnetProxy(environment)

  const exposures = records.map((record) => record.exposure).filter((exposure): exposure is TailscaleExposure => exposure?.mode === "tailscale")
  const exposure = exposures[0]
  if (!exposure) return errResult("ProcessError", "missing Tailscale exposure configuration")
  if (exposures.some((other) => other.port !== exposure.port || other.certFile !== exposure.certFile || other.keyFile !== exposure.keyFile)) {
    return errResult("ConfigError", "all active Tailscale commands on one machine must use the same WORK_TAILSCALE_PORT, WORK_TAILSCALE_CERT, and WORK_TAILSCALE_KEY.")
  }

  for (const file of [exposure.certFile, exposure.keyFile]) {
    try {
      await fsp.access(file, fs.constants.R_OK)
    } catch {
      return errResult("ConfigError", `Tailscale certificate file not readable: ${file}`)
    }
  }

  if (!await commandExists("tailscale", environment)) {
    return errResult("ProcessError", "the tailscale CLI is required for --tailscale. Install Tailscale and make sure tailscale is on PATH.")
  }

  const config: TailnetProxyConfig = {
    port: exposure.port,
    certFile: exposure.certFile,
    keyFile: exposure.keyFile,
    portlessPort: await portlessPort(environment),
    routes: Object.fromEntries(records.flatMap((record) => {
      const hostname = urlHostname(record.url)
      return hostname && record.localUrl ? [[hostname, record.localUrl]] : []
    })),
  }

  const previous = await readConfig()
  const write = await writeConfig(config)
  if (!write.ok) return write

  let proxy = await proxyRecord(environment)
  if (proxy && previous?.port !== config.port) {
    await stopProxyPid(proxy.pid, environment)
    proxy = null
  }
  if (!proxy) {
    const started = await startProxy(config.port, environment)
    if (!started.ok) return started
  }

  return ensureServe(config.port, environment)
}

// The proxy runs detached from workd, so workd calls this periodically to restart it if it died.
export async function recoverTailnetProxy(environment: NodeJS.ProcessEnv = process.env): Promise<Result<void>> {
  if (!await readConfig() || await proxyRecord(environment)) return ok(undefined)
  return syncTailnetProxy(environment)
}

async function stopTailnetProxy(environment: NodeJS.ProcessEnv = process.env): Promise<Result<void>> {
  const config = await readConfig()
  const proxy = await proxyRecord(environment)
  if (proxy) await stopProxyPid(proxy.pid, environment)
  if (config) {
    const removed = await removeServe(config.port, environment)
    if (!removed.ok) return removed
  }

  try {
    await fsp.rm(pidFile(), { force: true })
    await fsp.rm(configFile(), { force: true })
    return ok(undefined)
  } catch (cause) {
    return errResult("IOError", `failed to clean up ${tailscaleDir()}`, cause)
  }
}

async function isActiveTailscaleRecord(record: CommandRecord) {
  return record.exposure?.mode === "tailscale"
    && Boolean(record.route)
    && Boolean(record.url)
    && Boolean(record.localUrl)
    && await isTrackedPidRunning(record.pid, record.startedAt)
}

// tailscale serve owns port 443 on the tailnet address, so work does not need root
// to listen there. It forwards raw TCP, which keeps TLS and Host routing in the proxy.
async function ensureServe(port: number, environment: NodeJS.ProcessEnv): Promise<Result<void>> {
  const current = await serveTarget(environment)
  if (!current.ok) return current
  const target = `127.0.0.1:${port}`
  if (current.value === target) return ok(undefined)
  if (current.value) {
    return errResult("ConfigError", `tailscale serve already forwards port 443 to ${current.value}. Remove it with: tailscale serve --tcp=443 off`)
  }

  try {
    await exec("tailscale", ["serve", "--bg", `--tcp=${SERVE_PORT}`, `tcp://${target}`], { env: childEnvironment(environment), timeout: 30_000 })
    return ok(undefined)
  } catch (cause) {
    return errResult("ProcessError", `failed to forward tailnet port 443 to ${target}: ${commandError(cause)}`)
  }
}

async function removeServe(port: number, environment: NodeJS.ProcessEnv): Promise<Result<void>> {
  if (!await commandExists("tailscale", environment)) return ok(undefined)
  const current = await serveTarget(environment)
  if (!current.ok || current.value !== `127.0.0.1:${port}`) return ok(undefined)

  try {
    await exec("tailscale", ["serve", `--tcp=${SERVE_PORT}`, "off"], { env: childEnvironment(environment), timeout: 30_000 })
    return ok(undefined)
  } catch (cause) {
    return errResult("ProcessError", `failed to remove the tailnet forward on port 443: ${commandError(cause)}`)
  }
}

async function serveTarget(environment: NodeJS.ProcessEnv): Promise<Result<string | null>> {
  let output: string
  try {
    output = (await exec("tailscale", ["serve", "status", "--json"], { env: childEnvironment(environment), timeout: 30_000 })).stdout
  } catch (cause) {
    return errResult("ProcessError", `failed to read tailscale serve status: ${commandError(cause)}`)
  }
  return ok(parseServeTarget(output))
}

export function parseServeTarget(output: string): string | null {
  let status: unknown
  try {
    status = JSON.parse(output || "{}")
  } catch {
    return null
  }
  if (!status || typeof status !== "object" || !("TCP" in status)) return null
  const handlers = status.TCP as Record<string, { TCPForward?: unknown; HTTPS?: unknown } | undefined>
  const handler = handlers[SERVE_PORT]
  if (!handler) return null
  return typeof handler.TCPForward === "string" ? handler.TCPForward : "another tailscale serve handler"
}

async function startProxy(port: number, environment: NodeJS.ProcessEnv): Promise<Result<void>> {
  try {
    await fsp.mkdir(tailscaleDir(), { recursive: true })
  } catch (cause) {
    return errResult("IOError", `failed to create ${tailscaleDir()}`, cause)
  }

  const log = logFile()
  let output: number
  try {
    output = fs.openSync(log, "a")
  } catch (cause) {
    return errResult("IOError", `failed to open tailnet proxy log ${log}`, cause)
  }

  const startedAt = new Date().toISOString()
  const child = spawn(process.execPath, [proxyScript(), configFile()], {
    detached: true,
    stdio: ["ignore", output, output, "ipc"],
    env: childEnvironment(environment),
  })
  fs.closeSync(output)
  const spawned = await new Promise<Result<number>>((resolve) => {
    child.once("error", (cause) => resolve(errResult("ProcessError", "failed to start the tailnet proxy", cause)))
    child.once("spawn", () => resolve(child.pid ? ok(child.pid) : errResult("ProcessError", "tailnet proxy spawned without a pid")))
  })
  if (!spawned.ok) return spawned

  const listening = await waitForReady(child)
  if (child.connected) child.disconnect()
  child.unref()
  if (!listening) {
    await stopProxyPid(spawned.value, environment)
    return errResult("ProcessError", `the tailnet proxy did not listen on 127.0.0.1:${port}. See ${log}`)
  }

  try {
    await fsp.writeFile(pidFile(), `${JSON.stringify({ pid: spawned.value, startedAt })}\n`)
    return ok(undefined)
  } catch (cause) {
    await stopProxyPid(spawned.value, environment)
    return errResult("IOError", `failed to write tailnet proxy pid ${pidFile()}`, cause)
  }
}

// Only the proxy's own message counts: a successful connect could be another process holding the port.
function waitForReady(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000)
    const settle = (ready: boolean) => { clearTimeout(timer); resolve(ready) }
    child.once("message", (message) => settle(message === "ready"))
    child.once("exit", () => settle(false))
  })
}

async function proxyRecord(environment: NodeJS.ProcessEnv): Promise<{ pid: number; startedAt: string } | null> {
  let record: { pid: number; startedAt: string }
  try {
    record = JSON.parse(await fsp.readFile(pidFile(), "utf8")) as { pid: number; startedAt: string }
  } catch {
    return null
  }
  if (!Number.isInteger(record.pid) || record.pid <= 0 || !isPidRunning(record.pid)) return null
  if (!await isTrackedPidRunning(record.pid, record.startedAt, environment)) return null
  return await isProxyProcess(record.pid, environment) ? record : null
}

async function stopProxyPid(pid: number, environment: NodeJS.ProcessEnv) {
  if (!await isProxyProcess(pid, environment)) return
  signal(pid, "SIGTERM")
  for (let waited = 0; waited < 1000 && isPidRunning(pid); waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (isPidRunning(pid) && await isProxyProcess(pid, environment)) signal(pid, "SIGKILL")
}

async function isProxyProcess(pid: number, environment: NodeJS.ProcessEnv) {
  const command = await processCommand(pid, childEnvironment(environment))
  return Boolean(command?.includes(path.basename(proxyScript())))
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
  } catch {}
}

async function readConfig(): Promise<TailnetProxyConfig | null> {
  try {
    return JSON.parse(await fsp.readFile(configFile(), "utf8")) as TailnetProxyConfig
  } catch {
    return null
  }
}

async function writeConfig(config: TailnetProxyConfig): Promise<Result<void>> {
  try {
    await fsp.mkdir(tailscaleDir(), { recursive: true })
    const temporary = `${configFile()}.tmp.${process.pid}`
    await fsp.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`)
    await fsp.rename(temporary, configFile())
    return ok(undefined)
  } catch (cause) {
    return errResult("IOError", `failed to write tailnet proxy config ${configFile()}`, cause)
  }
}

// Mirrors how Portless finds its own proxy: PORTLESS_PORT, then the port it recorded.
async function portlessPort(environment: NodeJS.ProcessEnv) {
  const fromEnvironment = Number(environment["PORTLESS_PORT"])
  if (Number.isInteger(fromEnvironment) && fromEnvironment > 0) return fromEnvironment
  const stateDir = environment["PORTLESS_STATE_DIR"] ? resolveHome(environment["PORTLESS_STATE_DIR"]) : path.join(os.homedir(), ".portless")
  try {
    const recorded = Number((await fsp.readFile(path.join(stateDir, "proxy.port"), "utf8")).trim())
    if (Number.isInteger(recorded) && recorded > 0) return recorded
  } catch {}
  return 443
}

function urlHostname(url: string | null) {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

function proxyScript() {
  return fileURLToPath(new URL(`./tailnet-proxy${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url))
}

function tailscaleDir() {
  return path.join(stateRoot(), "tailscale")
}

function configFile() {
  return path.join(tailscaleDir(), "proxy.json")
}

function pidFile() {
  return path.join(tailscaleDir(), "proxy.pid")
}

function logFile() {
  return path.join(tailscaleDir(), "proxy.log")
}

function commandError(cause: unknown) {
  if (!cause || typeof cause !== "object") return String(cause)
  const error = cause as { stderr?: string; message?: string }
  return error.stderr?.trim() || error.message || "unknown error"
}

function resolveHome(file: string) {
  if (file === "~") return os.homedir()
  if (file.startsWith("~/")) return path.join(os.homedir(), file.slice(2))
  return path.resolve(file)
}
