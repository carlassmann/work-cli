import http from "node:http"
import https from "node:https"
import { setTimeout } from "node:timers/promises"
import { describe, errResult, ok } from "./result.js"
import type { Result } from "./result.js"

const PROBE_TIMEOUT_MS = 5_000
const RETRY_DELAY_MS = 250

export async function waitForUrl(
  url: string,
  timeoutMs: number,
  isAlive: () => Promise<boolean> = async () => true,
): Promise<Result<void>> {
  const deadline = performance.now() + timeoutMs
  let lastCheck = "no response"

  while (performance.now() < deadline) {
    let status: number | null = null
    try {
      status = await probeStatus(url, Math.max(1, Math.ceil(Math.min(PROBE_TIMEOUT_MS, deadline - performance.now()))))
      lastCheck = `HTTP ${status}`
    } catch (cause) {
      lastCheck = describe(cause)
    }

    // Check liveness before accepting a response, so an orphaned server on the same route cannot pass for the command.
    if (!await isAlive()) return errResult("ProcessError", `${url} stopped before it was ready. Last check: ${lastCheck}`)
    if (status !== null && status >= 200 && status < 400) return ok(undefined)
    const remaining = deadline - performance.now()
    if (remaining > 0) await setTimeout(Math.min(RETRY_DELAY_MS, remaining))
  }

  return errResult("ProcessError", `${url} was not ready within ${timeoutMs / 1_000}s. Last check: ${lastCheck}`)
}

function probeStatus(url: string, timeoutMs: number): Promise<number> {
  const target = new URL(url)
  const client = target.protocol === "https:" ? https : http
  return new Promise((resolve, reject) => {
    const request = client.get(target, {
      timeout: timeoutMs,
      // Portless signs *.localhost with its own CA, which Node does not trust by default; the hop stays on loopback.
      rejectUnauthorized: !isLoopbackHost(target.hostname),
    }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on("timeout", () => request.destroy(new Error(`no response within ${timeoutMs}ms`)))
    request.on("error", reject)
  })
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]"
}
