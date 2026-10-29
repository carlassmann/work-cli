import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { waitForUrl } from "./readiness.js"

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

test("stops waiting once the command is gone", async () => {
  const startedAt = performance.now()
  const stopped = await waitForUrl("http://127.0.0.1:1", 10_000, async () => false)
  assert.equal(stopped.ok, false)
  if (!stopped.ok) assert.match(stopped.error.message, /stopped before it was ready/)
  assert.ok(performance.now() - startedAt < 1_000)
})
