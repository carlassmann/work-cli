import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { childEnvironment } from "./environment.js"
import { exposureLabel, slugify } from "./names.js"
import { errResult, ok } from "./result.js"
import { commandExists, isPidRunning, isTrackedPidRunning, processCommand } from "./shell.js"
import { listWorkspaceStates, stateRoot } from "./state.js"
import type { Result } from "./result.js"
import type { CommandRecord, Exposure } from "./types.js"

const exec = promisify(execFile)
const CONNECTOR_LOG_LIMIT = 5 * 1024 * 1024
const tunnelIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const domainPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/

export function cloudflareExposure(environment: NodeJS.ProcessEnv = process.env): Result<Exposure> {
  const domain = environment["WORK_CLOUDFLARE_DOMAIN"]?.trim().toLowerCase()
  const tunnelId = environment["WORK_CLOUDFLARE_TUNNEL_ID"]?.trim()
  const machine = slugify(environment["WORK_CLOUDFLARE_MACHINE"] ?? os.hostname().split(".")[0] ?? "")

  if (!domain || !domainPattern.test(domain) || !domain.includes(".") || domain.length > 189) {
    return errResult("ConfigError", "WORK_CLOUDFLARE_DOMAIN must be the Cloudflare DNS zone, for example example.com.")
  }

  if (!tunnelId || !tunnelIdPattern.test(tunnelId)) {
    return errResult("ConfigError", "WORK_CLOUDFLARE_TUNNEL_ID must be the UUID of a locally-managed Cloudflare Tunnel.")
  }

  if (!machine) {
    return errResult("ConfigError", "WORK_CLOUDFLARE_MACHINE or the system hostname must produce a DNS-safe name.")
  }

  const credentialsFile = resolveHome(
    environment["WORK_CLOUDFLARE_CREDENTIALS"] ?? path.join(os.homedir(), ".cloudflared", `${tunnelId}.json`),
  )

  return ok({ mode: "cloudflare", machine, domain, tunnelId, credentialsFile })
}

export function cloudflareHostname(route: string, exposure: Exposure) {
  if (exposure.mode !== "cloudflare") return null
  return `${exposureLabel(exposure.machine, route)}.${exposure.domain}`
}

export async function reserveBackendPort(): Promise<Result<number>> {
  const net = await import("node:net")

  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once("error", () => resolve(errResult("ProcessError", "failed to reserve a backend port")))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === "string") {
          resolve(errResult("ProcessError", "failed to reserve a backend port"))
          return
        }
        resolve(ok(address.port))
      })
    })
  })
}

let pendingSync: Promise<Result<void>> = Promise.resolve(ok(undefined))

export function syncCloudflareTunnel(environment: NodeJS.ProcessEnv = process.env): Promise<Result<void>> {
  pendingSync = pendingSync.then(() => runSync(environment), () => runSync(environment))
  return pendingSync
}

async function runSync(environment: NodeJS.ProcessEnv): Promise<Result<void>> {
  const records: Array<CommandRecord> = []
  for (const record of (await listWorkspaceStates()).flatMap((state) => Object.values(state.commands))) {
    if (await isActiveCloudflareRecord(record)) records.push(record)
  }

  if (records.length === 0) return stopConnector(environment)

  const exposures = records.map((record) => record.exposure).filter((exposure): exposure is Extract<Exposure, { mode: "cloudflare" }> => exposure?.mode === "cloudflare")
  const tunnelIds = new Set(exposures.map((exposure) => exposure.tunnelId))
  if (tunnelIds.size !== 1) {
    return errResult("ConfigError", "all active Cloudflare commands on one machine must use the same tunnel UUID.")
  }

  if (!await commandExists("cloudflared", environment)) {
    return errResult("ProcessError", "cloudflared is required for --cloudflare. Install it and make sure it is on PATH.")
  }

  const exposure = exposures[0]
  if (!exposure) return errResult("ProcessError", "missing Cloudflare exposure configuration")

  try {
    await fsp.access(exposure.credentialsFile)
  } catch {
    return errResult("ConfigError", `Cloudflare Tunnel credentials not found: ${exposure.credentialsFile}`)
  }

  try {
    await fsp.mkdir(cloudflareDir(), { recursive: true })
  } catch (cause) {
    return errResult("IOError", `failed to create ${cloudflareDir()}`, cause)
  }

  const config = cloudflareConfig(exposure, records)
  const previousConfig = await readConfig()
  const currentConnector = await connectorRecord(environment)
  if (currentConnector && previousConfig === config) return ok(undefined)

  const dnsRoutes = await readDnsRoutes()
  for (const record of records) {
    const hostname = recordHostname(record)
    if (!hostname) continue
    const routed = await ensureDnsRoute(exposure.tunnelId, hostname, dnsRoutes, environment)
    if (!routed.ok) return routed
  }

  const write = await writeConfig(config)
  if (!write.ok) return write

  const started = await startConnector(exposure.tunnelId, environment)
  if (!started.ok) {
    await restoreConfig(previousConfig)
    return started
  }

  try {
    await fsp.writeFile(pidFile(), `${JSON.stringify(started.value)}\n`)
  } catch (cause) {
    await stopConnectorPid(started.value.pid, environment)
    await restoreConfig(previousConfig)
    return errResult("IOError", `failed to write Cloudflare connector pid ${pidFile()}`, cause)
  }
  if (currentConnector) await stopConnectorPid(currentConnector.pid, environment)
  return ok(undefined)
}

async function isActiveCloudflareRecord(record: CommandRecord) {
  return record.exposure?.mode === "cloudflare"
    && Boolean(record.backendPort)
    && Boolean(record.url)
    && await isTrackedPidRunning(record.pid, record.startedAt)
}

async function ensureDnsRoute(
  tunnelId: string,
  hostname: string,
  routes: Record<string, string>,
  environment: NodeJS.ProcessEnv,
): Promise<Result<void>> {
  const owned = routes[hostname] === tunnelId
  try {
    await exec("cloudflared", ["tunnel", "route", "dns", ...(owned ? ["--overwrite-dns"] : []), tunnelId, hostname], {
      env: childEnvironment(environment),
      timeout: 30_000,
    })
    routes[hostname] = tunnelId
    await fsp.writeFile(dnsRoutesFile(), `${JSON.stringify(routes, null, 2)}\n`)
    return ok(undefined)
  } catch (cause) {
    const detail = commandError(cause)
    if (/record with that host already exists/i.test(detail)) {
      return errResult("ProcessError", `${hostname} already has a DNS record not managed by work. Point it to ${tunnelId}.cfargotunnel.com, remove it, then retry.`)
    }
    return errResult("ProcessError", `failed to route ${hostname} to Cloudflare Tunnel: ${detail}. Run cloudflared tunnel login, then retry.`)
  }
}

function cloudflareConfig(exposure: Extract<Exposure, { mode: "cloudflare" }>, records: Array<CommandRecord>) {
  const ingress = records.flatMap((record) => {
    const hostname = recordHostname(record)
    return hostname && record.backendPort
      ? [`  - hostname: ${JSON.stringify(hostname)}`, `    service: ${JSON.stringify(`http://127.0.0.1:${record.backendPort}`)}`]
      : []
  })

  return [
    `tunnel: ${JSON.stringify(exposure.tunnelId)}`,
    `credentials-file: ${JSON.stringify(exposure.credentialsFile)}`,
    "ingress:",
    ...ingress,
    "  - service: http_status:404",
    "",
  ].join("\n")
}

function recordHostname(record: CommandRecord) {
  if (!record.url) return null
  try {
    return new URL(record.url).hostname
  } catch {
    return null
  }
}

function cloudflareDir() {
  return path.join(stateRoot(), "cloudflare")
}

function configFile() {
  return path.join(cloudflareDir(), "config.yml")
}

function pidFile() {
  return path.join(cloudflareDir(), "cloudflared.pid")
}

function startupLogFile() {
  return path.join(cloudflareDir(), `cloudflared-${Date.now()}-${process.pid}.log`)
}

function dnsRoutesFile() {
  return path.join(cloudflareDir(), "dns-routes.json")
}

async function readDnsRoutes(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fsp.readFile(dnsRoutesFile(), "utf8")) as Record<string, string>
  } catch {
    return {}
  }
}

async function writeConfig(config: string): Promise<Result<void>> {
  try {
    await fsp.mkdir(cloudflareDir(), { recursive: true })
    const temporary = `${configFile()}.tmp.${process.pid}`
    await fsp.writeFile(temporary, config)
    await fsp.rename(temporary, configFile())
    return ok(undefined)
  } catch (cause) {
    return errResult("IOError", `failed to write Cloudflare Tunnel config ${configFile()}`, cause)
  }
}

async function readConfig() {
  try {
    return await fsp.readFile(configFile(), "utf8")
  } catch {
    return null
  }
}

async function restoreConfig(config: string | null) {
  if (config === null) {
    await fsp.rm(configFile(), { force: true }).catch(() => undefined)
    return
  }
  await fsp.writeFile(configFile(), config).catch(() => undefined)
}

async function startConnector(tunnelId: string, environment: NodeJS.ProcessEnv): Promise<Result<{ pid: number; startedAt: string }>> {
  await pruneConnectorLogs()
  const startupLog = startupLogFile()
  let outputFile: number
  try {
    outputFile = fs.openSync(startupLog, "wx")
  } catch (cause) {
    return errResult("IOError", `failed to open Cloudflare log ${startupLog}`, cause)
  }

  const output = fs.createWriteStream(startupLog, { fd: outputFile, autoClose: true })
  output.on("error", () => undefined)
  const captured = { value: "" }
  let written = 0

  const startedAt = new Date().toISOString()
  const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--config", configFile(), "run", tunnelId], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnvironment(environment),
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      if (captured.value.length < 256 * 1024) captured.value += chunk.toString("utf8")
      if (written >= CONNECTOR_LOG_LIMIT) return
      const remaining = CONNECTOR_LOG_LIMIT - written
      const part = chunk.subarray(0, remaining)
      written += part.length
      output.write(part)
    })
  }
  child.once("exit", () => output.end())

  const spawned = await new Promise<Result<number>>((resolve) => {
    child.once("error", (cause) => {
      output.end()
      resolve(errResult("ProcessError", "failed to start cloudflared", cause))
    })
    child.once("spawn", () => resolve(child.pid ? ok(child.pid) : errResult("ProcessError", "cloudflared spawned without a pid")))
  })
  if (!spawned.ok) return spawned

  child.unref()
  const healthy = await waitForConnector(child, spawned.value, startupLog, captured)
  if (!healthy.ok) {
    await stopConnectorPid(spawned.value, environment)
    return healthy
  }
  return ok({ pid: spawned.value, startedAt })
}

async function waitForConnector(
  child: import("node:child_process").ChildProcess,
  pid: number,
  startupLog: string,
  captured: { value: string },
): Promise<Result<void>> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null || child.signalCode !== null || !isPidRunning(pid)) {
      return errResult("ProcessError", `cloudflared exited during startup. See ${startupLog}`)
    }

    if (/Registered tunnel connection/i.test(captured.value)) return ok(undefined)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  return errResult("ProcessError", `cloudflared did not establish a connection within 10 seconds. See ${startupLog}`)
}

async function pruneConnectorLogs() {
  const entries = await fsp.readdir(cloudflareDir()).catch(() => [])
  const logs = entries.filter((entry) => /^cloudflared-\d+-\d+\.log$/.test(entry)).sort()
  await Promise.all(logs.slice(0, -4).map((entry) => fsp.rm(path.join(cloudflareDir(), entry), { force: true })))
}

async function connectorRecord(environment: NodeJS.ProcessEnv): Promise<{ pid: number; startedAt?: string } | null> {
  let record: { pid: number; startedAt?: string }
  try {
    const value = (await fsp.readFile(pidFile(), "utf8")).trim()
    record = value.startsWith("{") ? JSON.parse(value) as { pid: number; startedAt?: string } : { pid: Number(value) }
  } catch {
    return null
  }

  if (!Number.isInteger(record.pid) || record.pid <= 0 || !isPidRunning(record.pid)) return null
  if (record.startedAt && !await isTrackedPidRunning(record.pid, record.startedAt, environment)) return null
  return await isCloudflaredProcess(record.pid, environment) ? record : null
}

async function stopConnector(environment: NodeJS.ProcessEnv): Promise<Result<void>> {
  const connector = await connectorRecord(environment)
  if (connector) await stopConnectorPid(connector.pid, environment)

  try {
    await fsp.rm(pidFile(), { force: true })
    return ok(undefined)
  } catch (cause) {
    return errResult("IOError", `failed to remove ${pidFile()}`, cause)
  }
}

async function stopConnectorPid(pid: number, environment: NodeJS.ProcessEnv) {
  if (!await isCloudflaredProcess(pid, environment)) return
  signalProcessGroup(pid, "SIGTERM")
  for (let waited = 0; waited < 1000 && isPidRunning(pid); waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (isPidRunning(pid) && await isCloudflaredProcess(pid, environment)) signalProcessGroup(pid, "SIGKILL")
}

async function isCloudflaredProcess(pid: number, environment: NodeJS.ProcessEnv) {
  const command = await processCommand(pid, childEnvironment(environment))
  return Boolean(command && /(?:^|\/)cloudflared(?:\s|$)/.test(command))
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch {}
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
