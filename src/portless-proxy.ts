import fs from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { childEnvironment } from "./environment.js"
import { existsAt, resolveHome } from "./shell.js"

const exec = promisify(execFile)

const PROBE_TIMEOUT_MS = 2_000

export type PortlessProxyState = "ok" | "stopped" | "foreign"

const DISCOVERY_TIMEOUT_MS = 500
const FALLBACK_PORT = 1355
const LEGACY_STATE_DIR = "/tmp/portless"

// The port a `portless` started with this environment serves on, found the way Portless 0.15
// discovers its proxy: a PORTLESS_STATE_DIR's recorded port, a running proxy recorded in
// ~/.portless or /tmp/portless, a running proxy on a well-known port, and only then
// PORTLESS_PORT. When nothing answers, `portless <name>` starts the proxy with an explicit
// --port for a recorded port that differs from PORTLESS_PORT, so a recorded port still wins.
export async function portlessPort(environment: NodeJS.ProcessEnv, answers: (port: number) => Promise<boolean> = answersAsPortless) {
  const configured = parsePort(environment["PORTLESS_PORT"])
  if (environment["PORTLESS_STATE_DIR"]) return await recordedPort(portlessStateDir(environment)) ?? configured ?? 443

  const recorded = await recordedPort(portlessStateDir(environment))
  if (recorded && await answers(recorded)) return recorded
  const legacy = await recordedPort(LEGACY_STATE_DIR)
  // Probed together and taken in Portless's order, so stalled ports cost one timeout in total.
  const candidates = [...new Set([legacy, 443, 80, FALLBACK_PORT, configured ?? FALLBACK_PORT])].filter((port) => port !== null)
  const answering = await Promise.all(candidates.map(answers))
  return candidates.find((_port, index) => answering[index]) ?? recorded ?? configured ?? 443
}

async function recordedPort(stateDir: string) {
  try {
    return parsePort(await fs.readFile(path.join(stateDir, "proxy.port"), "utf8"))
  } catch {
    return null
  }
}

function parsePort(value: string | undefined) {
  const port = Number(value?.trim() || Number.NaN)
  return isPort(port) ? port : null
}

// Portless's own liveness check: plain HTTP, answered with X-Portless: 1.
function answersAsPortless(port: number) {
  return new Promise<boolean>((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, method: "HEAD", path: "/" }, (response) => {
      response.resume()
      resolve(response.headers["x-portless"] === "1")
    })
    const deadline = setTimeout(() => request.destroy(new Error("timeout")), DISCOVERY_TIMEOUT_MS)
    request.on("close", () => clearTimeout(deadline))
    request.on("error", () => resolve(false))
    request.end()
  })
}

function isPort(value: number) {
  return Number.isInteger(value) && value > 0 && value <= 65_535
}

// Portless answers every request, even for unknown hosts, with an X-Portless header.
// Anything else on its port means another proxy took it, and routed URLs never reach Portless.
export async function probePortless(environment: NodeJS.ProcessEnv): Promise<{ state: PortlessProxyState; port: number }> {
  const port = await portlessPort(environment)
  const client = await portlessUsesTls(environment) ? https : http
  const state = await new Promise<PortlessProxyState>((resolve) => {
    const request = client.request({
      host: "127.0.0.1",
      port,
      method: "HEAD",
      path: "/",
      servername: "localhost",
      headers: { host: "work-doctor.localhost" },
      rejectUnauthorized: false,
    }, (response) => {
      response.resume()
      resolve(response.headers["x-portless"] ? "ok" : "foreign")
    })
    // An absolute deadline: a socket timeout resets on every byte, so a server trickling headers would never trip it.
    const deadline = setTimeout(() => request.destroy(new Error("timeout")), PROBE_TIMEOUT_MS)
    request.on("close", () => clearTimeout(deadline))
    request.on("error", (cause: NodeJS.ErrnoException) => resolve(cause.code === "ECONNREFUSED" ? "stopped" : "foreign"))
    request.end()
  })
  return { state, port }
}

// Domains the running Portless serves next to its app names. Portless 0.15.1 records
// several in proxy.tlds; older versions write one to proxy.tld.
export async function portlessTlds(environment: NodeJS.ProcessEnv) {
  const stateDir = portlessStateDir(environment)
  for (const file of ["proxy.tlds", "proxy.tld"]) {
    try {
      const tlds = (await fs.readFile(path.join(stateDir, file), "utf8")).split("\n").map((line) => line.trim()).filter(Boolean)
      if (tlds.length > 0) return tlds
    } catch {}
  }
  return ["localhost"]
}

// Why reinstalling the Portless startup service could change more than its TLDs, or null when it
// runs with defaults. service install replaces the whole configuration, and only TLDs carry over.
export async function portlessServiceCustomization(environment: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await exec("portless", ["service", "status"], { env: { ...childEnvironment(environment), NO_COLOR: "1" }, timeout: 10_000 })
    return serviceCustomization(stdout, portlessStateDir(environment), readFileOrEmpty)
  } catch {
    return "portless service status failed"
  }
}

export async function serviceCustomization(
  status: string,
  stateDir: string,
  readEntry: (file: string) => Promise<string>,
): Promise<string | null> {
  const fields = new Map(status.split("\n").flatMap((line) => {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line)
    return match ? [[match[1]!.trim(), match[2]!.trim()] as const] : []
  }))
  if (fields.get("Installed") !== "yes") return "the startup service is not installed"
  if (fields.get("HTTPS") !== "yes") return "it runs without HTTPS"
  if (fields.get("LAN mode") !== "no") return "it runs in LAN mode"
  if (fields.get("Wildcard") !== "no") return "it runs with wildcard routing"
  if (fields.get("State directory") !== stateDir) return `it uses the state directory ${fields.get("State directory") ?? "(unknown)"}`
  const entry = fields.get("Service entry")
  if (entry && /--(cert|key)\b/.test(await readEntry(entry))) return "it uses a custom certificate"
  return null
}

async function readFileOrEmpty(file: string) {
  return fs.readFile(file, "utf8").catch(() => "")
}

function portlessStateDir(environment: NodeJS.ProcessEnv) {
  return environment["PORTLESS_STATE_DIR"] ? resolveHome(environment["PORTLESS_STATE_DIR"]) : path.join(environment["HOME"] || os.homedir(), ".portless")
}

// Portless marks an HTTPS proxy by the presence of proxy.tls.
async function portlessUsesTls(environment: NodeJS.ProcessEnv) {
  return existsAt(path.join(portlessStateDir(environment), "proxy.tls"))
}
