import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { createServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { startMarker } from "./logs.js"
import { waitForLog, waitForUrl } from "./readiness.js"
import { ok } from "./result.js"

test("waits through startup errors, accepts redirects, and bounds failed or hung probes", async (t) => {
  let attempts = 0
  const server = createServer((request, response) => {
    if (request.url === "/hang") return
    const status = request.url === "/redirect" ? 302
      : request.url === "/retry" && ++attempts > 1 ? 200 : 503
    response.writeHead(status, { location: "http://127.0.0.1:1/login" }).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`

  assert.equal((await waitForUrl(`${url}/retry`, 2_000)).ok, true)
  assert.equal(attempts, 2)
  assert.equal((await waitForUrl(`${url}/redirect`, 1_000)).ok, true)

  const failure = await waitForUrl(`${url}/failed`, 100)
  assert.equal(failure.ok, false)
  if (!failure.ok) assert.match(failure.error.message, /not ready within 0.1s.*HTTP 503/)

  const startedAt = performance.now()
  assert.equal((await waitForUrl(`${url}/hang`, 100)).ok, false)
  assert.ok(performance.now() - startedAt < 1_000)
  assert.equal((await waitForUrl("http://127.0.0.1:1", 50)).ok, false)
})

test("reports which connections a refused probe tried", async () => {
  const failure = await waitForUrl("http://localhost:1", 100)
  assert.equal(failure.ok, false)
  if (!failure.ok) assert.match(failure.error.message, /Last check: connect ECONNREFUSED (::1|127\.0\.0\.1):1/)
})

test("keeps the last answer instead of probing with almost no time left", async (t) => {
  let requests = 0
  const server = createServer((_request, response) => {
    if (++requests === 1) response.writeHead(503).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== "string")

  const failure = await waitForUrl(`http://127.0.0.1:${address.port}`, 300)
  assert.equal(failure.ok, false)
  if (!failure.ok) assert.match(failure.error.message, /Last check: HTTP 503$/)
  assert.equal(requests, 1)
})

test("stops waiting once the command is gone", async () => {
  const startedAt = performance.now()
  const stopped = await waitForUrl("http://127.0.0.1:1", 10_000, async () => false)
  assert.equal(stopped.ok, false)
  if (!stopped.ok) assert.match(stopped.error.message, /stopped before it was ready/)
  assert.ok(performance.now() - startedAt < 1_000)
})

test("does not accept a response once the command is gone", async (t) => {
  const server = createServer((_request, response) => response.writeHead(200).end())
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== "string")

  const result = await waitForUrl(`http://127.0.0.1:${address.port}`, 1_000, async () => false)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error.message, /stopped before it was ready.*HTTP 200/)
})

test("accepts self-signed certificates on loopback hosts", async (t) => {
  const { cert, key } = selfSignedCertificate()
  const server = createHttpsServer({ cert, key }, (_request, response) => response.writeHead(200).end())
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== "string")

  assert.equal((await waitForUrl(`https://127.0.0.1:${address.port}`, 2_000)).ok, true)
})

test("waits for a log line in the current run only", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "work-cli-log-")), "convex.log")
  const previous = `${startMarker("convex", "2026-11-02T10:00:00.000Z")}\u001b[32m✔ ready\u001b[0m\n`
  fs.writeFileSync(file, `${previous}${startMarker("convex", "2026-11-02T11:00:00.000Z")}starting\n`)
  const runStart = async () => ok({ id: "current", offset: Buffer.byteLength(previous) })

  const timedOut = await waitForLog(file, /ready/, 300, runStart)
  assert.equal(timedOut.ok, false)
  if (!timedOut.ok) assert.match(timedOut.error.message, /log did not match \/ready\/ within 0.3s/)

  const marker = await waitForLog(file, /convex/, 300, runStart)
  assert.equal(marker.ok, false)

  setTimeout(() => fs.appendFileSync(file, "\u001b[32m✔\u001b[0m ready in 2.1s\n"), 100)
  assert.deepEqual(await waitForLog(file, /^✔ ready/, 2_000, runStart), { ok: true, value: "✔ ready in 2.1s" })
})

test("starts over when a new run or a new file begins at the same offset", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-cli-log-"))
  const file = path.join(dir, "convex.log")
  const longOldRun = `${startMarker("convex", "2026-11-02T10:00:00.000Z")}${"booting ".repeat(20)}`

  // A restart truncates and rewrites the same file: only the run id changes.
  fs.writeFileSync(file, longOldRun)
  let id = "first"
  setTimeout(() => {
    id = "second"
    fs.writeFileSync(file, `${startMarker("convex", "2026-11-02T11:00:00.000Z")}READY\n${"x".repeat(400)}\n`)
  }, 300)
  assert.deepEqual(await waitForLog(file, /^READY$/, 3_000, async () => ok({ id, offset: 0 })), { ok: true, value: "READY" })

  // Rotation moves the old file away: the run id stays, the inode changes.
  fs.writeFileSync(file, longOldRun)
  setTimeout(() => {
    fs.renameSync(file, `${file}.1`)
    fs.writeFileSync(file, `${startMarker("convex", "2026-11-02T12:00:00.000Z")}READY\n${"x".repeat(400)}\n`)
  }, 300)
  assert.deepEqual(await waitForLog(file, /^READY$/, 3_000, async () => ok({ id: "same", offset: 0 })), { ok: true, value: "READY" })

  // A shorter file at the same inode and run id: the reader would sit past its end.
  fs.writeFileSync(file, longOldRun)
  setTimeout(() => fs.writeFileSync(file, "READY\n"), 300)
  assert.deepEqual(await waitForLog(file, /^READY$/, 3_000, async () => ok({ id: "same", offset: 0 })), { ok: true, value: "READY" })
})

test("matches inside a line longer than the pending buffer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-cli-log-"))
  const file = path.join(dir, "convex.log")
  const run = async () => ok({ id: "run", offset: 0 })

  fs.writeFileSync(file, `READY${"x".repeat(200_000)}\n`)
  const long = await waitForLog(file, /READY/, 1_000, run)
  assert.ok(long.ok && long.value.startsWith("READYxxx"))

  // The token straddles the second 64 KB chunk boundary, after the pending buffer was already trimmed once.
  fs.writeFileSync(file, `${"x".repeat(2 * 64 * 1024 - 2)}READY${"x".repeat(200_000)}`)
  const split = await waitForLog(file, /READY/, 1_000, run)
  assert.equal(split.ok, true)

  fs.writeFileSync(file, `${"x".repeat(300_000)}\n`)
  assert.equal((await waitForLog(file, /READY/, 300, run)).ok, false)
})

test("stops waiting for a log line once the command is gone", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "work-cli-log-")), "convex.log")
  fs.writeFileSync(file, "booting\n")

  const stopped = await waitForLog(file, /ready/, 10_000, async () => ok({ id: "run", offset: 0 }), async () => false)
  assert.equal(stopped.ok, false)
  if (!stopped.ok) assert.match(stopped.error.message, /stopped before its log matched \/ready\//)

  fs.appendFileSync(file, "ready\n")
  const crashed = await waitForLog(file, /ready/, 10_000, async () => ok({ id: "run", offset: 0 }), async () => false)
  assert.equal(crashed.ok, false)
  if (!crashed.ok) assert.match(crashed.error.message, /logged \/ready\/ but stopped/)
})

function selfSignedCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-cli-cert-"))
  const keyFile = path.join(dir, "key.pem")
  const certFile = path.join(dir, "cert.pem")
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" })
  const credentials = { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
  fs.rmSync(dir, { recursive: true, force: true })
  return credentials
}
