import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { booleanFlag, parseArgs, splitWorkspaceCommands, valueFlag } from "./parse.js"

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

  test("combined boolean aliases resolve to full names", () => {
    const result = parseArgs(["-af"], {
      flags: { all: booleanFlag("a"), follow: booleanFlag("f") },
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.flags.all, true)
      assert.equal(result.value.flags.follow, true)
    }
  })

  test("value flags accept equals syntax", () => {
    const result = parseArgs(["--workspace=feature-x"], {
      flags: { workspace: valueFlag("w") },
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.flags.workspace, "feature-x")
  })

  test("value flags preserve equals in inline values", () => {
    const result = parseArgs(["--workspace=fix=a"], {
      flags: { workspace: valueFlag("w") },
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.flags.workspace, "fix=a")
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

  test("rejects flag-looking value flag values", () => {
    const long = parseArgs(["--workspace", "-f"], { flags: { workspace: valueFlag("w"), follow: booleanFlag("f") } })
    assert.equal(long.ok, false)
    if (!long.ok) assert.match(long.error.message, /missing value for --workspace/)

    const short = parseArgs(["-w", "-f"], { flags: { workspace: valueFlag("w"), follow: booleanFlag("f") } })
    assert.equal(short.ok, false)
    if (!short.ok) assert.match(short.error.message, /missing value for -w/)
  })

  test("rejects empty value flag values", () => {
    const result = parseArgs(["--workspace="], { flags: { workspace: valueFlag("w") } })

    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /missing value for --workspace/)
  })
})

describe("splitWorkspaceCommands", () => {
  test("reads a single positional as a command", () => {
    assert.deepEqual(splitWorkspaceCommands(["web"], undefined, false), { workspace: undefined, commands: ["web"] })
  })

  test("reads the first of several positionals as the workspace by default", () => {
    assert.deepEqual(splitWorkspaceCommands(["feature-x", "web", "api"], undefined, false), { workspace: "feature-x", commands: ["web", "api"] })
  })

  test("reads every positional as a command when the first names only a command", () => {
    assert.deepEqual(splitWorkspaceCommands(["web", "api"], undefined, true), { workspace: undefined, commands: ["web", "api"] })
  })

  test("reads every positional as a command when -w names the workspace", () => {
    assert.deepEqual(splitWorkspaceCommands(["web", "api"], "feature-x", false), { workspace: "feature-x", commands: ["web", "api"] })
  })

  test("drops repeated commands", () => {
    assert.deepEqual(splitWorkspaceCommands(["web", "web"], "feature-x", false), { workspace: "feature-x", commands: ["web"] })
  })
})
