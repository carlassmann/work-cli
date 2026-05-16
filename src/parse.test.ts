import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { booleanFlag, parseArgs, valueFlag } from "./parse.js"

describe("parseArgs", () => {
  test("collects positionals", () => {
    const result = parseArgs(["a", "b", "c"])
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual([...result.value.positional], ["a", "b", "c"])
      assert.equal(result.value.rest, null)
    }
  })

  test("boolean flags default to false", () => {
    const result = parseArgs([], { flags: { follow: booleanFlag("f") } })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.flags.follow, false)
  })

  test("boolean flags become true when present", () => {
    const result = parseArgs(["--follow", "x"], { flags: { follow: booleanFlag("f") } })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.flags.follow, true)
      assert.deepEqual([...result.value.positional], ["x"])
    }
  })

  test("value flags consume next arg", () => {
    const result = parseArgs(["--workspace", "feature-x", "web"], {
      flags: { workspace: valueFlag("w") },
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.flags.workspace, "feature-x")
      assert.deepEqual([...result.value.positional], ["web"])
    }
  })

  test("value flags default to undefined when omitted", () => {
    const result = parseArgs([], { flags: { workspace: valueFlag("w") } })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.flags.workspace, undefined)
  })

  test("aliases resolve to full names", () => {
    const result = parseArgs(["-w", "feature-x", "-f", "web"], {
      flags: { workspace: valueFlag("w"), follow: booleanFlag("f") },
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.flags.workspace, "feature-x")
      assert.equal(result.value.flags.follow, true)
      assert.deepEqual([...result.value.positional], ["web"])
    }
  })

  test("rest collects args after -- when acceptRest is true", () => {
    const result = parseArgs(["claude", "--", "claude", "--debug"], { acceptRest: true })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual([...result.value.positional], ["claude"])
      assert.deepEqual([...(result.value.rest ?? [])], ["claude", "--debug"])
    }
  })

  test("-- without acceptRest is treated as end-of-flags marker", () => {
    const result = parseArgs(["foo", "--", "-bar"])
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual([...result.value.positional], ["foo", "-bar"])
      assert.equal(result.value.rest, null)
    }
  })

  test("rejects unknown flags", () => {
    const result = parseArgs(["--nope"])
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /unknown flag: --nope/)
  })

  test("rejects value flags without a value", () => {
    const result = parseArgs(["--workspace"], { flags: { workspace: valueFlag() } })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /missing value for --workspace/)
  })
})
