import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { appError, err, errResult, ok, tryAsync, trySync } from "./result.js"

describe("result", () => {
  test("ok wraps a value", () => {
    const r = ok(42)
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.value, 42)
  })

  test("err wraps an error", () => {
    const r = err(appError("ConfigError", "boom"))
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.tag, "ConfigError")
  })

  test("trySync captures throws", () => {
    const r = trySync("IOError", "while reading", () => {
      throw new Error("boom")
    })

    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.error.tag, "IOError")
      assert.match(r.error.message, /while reading: boom/)
    }
  })

  test("trySync returns ok on success", () => {
    const r = trySync("IOError", "x", () => 7)
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.value, 7)
  })

  test("tryAsync captures rejections", async () => {
    const r = await tryAsync("DaemonError", "while pinging", async () => {
      throw new Error("EPIPE")
    })

    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.error.tag, "DaemonError")
      assert.match(r.error.message, /while pinging: EPIPE/)
    }
  })

  test("errResult is a shortcut", () => {
    const r = errResult("CLIError", "bad")
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.message, "bad")
  })
})
