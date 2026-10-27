import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { RequestListener } from "node:http"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import { waitForUrl } from "./readiness.js"

async function serve(t: TestContext, listener: RequestListener): Promise<string> {
  const server = createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}`
}

describe("HTTP readiness", () => {
  test("waits through startup errors until the URL responds successfully", async (t) => {
    let requests = 0
    const url = await serve(t, (_request, response) => {
      response.writeHead(++requests === 1 ? 503 : 200)
      response.end()
    })

    const result = await waitForUrl(url, 2_000)

    assert.equal(result.ok, true)
    assert.equal(requests, 2)
  })

  test("accepts redirects without following them to another service", async (t) => {
    const url = await serve(t, (_request, response) => {
      response.writeHead(302, { location: "http://127.0.0.1:1/login" })
      response.end()
    })

    assert.equal((await waitForUrl(url, 1_000)).ok, true)
  })

  test("reports the last HTTP failure when the timeout expires", async (t) => {
    const url = await serve(t, (_request, response) => {
      response.writeHead(500)
      response.end()
    })

    const result = await waitForUrl(url, 100)

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error.message, /not ready within 0.1s/)
      assert.match(result.error.message, /HTTP 500/)
    }
  })

  test("bounds a request that never returns response headers", async (t) => {
    const url = await serve(t, () => {})
    const startedAt = performance.now()

    const result = await waitForUrl(url, 100)

    assert.equal(result.ok, false)
    assert.ok(performance.now() - startedAt < 1_000)
  })

  test("returns a diagnostic for connection failures", async () => {
    const result = await waitForUrl("http://127.0.0.1:1", 50)

    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /Last check:/)
  })
})
