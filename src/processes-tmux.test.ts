import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { commandDisplayStatus, commandRuntimeStatus, startAdhocCommand, stopCommand } from "./processes.js"
import { readWorkspaceState } from "./state.js"
import { tempDir } from "./test-helpers.js"
import type { DevConfig, WorkspaceRecord } from "./types.js"

const fakeBin = path.resolve(import.meta.dirname, "test-fixtures/tmux-fake.sh")

const config: DevConfig = {
  project: "tilly",
  commands: {},
}

const workspace: WorkspaceRecord = {
  project: "tilly",
  workspace: "feature-x",
  branch: "feature-x",
  root: "/",
}

const previousTmuxBin = process.env["WORK_TMUX_BIN"]
const previousTmuxState = process.env["WORK_TMUX_STATE_DIR"]
const previousStateRoot = process.env["WORK_STATE_ROOT"]

beforeEach(async () => {
  process.env["WORK_TMUX_BIN"] = fakeBin
  process.env["WORK_TMUX_STATE_DIR"] = await tempDir("tmux-fake-")
  process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
})

afterEach(() => {
  process.env["WORK_TMUX_BIN"] = previousTmuxBin
  process.env["WORK_TMUX_STATE_DIR"] = previousTmuxState
  process.env["WORK_STATE_ROOT"] = previousStateRoot
})

describe("tmux integration (fake)", () => {
  test("two ad-hoc commands share one tmux session as windows", async () => {
    const root = await tempDir()
    const ws: WorkspaceRecord = { ...workspace, root }

    const first = await startAdhocCommand(config, ws, "one", ["sleep", "30"])
    const second = await startAdhocCommand(config, ws, "two", ["sleep", "30"])

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    if (!first.ok || !second.ok) return

    assert.equal(first.value.record.tmuxSession, "work-tilly-feature-x")
    assert.equal(second.value.record.tmuxSession, "work-tilly-feature-x")
    assert.equal(first.value.record.tmuxWindow, "one")
    assert.equal(second.value.record.tmuxWindow, "two")
  })

  test("starts tmux commands for multiple workspaces in parallel", async () => {
    const root = await tempDir()
    const featureX: WorkspaceRecord = { ...workspace, workspace: "feature-x", branch: "feature-x", root: path.join(root, "feature-x") }
    const featureY: WorkspaceRecord = { ...workspace, workspace: "feature-y", branch: "feature-y", root: path.join(root, "feature-y") }

    await fs.mkdir(featureX.root, { recursive: true })
    await fs.mkdir(featureY.root, { recursive: true })

    const [startedX, startedY] = await Promise.all([
      startAdhocCommand(config, featureX, "agent", ["sleep", "30"]),
      startAdhocCommand(config, featureY, "agent", ["sleep", "30"]),
    ])

    assert.equal(startedX.ok, true)
    assert.equal(startedY.ok, true)
    if (!startedX.ok || !startedY.ok) return

    assert.equal(startedX.value.started, true)
    assert.equal(startedY.value.started, true)
    assert.equal(startedX.value.record.tmuxSession, "work-tilly-feature-x")
    assert.equal(startedY.value.record.tmuxSession, "work-tilly-feature-y")
    assert.equal(startedX.value.record.tmuxWindow, "agent")
    assert.equal(startedY.value.record.tmuxWindow, "agent")
    assert.equal(await commandRuntimeStatus(startedX.value.record), "up")
    assert.equal(await commandRuntimeStatus(startedY.value.record), "up")

    const stateX = await readWorkspaceState("tilly", "feature-x")
    const stateY = await readWorkspaceState("tilly", "feature-y")
    assert.equal(stateX.ok, true)
    assert.equal(stateY.ok, true)
    if (!stateX.ok || !stateY.ok) return

    assert.equal(stateX.value?.commands["agent"]?.runner, "tmux")
    assert.equal(stateY.value?.commands["agent"]?.runner, "tmux")

    const calls = await fs.readFile(path.join(process.env["WORK_TMUX_STATE_DIR"] as string, "calls.log"), "utf8")
    assert.ok(calls.includes("new-session -d -s work-tilly-feature-x"))
    assert.ok(calls.includes("new-session -d -s work-tilly-feature-y"))
  })

  test("stopping one command kills its window but keeps the session", async () => {
    const root = await tempDir()
    const ws: WorkspaceRecord = { ...workspace, root }

    await startAdhocCommand(config, ws, "one", ["sleep", "30"])
    await startAdhocCommand(config, ws, "two", ["sleep", "30"])

    const stop = await stopCommand("tilly", "feature-x", "one")
    assert.equal(stop.ok, true)
    if (stop.ok) assert.equal(stop.value, true)

    const stateResult = await readWorkspaceState("tilly", "feature-x")
    assert.equal(stateResult.ok, true)
    if (!stateResult.ok) return
    const state = stateResult.value
    assert.equal(state?.commands["one"], undefined)
    const two = state?.commands["two"]
    assert.ok(two)
    assert.equal(await commandRuntimeStatus(two), "up")
  })

  test("stopping the last command ends the session", async () => {
    const root = await tempDir()
    const ws: WorkspaceRecord = { ...workspace, root }

    const started = await startAdhocCommand(config, ws, "only", ["sleep", "30"])
    assert.equal(started.ok, true)
    if (!started.ok) return

    await stopCommand("tilly", "feature-x", "only")
    assert.equal(await commandRuntimeStatus(started.value.record), "dead")
  })

  test("idempotent start returns the existing record", async () => {
    const root = await tempDir()
    const ws: WorkspaceRecord = { ...workspace, root }

    const first = await startAdhocCommand(config, ws, "one", ["sleep", "30"])
    const second = await startAdhocCommand(config, ws, "one", ["sleep", "30"])
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    if (!first.ok || !second.ok) return

    assert.equal(first.value.started, true)
    assert.equal(second.value.started, false)
    assert.equal(second.value.record.tmuxWindow, first.value.record.tmuxWindow)
  })

  test("records pipe-pane call for log capture", async () => {
    const root = await tempDir()
    const ws: WorkspaceRecord = { ...workspace, root }

    await startAdhocCommand(config, ws, "one", ["sleep", "30"])

    const calls = await fs.readFile(path.join(process.env["WORK_TMUX_STATE_DIR"] as string, "calls.log"), "utf8")
    assert.ok(calls.includes("pipe-pane"), `expected pipe-pane in calls, got:\n${calls}`)
    assert.ok(calls.includes("new-session"))
  })

  test("tmux display status uses recent log activity", async () => {
    const root = await tempDir()
    const ws: WorkspaceRecord = { ...workspace, root }

    const started = await startAdhocCommand(config, ws, "one", ["sleep", "30"])
    assert.equal(started.ok, true)
    if (!started.ok) return

    assert.equal(await commandDisplayStatus(started.value.record), "idle")

    await fs.writeFile(started.value.record.log, "working\n")

    assert.equal(await commandDisplayStatus(started.value.record), "busy")
  })
})
