import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { commandRuntimeStatus, pruneDeadCommands, startCommand, stopCommand } from "./processes.js"
import { listWorkspaceStates, readWorkspaceState, writeWorkspaceState } from "./state.js"
import { tempDir } from "./test-helpers.js"
import type { DevConfig, WorkspaceRecord, WorkspaceState } from "./types.js"

const previousStateRoot = process.env["WORK_STATE_ROOT"]

afterEach(() => {
  process.env["WORK_STATE_ROOT"] = previousStateRoot
})

describe("process lifecycle", () => {
  test("starts, records, and stops a configured command", async () => {
    const root = await tempDir()
    const workspace = testWorkspace(root)
    const config = testConfig("node -e 'setTimeout(() => {}, 30000)'")

    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")

    const started = await startCommand(config, workspace, "web")
    assert.equal(started.ok, true)
    if (!started.ok) return

    const repeated = await startCommand(config, workspace, "web")
    assert.equal(repeated.ok, true)
    if (!repeated.ok) return

    assert.equal(started.value.started, true)
    assert.equal(repeated.value.started, false)
    assert.equal(await commandRuntimeStatus(started.value.record), "up")

    const afterStart = await readWorkspaceState("tilly", "feature-x")
    assert.equal(afterStart.ok, true)
    if (afterStart.ok) assert.equal(afterStart.value?.commands["web"]?.runner, "process")

    const stop = await stopCommand("tilly", "feature-x", "web")
    assert.equal(stop.ok, true)
    if (stop.ok) assert.equal(stop.value, true)

    const afterStop = await readWorkspaceState("tilly", "feature-x")
    assert.equal(afterStop.ok, true)
    if (afterStop.ok) assert.equal(afterStop.value?.commands["web"], undefined)
  })

  test("starts detached commands for multiple workspaces in parallel", async () => {
    const root = await tempDir()
    const config = testConfig("node -e 'setTimeout(() => {}, 30000)'")
    const featureX = testWorkspace(path.join(root, "feature-x"), "feature-x")
    const featureY = testWorkspace(path.join(root, "feature-y"), "feature-y")

    await Promise.all([
      fs.mkdir(featureX.root, { recursive: true }),
      fs.mkdir(featureY.root, { recursive: true }),
    ])

    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")

    const [startedX, startedY] = await Promise.all([
      startCommand(config, featureX, "web"),
      startCommand(config, featureY, "web"),
    ])

    assert.equal(startedX.ok, true)
    assert.equal(startedY.ok, true)
    if (!startedX.ok || !startedY.ok) return

    assert.equal(startedX.value.started, true)
    assert.equal(startedY.value.started, true)
    assert.notEqual(startedX.value.record.pid, startedY.value.record.pid)
    assert.equal(await commandRuntimeStatus(startedX.value.record), "up")
    assert.equal(await commandRuntimeStatus(startedY.value.record), "up")

    const stateX = await readWorkspaceState("tilly", "feature-x")
    const stateY = await readWorkspaceState("tilly", "feature-y")
    assert.equal(stateX.ok, true)
    assert.equal(stateY.ok, true)
    if (!stateX.ok || !stateY.ok) return

    assert.equal(stateX.value?.commands["web"]?.runner, "process")
    assert.equal(stateY.value?.commands["web"]?.runner, "process")

    await stopCommand("tilly", "feature-x", "web")
    await stopCommand("tilly", "feature-y", "web")
  })

  test("prunes dead command records", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")

    const write = await writeWorkspaceState({
      ...testWorkspace(root),
      commands: {
        web: {
          id: "web",
          label: "web",
          runner: "process",
          pid: 99999999,
          command: "already gone",
          cwd: root,
          log: path.join(root, "web.log"),
          url: null,
          startedAt: new Date().toISOString(),
        },
      },
    } satisfies WorkspaceState)
    assert.equal(write.ok, true)

    const pruned = await pruneDeadCommands()
    assert.equal(pruned.ok, true)
    if (pruned.ok) assert.equal(pruned.value, 1)
    assert.deepEqual((await listWorkspaceStates())[0]?.commands, {})
  })
})

function testWorkspace(root: string, workspace = "feature-x"): WorkspaceRecord {
  return {
    project: "tilly",
    workspace,
    branch: workspace,
    root,
  }
}

function testConfig(command: string): DevConfig {
  return {
    project: "tilly",
    commands: {
      web: {
        run: command,
      },
    },
  }
}
