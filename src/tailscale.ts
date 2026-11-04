import fs from "node:fs"
import fsp from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { globalConfigDir, readGlobalConfig } from "./config.js"
import { childEnvironment } from "./environment.js"
import { dnsLabel } from "./names.js"
import { portlessPort } from "./portless-proxy.js"
import { errResult, ok } from "./result.js"
import { commandExists, isPidRunning, isTrackedPidRunning, processCommand, resolveHome } from "./shell.js"
import { listWorkspaceStates, stateRoot } from "./state.js"
import type { Result } from "./result.js"
import type { CommandRecord, Exposure } from "./types.js"

type TailscaleExposure = Extract<Exposure, { mode: "tailscale" }>

export type TailnetProxyConfig = {
  port: number
  // Tailnet port that tailscale serve forwards to port. Missing in configs from older versions: 443.
  servePort?: number
  certFile: string
  keyFile: string
  // Port of the Portless proxy that serves the local URLs.
  portlessPort: number
  // Public hostname → local Portless URL of the same command.
  routes: Record<string, string>
}

const exec = promisify(execFile)
const DEFAULT_PORT = 47443
export const DEFAULT_SERVE_PORT = 443
const domainPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/

// Settings come from WORK_TAILSCALE_* first, then from `work tailscale setup`,
// which stores the domain globally and the certificate under the config dir.
export async function tailscaleExposure(environment: NodeJS.ProcessEnv = process.env): Promise<Result<Exposure>> {
  const globalConfig = await readGlobalConfig(environment)
  if (!globalConfig.ok) return globalConfig
  const domain = (environment["WORK_TAILSCALE_DOMAIN"] ?? savedTailscaleDomain(globalConfig.value))?.trim().toLowerCase()
  const port = Number(environment["WORK_TAILSCALE_PORT"] ?? DEFAULT_PORT)
  const servePort = Number(environment["WORK_TAILSCALE_SERVE_PORT"] ?? savedTailscaleServePort(globalConfig.value) ?? DEFAULT_SERVE_PORT)

  if (!isPreviewDomain(domain)) {
    return errResult("ConfigError", "no tailnet domain configured. Run: work tailscale setup")
  }

  const { certFile, keyFile } = certificatePaths(domain, environment)

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return errResult("ConfigError", "WORK_TAILSCALE_PORT must be a free local port between 1024 and 65535.")
  }

  if (!isServePort(servePort)) {
    return errResult("ConfigError", "WORK_TAILSCALE_SERVE_PORT must be a port between 1 and 65535.")
  }

  return ok({ mode: "tailscale", domain, certFile, keyFile, port, servePort })
}

export function savedTailscaleDomain(globalConfig: Record<string, unknown>) {
  const saved = globalConfig["tailscale"]
  return saved && typeof saved === "object" && "domain" in saved && typeof saved.domain === "string" ? saved.domain : undefined
}

export function savedTailscaleServePort(globalConfig: Record<string, unknown>) {
  const saved = globalConfig["tailscale"]
  return saved && typeof saved === "object" && "servePort" in saved && typeof saved.servePort === "number" ? saved.servePort : undefined
}

// WORK_TAILSCALE_DEFAULT=1/0 overrides what work tailscale setup --default saved.
export async function tailscaleByDefault(environment: NodeJS.ProcessEnv = process.env) {
  const override = environment["WORK_TAILSCALE_DEFAULT"]?.trim()
  if (override) return override === "1" || override.toLowerCase() === "true"
  const globalConfig = await readGlobalConfig(environment)
  if (!globalConfig.ok) return false
  const saved = globalConfig.value["tailscale"]
  return Boolean(saved && typeof saved === "object" && "default" in saved && saved.default === true)
}

export function isServePort(port: number) {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function servePortOf(exposure: { servePort?: number | undefined }) {
  return exposure.servePort ?? DEFAULT_SERVE_PORT
}

export function isPreviewDomain(domain: string | undefined): domain is string {
  return Boolean(domain && domainPattern.test(domain) && domain.includes(".") && domain.length <= 189)
}

// WORK_TAILSCALE_CERT/KEY override the default location, for runtime and setup alike.
export function certificatePaths(domain: string, environment: NodeJS.ProcessEnv = process.env) {
  const dir = path.join(globalConfigDir(environment), "tailscale")
  const certFile = environment["WORK_TAILSCALE_CERT"]?.trim() || path.join(dir, `${domain}.fullchain.pem`)
  const keyFile = environment["WORK_TAILSCALE_KEY"]?.trim() || path.join(dir, `${domain}.key.pem`)
  return { certFile: resolveHome(certFile), keyFile: resolveHome(keyFile) }
}

export function tailscaleHostname(route: string, exposure: Exposure) {
  if (exposure.mode !== "tailscale") return null
  return `${dnsLabel(route)}.${exposure.domain}`
}

// Host and, unless it is 443, port of the tailnet URL.
export function tailscaleHost(route: string, exposure: Exposure) {
  if (exposure.mode !== "tailscale") return null
  const servePort = servePortOf(exposure)
  return `${tailscaleHostname(route, exposure)}${servePort === DEFAULT_SERVE_PORT ? "" : `:${servePort}`}`
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
  if (exposures.some((other) => other.port !== exposure.port || servePortOf(other) !== servePortOf(exposure) || other.certFile !== exposure.certFile || other.keyFile !== exposure.keyFile)) {
    return errResult("ConfigError", "all active Tailscale commands on one machine must use the same WORK_TAILSCALE_PORT, WORK_TAILSCALE_SERVE_PORT, WORK_TAILSCALE_CERT, and WORK_TAILSCALE_KEY.")
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
    servePort: servePortOf(exposure),
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

  if (previous && servePortOf(previous) !== servePortOf(config)) {
    const removed = await removeServe(previous.port, servePortOf(previous), environment)
    if (!removed.ok) return removed
  }

  let proxy = await proxyRecord(environment)
  if (proxy && previous?.port !== config.port) {
    await stopProxyPid(proxy.pid, environment)
    proxy = null
  }
  if (!proxy) {
    const started = await startProxy(config.port, environment)
    if (!started.ok) return started
  }

  return ensureServe(config.port, servePortOf(config), environment)
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
    const removed = await removeServe(config.port, servePortOf(config), environment)
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

// tailscale serve owns the serve port (443 unless WORK_TAILSCALE_SERVE_PORT says otherwise) on
// the tailnet address, so work does not need root to listen there. It forwards raw TCP, which
// keeps TLS and Host routing in the proxy.
// Checked before anything stops or starts, so a held serve port fails the command up front.
export async function checkServePort(port: number, servePort: number, environment: NodeJS.ProcessEnv): Promise<Result<void>> {
  if (!await commandExists("tailscale", environment)) return ok(undefined)
  const status = await serveStatus(environment)
  if (!status.ok) return status
  const holder = await serveHolder(status.value, port, servePort)
  return holder === "foreign" ? errResult("ConfigError", serveConflictMessage(status.value, `127.0.0.1:${port}`, servePort)) : ok(undefined)
}

// A forward to a local port nobody listens on is left over from an earlier proxy (another
// WORK_TAILSCALE_PORT or a crashed run); work takes it over and says so.
async function serveHolder(output: string, port: number, servePort: number): Promise<"none" | "ours" | "stale" | "foreign"> {
  const current = parseServeTarget(output, servePort)
  if (!current) return "none"
  if (current === `127.0.0.1:${port}`) return "ours"
  const forwardPort = /^(?:127\.0\.0\.1|localhost):(\d+)$/.exec(current)?.[1]
  return forwardPort && !await isPortListening(Number(forwardPort)) ? "stale" : "foreign"
}

async function ensureServe(port: number, servePort: number, environment: NodeJS.ProcessEnv): Promise<Result<void>> {
  const status = await serveStatus(environment)
  if (!status.ok) return status
  const current = parseServeTarget(status.value, servePort)
  const target = `127.0.0.1:${port}`
  const holder = await serveHolder(status.value, port, servePort)
  if (holder === "ours") return ok(undefined)
  if (holder === "foreign") return errResult("ConfigError", serveConflictMessage(status.value, target, servePort))
  if (holder === "stale") {
    console.error(`taking over tailnet port ${servePort} from ${current}: nothing listens there`)
    try {
      await exec("tailscale", ["serve", `--tcp=${servePort}`, "off"], { env: childEnvironment(environment), timeout: 30_000 })
    } catch (cause) {
      return errResult("ProcessError", `failed to remove the stale tailnet forward to ${current}: ${commandError(cause)}`)
    }
  }

  try {
    await exec("tailscale", ["serve", "--bg", `--tcp=${servePort}`, `tcp://${target}`], { env: childEnvironment(environment), timeout: 30_000 })
    return ok(undefined)
  } catch (cause) {
    return errResult("ProcessError", `failed to forward tailnet port ${servePort} to ${target}: ${commandError(cause)}`)
  }
}

async function removeServe(port: number, servePort: number, environment: NodeJS.ProcessEnv): Promise<Result<void>> {
  if (!await commandExists("tailscale", environment)) return ok(undefined)
  const current = await serveTarget(servePort, environment)
  if (!current.ok || current.value !== `127.0.0.1:${port}`) return ok(undefined)

  try {
    await exec("tailscale", ["serve", `--tcp=${servePort}`, "off"], { env: childEnvironment(environment), timeout: 30_000 })
    return ok(undefined)
  } catch (cause) {
    return errResult("ProcessError", `failed to remove the tailnet forward on port ${servePort}: ${commandError(cause)}`)
  }
}

async function serveTarget(servePort: number, environment: NodeJS.ProcessEnv): Promise<Result<string | null>> {
  const status = await serveStatus(environment)
  return status.ok ? ok(parseServeTarget(status.value, servePort)) : status
}

async function serveStatus(environment: NodeJS.ProcessEnv): Promise<Result<string>> {
  try {
    return ok((await exec("tailscale", ["serve", "status", "--json"], { env: childEnvironment(environment), timeout: 30_000 })).stdout)
  } catch (cause) {
    return errResult("ProcessError", `failed to read tailscale serve status: ${commandError(cause)}`)
  }
}

// localhost forwards may land on either loopback family, e.g. a Vite server bound only to ::1.
async function isPortListening(port: number): Promise<boolean> {
  const results = await Promise.all(["127.0.0.1", "::1"].map((host) => acceptsConnections(host, port)))
  return results.includes(true)
}

function acceptsConnections(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1000 })
    const done = (listening: boolean) => {
      socket.destroy()
      resolve(listening)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.once("timeout", () => done(false))
  })
}

// Names the handler that holds the serve port and the exact commands to free it, since work needs raw TCP there.
export function serveConflictMessage(output: string, target: string, servePort = DEFAULT_SERVE_PORT): string {
  const otherPort = servePort === 8443 ? 9443 : 8443
  const pickAnother = `or pick another port for work with: work tailscale setup --serve-port <port>`
  const current = parseServeTarget(output, servePort)
  if (current && current !== "another tailscale serve handler") {
    return `tailscale serve already forwards tailnet port ${servePort} to ${current}, which is in use, so work cannot point it at its proxy (${target}).\n` +
      `If that forward is yours, move it to another port; otherwise free ${servePort} with: tailscale serve --tcp=${servePort} off, ${pickAnother}\nThen rerun this command.`
  }
  const handlers = webHandlers(output, servePort)
  const described = handlers.length > 0 ? handlers.map(({ path, proxy }) => `${path} -> ${proxy}`).join(", ") : "an HTTPS handler"
  const move = handlers.length > 0
    ? handlers.map(({ path, proxy }) => `tailscale serve --bg --https=${otherPort}${path === "/" ? "" : ` --set-path=${path}`} ${proxy}`).join(" && ")
    : `tailscale serve --bg --https=${otherPort} <target>`
  return `tailscale serve already uses tailnet port ${servePort} for ${described}; work needs raw TCP on ${servePort} for its proxy (${target}).\n` +
    `Move that handler to port ${otherPort}: tailscale serve --https=${servePort} off && ${move}, ${pickAnother}\nThen rerun this command.`
}

function webHandlers(output: string, servePort: number): Array<{ path: string; proxy: string }> {
  try {
    const web = (JSON.parse(output || "{}") as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown; Path?: unknown; Text?: unknown }> }> }).Web ?? {}
    return Object.entries(web)
      .filter(([host]) => host.endsWith(`:${servePort}`))
      .flatMap(([, config]) => Object.entries(config.Handlers ?? {}))
      .map(([path, handler]) => ({ path, proxy: typeof handler.Proxy === "string" ? handler.Proxy : typeof handler.Path === "string" ? handler.Path : "a static handler" }))
  } catch {
    return []
  }
}

// Where tailscale serve points when work's own proxy is running, or null.
export async function ownProxyTarget() {
  const config = await readConfig()
  return config ? `127.0.0.1:${config.port}` : null
}

export function parseServeTarget(output: string, servePort = DEFAULT_SERVE_PORT): string | null {
  let status: unknown
  try {
    status = JSON.parse(output || "{}")
  } catch {
    return null
  }
  if (!status || typeof status !== "object" || !("TCP" in status)) return null
  const handlers = status.TCP as Record<string, { TCPForward?: unknown; HTTPS?: unknown } | undefined>
  const handler = handlers[String(servePort)]
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
