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
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(PROBE_TIMEOUT_MS, deadline - performance.now())))),
      })
      await response.body?.cancel()
      if (response.status >= 200 && response.status < 400) return ok(undefined)
      lastCheck = `HTTP ${response.status}`
    } catch (cause) {
      lastCheck = cause instanceof Error && cause.cause instanceof Error ? cause.cause.message : describe(cause)
    }

    if (!await isAlive()) return errResult("ProcessError", `${url} stopped before it was ready. Last check: ${lastCheck}`)
    const remaining = deadline - performance.now()
    if (remaining > 0) await setTimeout(Math.min(RETRY_DELAY_MS, remaining))
  }

  return errResult("ProcessError", `${url} was not ready within ${timeoutMs / 1_000}s. Last check: ${lastCheck}`)
}
