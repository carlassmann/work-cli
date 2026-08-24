import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { commandRuntimeStatus, pruneDeadCommands, startCommand, stopCommand } from "./processes.js"
import { listWorkspaceStates, readWorkspaceState, writeWorkspaceState } from "./state.js"
import { tempDir } from "./test-helpers.js"
import type { DevConfig, WorkspaceRecord, WorkspaceState } from "./types.js"

const previousStateRoot = process.env["WORK_STATE_ROOT"]
const previousPath = process.env["PATH"]

afterEach(() => {
  process.env["WORK_STATE_ROOT"] = previousStateRoot
  process.env["PATH"] = previousPath
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
    if (afterStart.ok) assert.equal(afterStart.value?.commands["web"]?.pid, started.value.record.pid)

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

    assert.equal(stateX.value?.commands["web"]?.pid, startedX.value.record.pid)
    assert.equal(stateY.value?.commands["web"]?.pid, startedY.value.record.pid)

    await stopCommand("tilly", "feature-x", "web")
    await stopCommand("tilly", "feature-y", "web")
  })

  test("passes route URLs to configured commands", async () => {
    const root = await tempDir()
    const workspace = testWorkspace(root)
    const output = path.join(root, "env.json")
    const command = `node -e 'require("fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({ web: process.env.WORK_WEB_URL, sync: process.env.WORK_SYNC_URL, syncWs: process.env.WORK_SYNC_WS_URL, urls: process.env.WORK_URLS, workspaceValue: process.env.WORKSPACE_VALUE, credentials: process.env.WORK_CLOUDFLARE_CREDENTIALS }))'`
    const config: DevConfig = {
      project: "tilly",
      env: {
        WORKSPACE_VALUE: "configured",
        WORK_CLOUDFLARE_CREDENTIALS: "must-not-leak",
      },
      commands: {
        web: {
          run: command,
          route: true,
          portless: false,
        },
        sync: {
          run: "echo sync",
          route: true,
        },
      },
    }

    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")

    const started = await startCommand(config, workspace, "web")
    assert.equal(started.ok, true)

    const env = JSON.parse(await readSoon(output))
    assert.deepEqual(env, {
      web: "https://web-feature-x-tilly.localhost",
      sync: "https://sync-feature-x-tilly.localhost",
      syncWs: "wss://sync-feature-x-tilly.localhost",
      workspaceValue: "configured",
      urls: JSON.stringify({
        web: "https://web-feature-x-tilly.localhost",
        sync: "https://sync-feature-x-tilly.localhost",
      }),
    })

    const state = await readWorkspaceState("tilly", "feature-x")
    assert.deepEqual(state.ok ? state.value?.env : undefined, { WORKSPACE_VALUE: "configured" })
  })

  test("keeps one Cloudflare connector synchronized with routed processes", async () => {
    const root = await tempDir()
    const bin = await tempDir("work-cli-bin-")
    const trace = path.join(root, "cloudflared.trace")
    const portless = path.join(bin, "portless")
    const cloudflared = path.join(bin, "cloudflared")
    const tunnelId = "11111111-1111-4111-8111-111111111111"
    const credentialsFile = path.join(root, `${tunnelId}.json`)

    await fs.writeFile(portless, `#!/bin/sh
while [ "$1" != "sh" ]; do shift; done
exec "$@"
`)
    await fs.writeFile(cloudflared, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(trace)}
if [ "$2" = "route" ]; then exit 0; fi
trap 'exit 0' TERM INT
while :; do sleep 1; done
`)
    await fs.chmod(portless, 0o755)
    await fs.chmod(cloudflared, 0o755)
    await fs.writeFile(credentialsFile, "{}")
    process.env["PATH"] = `${bin}:${previousPath}`
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")

    const config: DevConfig = {
      project: "tilly",
      commands: {
        web: {
          run: "node -e 'setTimeout(() => {}, 30000)'",
          route: true,
        },
      },
    }
    const started = await startCommand(config, testWorkspace(root), "web", {
      mode: "cloudflare",
      machine: "cbook",
      domain: "dev.example.com",
      tunnelId,
      credentialsFile,
    })

    assert.equal(started.ok, true)
    if (!started.ok) return
    assert.equal(started.value.record.url, "https://cbook-web-feature-x-tilly.dev.example.com")
    assert.equal(typeof started.value.record.backendPort, "number")
    const calls = await readSoon(trace)
    assert.match(calls, new RegExp(`tunnel route dns ${tunnelId} cbook-web-feature-x-tilly\\.dev\\.example\\.com`))
    assert.match(calls, new RegExp(`tunnel --config .+ run ${tunnelId}`))
    const tunnelConfig = await fs.readFile(path.join(process.env["WORK_STATE_ROOT"] ?? "", "cloudflare", "config.yml"), "utf8")
    assert.match(tunnelConfig, /hostname: "cbook-web-feature-x-tilly\.dev\.example\.com"/)
    assert.match(tunnelConfig, /service: "http:\/\/127\.0\.0\.1:\d+"/)

    const stopped = await stopCommand("tilly", "feature-x", "web")
    assert.equal(stopped.ok, true)
    const connectorPid = path.join(process.env["WORK_STATE_ROOT"] ?? "", "cloudflare", "cloudflared.pid")
    await assert.rejects(fs.stat(connectorPid))
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
          pid: 99999999,
          command: "already gone",
          run: "already gone",
          route: null,
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

async function readSoon(file: string) {
  const deadline = Date.now() + 2_000

  while (Date.now() < deadline) {
    try {
      return await fs.readFile(file, "utf8")
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  return await fs.readFile(file, "utf8")
}

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
