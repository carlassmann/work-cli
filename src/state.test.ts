import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { readWorkspaceState, writeWorkspaceState } from "./state.js"
import { tempDir } from "./test-helpers.js"
import type { WorkspaceState } from "./types.js"

const previousStateRoot = process.env["WORK_STATE_ROOT"]

beforeEach(async () => {
  process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
})

afterEach(() => {
  process.env["WORK_STATE_ROOT"] = previousStateRoot
})

describe("readWorkspaceState", () => {
  test("returns ok(null) for missing state", async () => {
    const result = await readWorkspaceState("demo", "feature-x")
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value, null)
  })

  test("returns ok(state) after a successful write", async () => {
    const state: WorkspaceState = {
      project: "demo",
      workspace: "feature-x",
      branch: "feature-x",
      root: "/tmp",
      commands: {},
    }

    const write = await writeWorkspaceState(state)
    assert.equal(write.ok, true)

    const read = await readWorkspaceState("demo", "feature-x")
    assert.equal(read.ok, true)
    if (read.ok) assert.deepEqual(read.value, state)
  })

  test("returns IOError for corrupt JSON", async () => {
    const stateRoot = process.env["WORK_STATE_ROOT"] as string
    const dir = path.join(stateRoot, "projects", "demo", "workspaces", "feature-x")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "state.json"), "{ not valid json")

    const result = await readWorkspaceState("demo", "feature-x")

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.tag, "IOError")
      assert.match(result.error.message, /state file is corrupt/)
    }
  })
})

describe("writeWorkspaceState", () => {
  test("write is atomic (temp file is gone after write)", async () => {
    const stateRoot = process.env["WORK_STATE_ROOT"] as string
    const state: WorkspaceState = {
      project: "demo",
      workspace: "feature-x",
      branch: "feature-x",
      root: "/tmp",
      commands: {},
    }

    await writeWorkspaceState(state)

    const dir = path.join(stateRoot, "projects", "demo", "workspaces", "feature-x")
    const entries = await fs.readdir(dir)
    const stragglers = entries.filter((entry) => entry.startsWith("state.json.tmp"))
    assert.deepEqual(stragglers, [])
  })
})
