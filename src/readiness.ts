import fs from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import { StringDecoder } from "node:string_decoder"
import { setTimeout } from "node:timers/promises"
import { forEachLogChunk, isMarkerLine } from "./logs.js"
import { describe, errResult, ok, tryAsync } from "./result.js"
import type { Result } from "./result.js"

const PROBE_TIMEOUT_MS = 5_000
const RETRY_DELAY_MS = 250
// A probe with less time than this can only time out, and would hide the last real answer.
const MIN_PROBE_MS = 100

export async function waitForUrl(
  url: string,
  timeoutMs: number,
  isAlive: () => Promise<boolean> = async () => true,
): Promise<Result<void>> {
  const deadline = performance.now() + timeoutMs
  let lastCheck = "no response"

  while (true) {
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
    if (remaining < RETRY_DELAY_MS + MIN_PROBE_MS) break
    await setTimeout(RETRY_DELAY_MS)
  }

  return errResult("ProcessError", `${url} was not ready within ${timeoutMs / 1_000}s. Last check: ${lastCheck}`)
}

const MAX_PENDING_CHARS = 64 * 1024

// Matches each line of the current run, so output from earlier runs in the same file never counts.
// currentRun names the run, so a restart that writes to a new file at the same offset still resets the reader.
export async function waitForLog(
  file: string,
  pattern: RegExp,
  timeoutMs: number,
  currentRun: () => Promise<Result<{ id: string; offset: number }>>,
  isAlive: () => Promise<boolean> = async () => true,
): Promise<Result<string>> {
  const deadline = performance.now() + timeoutMs
  const matches = (line: string) => !isMarkerLine(line) && pattern.test(line)
  let reading: { run: string; inode: number } | undefined
  let position = 0
  let pending = ""
  let decoder = new StringDecoder("utf8")

  while (performance.now() < deadline) {
    const run = await currentRun()
    if (!run.ok) return run
    const stat = await tryAsync("IOError", `failed to read log ${file}`, async () => await fs.stat(file))
    if (!stat.ok) return stat
    if (reading?.run !== run.value.id || reading.inode !== stat.value.ino || stat.value.size < position) {
      reading = { run: run.value.id, inode: stat.value.ino }
      position = run.value.offset <= stat.value.size ? run.value.offset : 0
      pending = ""
      decoder = new StringDecoder("utf8")
    }

    let match: string | undefined
    const read = await forEachLogChunk(file, position, (chunk) => {
      const lines = (pending + decoder.write(chunk)).split("\n")
      pending = lines.pop() ?? ""
      match = lines.map(stripAnsi).find(matches)
      if (match === undefined && pending.length > MAX_PENDING_CHARS) {
        // Test an over-long partial line before dropping its start; the kept tail still catches a match split across chunks.
        match = [pending].map(stripAnsi).find(matches)
        pending = pending.slice(-MAX_PENDING_CHARS)
      }
      return match !== undefined
    })
    if (!read.ok) return read
    position = read.value
    match ??= [pending].map(stripAnsi).find(matches)

    if (!await isAlive()) {
      return errResult("ProcessError", match === undefined ? `stopped before its log matched ${pattern}` : `logged ${pattern} but stopped`)
    }
    if (match !== undefined) return ok(match)
    const remaining = deadline - performance.now()
    if (remaining > 0) await setTimeout(Math.min(RETRY_DELAY_MS, remaining))
  }

  return errResult("ProcessError", `log did not match ${pattern} within ${timeoutMs / 1_000}s`)
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

function stripAnsi(line: string) {
  return line.replace(ANSI_ESCAPE, "")
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
