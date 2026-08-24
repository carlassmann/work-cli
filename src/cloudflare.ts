import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { childEnvironment } from "./environment.js"
import { exposureLabel, slugify } from "./names.js"
import { errResult, ok } from "./result.js"
import { commandExists, isPidRunning } from "./shell.js"
import { listWorkspaceStates, stateRoot } from "./state.js"
import type { Result } from "./result.js"
import type { CommandRecord, Exposure } from "./types.js"

const exec = promisify(execFile)
const tunnelIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const domainPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/

export function cloudflareExposure(environment: Record<string, string> = {}): Result<Exposure> {
  const domain = environment["WORK_CLOUDFLARE_DOMAIN"]?.trim().toLowerCase()
  const tunnelId = environment["WORK_CLOUDFLARE_TUNNEL_ID"]?.trim()
  const machine = slugify(environment["WORK_CLOUDFLARE_MACHINE"] ?? os.hostname().split(".")[0] ?? "")

  if (!domain || !domainPattern.test(domain) || !domain.includes(".") || domain.length > 189) {
    return errResult("ConfigError", "WORK_CLOUDFLARE_DOMAIN must be a valid domain, for example dev.example.com.")
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

export function syncCloudflareTunnel(): Promise<Result<void>> {
  pendingSync = pendingSync.then(runSync, runSync)
  return pendingSync
}

async function runSync(): Promise<Result<void>> {
  const records = (await listWorkspaceStates())
    .flatMap((state) => Object.values(state.commands))
    .filter(isActiveCloudflareRecord)

  const stop = await stopConnector()
  if (!stop.ok) return stop
  if (records.length === 0) return ok(undefined)

  const exposures = records.map((record) => record.exposure).filter((exposure): exposure is Extract<Exposure, { mode: "cloudflare" }> => exposure?.mode === "cloudflare")
  const tunnelIds = new Set(exposures.map((exposure) => exposure.tunnelId))
  if (tunnelIds.size !== 1) {
    return errResult("ConfigError", "all active Cloudflare commands on one machine must use the same tunnel UUID.")
  }

  if (!await commandExists("cloudflared")) {
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

  const dnsRoutes = await readDnsRoutes()
  for (const record of records) {
    const hostname = recordHostname(record)
    if (!hostname) continue
    const routed = await ensureDnsRoute(exposure.tunnelId, hostname, dnsRoutes)
    if (!routed.ok) return routed
  }

  const config = cloudflareConfig(exposure, records)
  const write = await writeConfig(config)
  if (!write.ok) return write

  return startConnector(exposure.tunnelId)
}

function isActiveCloudflareRecord(record: CommandRecord) {
  return record.exposure?.mode === "cloudflare" && Boolean(record.backendPort) && Boolean(record.url) && isPidRunning(record.pid)
}

async function ensureDnsRoute(tunnelId: string, hostname: string, routes: Record<string, string>): Promise<Result<void>> {
  if (routes[hostname] === tunnelId) return ok(undefined)

  try {
    await exec("cloudflared", ["tunnel", "route", "dns", tunnelId, hostname])
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

function logFile() {
  return path.join(cloudflareDir(), "cloudflared.log")
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

async function startConnector(tunnelId: string): Promise<Result<void>> {
  let output: number
  try {
    output = fs.openSync(logFile(), "a")
  } catch (cause) {
    return errResult("IOError", `failed to open Cloudflare log ${logFile()}`, cause)
  }

  const child = spawn("cloudflared", ["tunnel", "--config", configFile(), "run", tunnelId], {
    detached: true,
    stdio: ["ignore", output, output],
    env: childEnvironment(),
  })

  const started = await new Promise<Result<number>>((resolve) => {
    let settled = false
    const finish = (result: Result<number>) => {
      if (settled) return
      settled = true
      fs.closeSync(output)
      resolve(result)
    }

    child.once("error", (cause) => finish(errResult("ProcessError", "failed to start cloudflared", cause)))
    child.once("exit", (code, signal) => finish(errResult("ProcessError", `cloudflared exited during startup (${signal ?? `code ${code ?? "unknown"}`}). See ${logFile()}`)))
    child.once("spawn", () => setTimeout(() => finish(child.pid ? ok(child.pid) : errResult("ProcessError", "cloudflared spawned without a pid")), 250))
  })
  if (!started.ok) return started

  child.unref()
  await fsp.writeFile(pidFile(), `${started.value}\n`)
  return ok(undefined)
}

async function stopConnector(): Promise<Result<void>> {
  let pid: number
  try {
    pid = Number((await fsp.readFile(pidFile(), "utf8")).trim())
  } catch {
    return ok(undefined)
  }

  if (Number.isInteger(pid) && pid > 0 && isPidRunning(pid)) {
    signalProcessGroup(pid, "SIGTERM")
    for (let waited = 0; waited < 1000 && isPidRunning(pid); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (isPidRunning(pid)) signalProcessGroup(pid, "SIGKILL")
  }

  try {
    await fsp.rm(pidFile(), { force: true })
    return ok(undefined)
  } catch (cause) {
    return errResult("IOError", `failed to remove ${pidFile()}`, cause)
  }
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
