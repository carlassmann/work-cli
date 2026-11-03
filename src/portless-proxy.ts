import fs from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { childEnvironment } from "./environment.js"
import { errResult, ok } from "./result.js"
import type { Result } from "./result.js"
import { existsAt, resolveHome } from "./shell.js"
import { stateRoot } from "./state.js"
import { proxyLaunchPlan, systemdUserManagerAvailable } from "./systemd.js"

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
// Portless deletes proxy.port when its proxy stops; the last resort is then the port work last
// saw answering for that state directory, before Portless's default :443.
export async function portlessPort(environment: NodeJS.ProcessEnv, answers: (port: number) => Promise<boolean> = answersAsPortless) {
  const configured = parsePort(environment["PORTLESS_PORT"])
  const stateDir = portlessStateDir(environment)
  if (environment["PORTLESS_STATE_DIR"]) return await recordedPort(stateDir) ?? configured ?? await fallbackPort(stateDir)

  const recorded = await recordedPort(stateDir)
  if (recorded && await answers(recorded)) return recorded
  const legacy = await recordedPort(LEGACY_STATE_DIR)
  // Probed together and taken in Portless's order, so stalled ports cost one timeout in total.
  const candidates = [...new Set([legacy, 443, 80, FALLBACK_PORT, configured ?? FALLBACK_PORT])].filter((port) => port !== null)
  const answering = await Promise.all(candidates.map(answers))
  return candidates.find((_port, index) => answering[index]) ?? recorded ?? configured ?? await fallbackPort(stateDir)
}

async function fallbackPort(stateDir: string) {
  return (await lastSeenProxy(stateDir))?.port ?? 443
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
// Pass the port when it is already resolved, so the probe hits exactly the endpoint URLs use.
export async function probePortless(environment: NodeJS.ProcessEnv, resolvedPort?: number): Promise<{ state: PortlessProxyState; port: number }> {
  const port = resolvedPort ?? await portlessPort(environment)
  const tls = await portlessUsesTls(environment)
  const client = tls ? https : http
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
  if (state === "ok") await rememberProxy(portlessStateDir(environment), { port, tls })
  return { state, port }
}

type SeenProxy = { port: number; tls: boolean }

function lastSeenProxyFile() {
  return path.join(stateRoot(), "portless-proxy.json")
}

async function lastSeenProxies(): Promise<Record<string, SeenProxy>> {
  try {
    const seen = JSON.parse(await fs.readFile(lastSeenProxyFile(), "utf8")) as unknown
    return seen && typeof seen === "object" ? seen as Record<string, SeenProxy> : {}
  } catch {
    return {}
  }
}

async function lastSeenProxy(stateDir: string): Promise<SeenProxy | null> {
  const seen = (await lastSeenProxies())[stateDir]
  return seen && isPort(Number(seen.port)) ? { port: Number(seen.port), tls: seen.tls !== false } : null
}

async function rememberProxy(stateDir: string, proxy: SeenProxy) {
  const seen = await lastSeenProxies()
  if (seen[stateDir]?.port === proxy.port && seen[stateDir]?.tls === proxy.tls) return
  try {
    await fs.mkdir(stateRoot(), { recursive: true, mode: 0o700 })
    await fs.writeFile(lastSeenProxyFile(), `${JSON.stringify({ ...seen, [stateDir]: proxy })}\n`)
  } catch {}
}

export type ProxyRemedy =
  | { kind: "start"; command: string }
  | { kind: "sudo"; command: string; unprivileged: string }
  | { kind: "service"; command: string }

// Portless also deletes proxy.tls on stop, and without -p it starts on :443, which needs sudo
// and so fails for agents without a terminal.
export function proxyRemedy(port: number, tls: boolean, service: { installed: boolean; platform: NodeJS.Platform }): ProxyRemedy {
  if (service.installed) {
    if (service.platform === "linux") return { kind: "service", command: "sudo systemctl restart portless" }
    if (service.platform === "darwin") return { kind: "service", command: "sudo launchctl kickstart -k system/sh.portless.proxy" }
    return { kind: "service", command: "portless service status" }
  }
  const start = (startPort: number) => `portless proxy start -p ${startPort} ${tls ? "--https" : "--no-tls"}`
  if (port >= 1024 || service.platform === "win32") return { kind: "start", command: start(port) }
  return { kind: "sudo", command: `sudo ${start(port)}`, unprivileged: start(FALLBACK_PORT) }
}

export async function portlessProxyRemedy(
  environment: NodeJS.ProcessEnv,
  port: number,
  serviceInstalled: (environment: NodeJS.ProcessEnv) => Promise<boolean> = portlessServiceInstalled,
) {
  const seen = await lastSeenProxy(portlessStateDir(environment))
  return proxyRemedy(port, seen?.tls ?? true, { installed: await serviceInstalled(environment), platform: process.platform })
}

export function proxyRemedyHint(remedy: ProxyRemedy) {
  if (remedy.kind === "service") return `restart its startup service with ${remedy.command}`
  if (remedy.kind === "sudo") return `start it with ${remedy.command}, or without sudo: ${remedy.unprivileged}`
  return `start it with ${remedy.command}`
}

function proxyRemedySteps(remedy: ProxyRemedy) {
  if (remedy.kind === "service") return `Its startup service is installed; restart it (needs sudo), then retry:\n  ${remedy.command}`
  if (remedy.kind === "sudo") return `Start it in a terminal (sudo asks for a password), then retry:\n  ${remedy.command}\nor without sudo on :${FALLBACK_PORT}:\n  ${remedy.unprivileged}`
  return `Start it, then retry:\n  ${remedy.command}`
}

// A routed command, the Portless port its URL was built for, and the environment it is spawned with.
export type RoutedCommand = { id: string; port: number; environment: NodeJS.ProcessEnv }

export type ProxyStarter = (port: number, tls: boolean, environment: NodeJS.ProcessEnv) => Promise<Result<void>>

const PROXY_START_TIMEOUT_MS = 30_000
const PROXY_READY_TIMEOUT_MS = 10_000

// Starts routed commands only once their Portless proxy answers. A stopped proxy that
// needs no sudo is started by work in a scope of its own (see proxyLaunchPlan), so it
// does not die with whichever agent thread or terminal ran this work command. Every
// distinct endpoint is probed once; a proxy work cannot start leaves every command as it was.
export async function ensurePortlessProxy(
  routed: Array<RoutedCommand>,
  probe: typeof probePortless = probePortless,
  serviceInstalled?: (environment: NodeJS.ProcessEnv) => Promise<boolean>,
  start: ProxyStarter = startPortlessProxy,
  readyTimeoutMs = PROXY_READY_TIMEOUT_MS,
): Promise<Result<void>> {
  const endpoints = new Map<string, Array<RoutedCommand>>()
  for (const command of routed) {
    const key = `${command.port}\0${portlessStateDir(command.environment)}`
    endpoints.set(key, [...endpoints.get(key) ?? [], command])
  }

  const stopped: Array<string> = []
  for (const commands of endpoints.values()) {
    const { environment, port } = commands[0]!
    const proxy = await probe(environment, port)
    if (proxy.state !== "stopped") continue
    const remedy = await portlessProxyRemedy(environment, proxy.port, serviceInstalled)
    const needs = `routed commands need it (${commands.map((command) => command.id).join(", ")})`
    if (remedy.kind !== "start") {
      stopped.push(`the Portless proxy is not running on :${proxy.port}, and ${needs}. ${proxyRemedySteps(remedy)}`)
      continue
    }
    const tls = (await lastSeenProxy(portlessStateDir(environment)))?.tls ?? true
    const started = await start(proxy.port, tls, environment)
    const failure = started.ok ? await waitForProxy(probe, environment, proxy.port, readyTimeoutMs) : started.error.message
    if (failure) stopped.push(`the Portless proxy is not running on :${proxy.port}, and ${needs}. work could not start it: ${failure}\n${proxyRemedySteps(remedy)}`)
  }

  return stopped.length === 0 ? ok(undefined) : errResult("PortlessError", stopped.join("\n"))
}

async function waitForProxy(probe: typeof probePortless, environment: NodeJS.ProcessEnv, port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const { state } = await probe(environment, port)
    if (state === "ok") return null
    if (state === "foreign") return `another proxy took :${port}`
    if (Date.now() >= deadline) return `it did not answer on :${port} within ${Math.round(timeoutMs / 1_000)}s`
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// `portless proxy start` daemonizes and returns. Its output goes to a file rather than a
// pipe: the daemon would inherit a pipe and hold it open for as long as it runs.
async function startPortlessProxy(port: number, tls: boolean, environment: NodeJS.ProcessEnv): Promise<Result<void>> {
  const entrypoint = { command: "portless", args: ["proxy", "start", "-p", String(port), tls ? "--https" : "--no-tls"] }
  const plan = proxyLaunchPlan(entrypoint, { systemd: await systemdUserManagerAvailable(environment) })
  let outcome = await runProxyStart(plan, environment)
  // systemd-run fails before it execs Portless when it cannot reach the user manager.
  if (!outcome.ok && plan.unit !== null) outcome = await runProxyStart(entrypoint, environment)
  return outcome
}

async function runProxyStart(launch: { command: string; args: Array<string> }, environment: NodeJS.ProcessEnv): Promise<Result<void>> {
  try {
    await fs.mkdir(stateRoot(), { recursive: true, mode: 0o700 })
  } catch {}
  const logFile = path.join(stateRoot(), "portless-proxy-start.log")
  let log: fs.FileHandle
  try {
    log = await fs.open(logFile, "w")
  } catch (cause) {
    return errResult("PortlessError", `cannot write ${logFile}`, cause)
  }
  try {
    const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      const child = spawn(launch.command, launch.args, {
        env: childEnvironment(environment),
        stdio: ["ignore", log.fd, log.fd],
        detached: true,
      })
      const deadline = setTimeout(() => child.kill("SIGKILL"), PROXY_START_TIMEOUT_MS)
      child.once("error", (error) => {
        clearTimeout(deadline)
        resolve({ code: null, error })
      })
      child.once("exit", (code) => {
        clearTimeout(deadline)
        resolve({ code })
      })
      child.unref()
    })
    if (exit.code === 0) return ok(undefined)
    const output = (await fs.readFile(logFile, "utf8").catch(() => "")).trim().split("\n").slice(-5).join("\n")
    const detail = exit.error?.message ?? `${[launch.command, ...launch.args].join(" ")} exited ${exit.code ?? "on a signal"}`
    return errResult("PortlessError", output ? `${detail}:\n${output}` : detail)
  } finally {
    await log.close()
  }
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
    return serviceCustomization(await portlessServiceStatus(environment), portlessStateDir(environment), readFileOrEmpty)
  } catch {
    return "portless service status failed"
  }
}

async function portlessServiceInstalled(environment: NodeJS.ProcessEnv) {
  try {
    return serviceStatusFields(await portlessServiceStatus(environment)).get("Installed") === "yes"
  } catch {
    return false
  }
}

async function portlessServiceStatus(environment: NodeJS.ProcessEnv) {
  const { stdout } = await exec("portless", ["service", "status"], { env: { ...childEnvironment(environment), NO_COLOR: "1" }, timeout: 10_000 })
  return stdout
}

function serviceStatusFields(status: string) {
  return new Map(status.split("\n").flatMap((line) => {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line)
    return match ? [[match[1]!.trim(), match[2]!.trim()] as const] : []
  }))
}

export async function serviceCustomization(
  status: string,
  stateDir: string,
  readEntry: (file: string) => Promise<string>,
): Promise<string | null> {
  const fields = serviceStatusFields(status)
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

// Portless resolves ~ from its own HOME, which a command's env can override.
function portlessStateDir(environment: NodeJS.ProcessEnv) {
  const home = environment["HOME"] || os.homedir()
  return environment["PORTLESS_STATE_DIR"] ? resolveHome(environment["PORTLESS_STATE_DIR"], home) : path.join(home, ".portless")
}

// Portless marks an HTTPS proxy by the presence of proxy.tls.
async function portlessUsesTls(environment: NodeJS.ProcessEnv) {
  return existsAt(path.join(portlessStateDir(environment), "proxy.tls"))
}
