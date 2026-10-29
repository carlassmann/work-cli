import fs from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { existsAt, resolveHome } from "./shell.js"

const PROBE_TIMEOUT_MS = 2_000

export type PortlessProxyState = "ok" | "stopped" | "foreign"

// Mirrors how Portless finds its own proxy: PORTLESS_PORT, then the port it recorded.
export async function portlessPort(environment: NodeJS.ProcessEnv) {
  const fromEnvironment = Number(environment["PORTLESS_PORT"])
  if (isPort(fromEnvironment)) return fromEnvironment
  try {
    const recorded = Number((await fs.readFile(path.join(portlessStateDir(environment), "proxy.port"), "utf8")).trim())
    if (isPort(recorded)) return recorded
  } catch {}
  return 443
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

function portlessStateDir(environment: NodeJS.ProcessEnv) {
  return environment["PORTLESS_STATE_DIR"] ? resolveHome(environment["PORTLESS_STATE_DIR"]) : path.join(os.homedir(), ".portless")
}

// Portless marks an HTTPS proxy by the presence of proxy.tls.
async function portlessUsesTls(environment: NodeJS.ProcessEnv) {
  return existsAt(path.join(portlessStateDir(environment), "proxy.tls"))
}
