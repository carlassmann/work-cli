import { afterEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { callDaemon, daemonStatus, ensureDaemon, sendDaemon, stopDaemon } from "./daemon-client.js"
import { readWorkspaceState } from "./state.js"
import { commandRuntimeStatus } from "./processes.js"
import { tempDir } from "./test-helpers.js"

const previousStateRoot = process.env["WORK_STATE_ROOT"]
const previousEntrypoint = process.env["WORK_DAEMON_ENTRYPOINT"]

afterEach(async () => {
  await stopDaemon()
  process.env["WORK_STATE_ROOT"] = previousStateRoot
  if (previousEntrypoint === undefined) {
    delete process.env["WORK_DAEMON_ENTRYPOINT"]
  } else {
    process.env["WORK_DAEMON_ENTRYPOINT"] = previousEntrypoint
  }
})

describe("daemon client", () => {
  test("starts, answers ping, reports status, and stops", async () => {
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")

    const pidResult = await ensureDaemon()
    assert.equal(pidResult.ok, true)
    if (!pidResult.ok) return

    const status = await daemonStatus()
    const ping = await sendDaemon({ type: "ping" })

    assert.equal(typeof pidResult.value, "number")
    assert.equal(status.running, true)
    assert.equal(status.pid, pidResult.value)

    assert.equal(ping.ok, true)
    if (ping.ok) {
      assert.equal(ping.value.data.pid, status.pid)
    }

    await stopDaemon()
    assert.equal((await daemonStatus()).running, false)
  })

  test("stopping the daemon preserves commands in every workspace", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const config = {
      project: "demo",
      commands: { web: { run: "node -e 'setTimeout(() => {}, 30000)'" } },
    }
    const workspaces = ["first", "second"]
    const pids: number[] = []

    for (const name of workspaces) {
      const started = await callDaemon({
        type: "run",
        config,
        workspace: { project: "demo", workspace: name, branch: name, root },
        command: "web",
        exposure: { mode: "local" },
        environment: { PATH: process.env["PATH"] ?? "" },
      })
      assert.equal(started.ok, true)
      if (started.ok) pids.push(started.value.data.record.pid)
    }

    try {
      const stopped = await stopDaemon()
      assert.equal(stopped.ok, true)
      for (const [index, name] of workspaces.entries()) {
        const state = await readWorkspaceState("demo", name)
        assert.equal(state.ok, true)
        const record = state.ok ? state.value?.commands["web"] : undefined
        assert.equal(record?.pid, pids[index])
        if (record) assert.equal(await commandRuntimeStatus(record), "up")
      }

      const restarted = await ensureDaemon()
      assert.equal(restarted.ok, true)
      const repeated = await callDaemon({
        type: "run",
        config,
        workspace: { project: "demo", workspace: "first", branch: "first", root },
        command: "web",
        exposure: { mode: "local" },
        environment: { PATH: process.env["PATH"] ?? "" },
      })
      assert.equal(repeated.ok, true)
      if (repeated.ok) {
        assert.equal(repeated.value.data.started, false)
        assert.equal(repeated.value.data.record.pid, pids[0])
      }
    } finally {
      for (const name of workspaces) {
        await callDaemon({ type: "stop", project: "demo", workspace: name, command: "web", environment: { PATH: process.env["PATH"] ?? "" } })
      }
    }
  })

  test("waits for an active command before stopping the daemon", async () => {
    const root = await tempDir()
    const bin = await tempDir("work-cli-bin-")
    const dnsStarted = path.join(root, "dns-started")
    const portless = path.join(bin, "portless")
    const cloudflared = path.join(bin, "cloudflared")
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    await fs.writeFile(portless, '#!/bin/sh\nwhile [ "$1" != "sh" ]; do shift; done\nexec "$@"\n')
    await fs.writeFile(cloudflared, `#!/bin/sh
if [ "$2" = "route" ]; then
  printf ready > ${JSON.stringify(dnsStarted)}
  sleep 0.5
  exit 0
fi
printf '%s\n' 'Registered tunnel connection'
trap 'exit 0' TERM INT
while :; do sleep 1; done
`)
    await fs.chmod(portless, 0o755)
    await fs.chmod(cloudflared, 0o755)
    const environment = { PATH: `${bin}:${process.env["PATH"] ?? ""}` }
    const config = { project: "demo", commands: { web: { run: "node -e 'setTimeout(() => {}, 30000)'", route: true } } }
    const workspace = { project: "demo", workspace: "main", branch: "main", root }
    const exposure = {
      mode: "cloudflare" as const,
      machine: "test",
      domain: "example.com",
      tunnelId: "11111111-1111-4111-8111-111111111111",
      credentialsFile: path.join(root, "credentials.json"),
    }
    await fs.writeFile(exposure.credentialsFile, "{}")
    assert.equal((await ensureDaemon()).ok, true)

    const running = callDaemon({ type: "run", config, workspace, command: "web", exposure, environment })
    try {
      await waitForValue(dnsStarted, "ready")
      const stopped = await stopDaemon()
      const started = await running
      assert.equal(stopped.ok, true)
      assert.equal(started.ok, true)
      const state = await readWorkspaceState("demo", "main")
      const record = state.ok ? state.value?.commands["web"] : undefined
      assert.ok(record)
      if (record) assert.equal(await commandRuntimeStatus(record), "up")
    } finally {
      await callDaemon({ type: "stop", project: "demo", workspace: "main", command: "web", environment })
    }
  })

  test("concurrent clients share one daemon", async () => {
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const workd = path.join(process.cwd(), "src", "workd.ts")
    process.env["WORK_DAEMON_ENTRYPOINT"] = `if mkdir "$WORK_STATE_ROOT/start-winner" 2>/dev/null; then sleep 0.2; exec bun ${JSON.stringify(workd)}; else exit 0; fi`

    const results = await Promise.all([ensureDaemon(), ensureDaemon()])
    assert.equal(results.every((result) => result.ok), true, JSON.stringify(results))
    if (!results[0]?.ok || !results[1]?.ok) return
    assert.equal(results[0].value, results[1].value)
  })

  test("restarts on-exit commands", async () => {
    const root = await tempDir()
    const counter = path.join(root, "counter")
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const script = `const fs=require("fs");const file=${JSON.stringify(counter)};const next=Number(fs.existsSync(file)?fs.readFileSync(file,"utf8"):0)+1;fs.writeFileSync(file,String(next));if(next>1)setTimeout(()=>{},30000)`
    const config = {
      project: "demo",
      commands: {
        web: { run: `node -e ${JSON.stringify(script)}`, restart: "on-exit" as const },
      },
    }
    const workspace = { project: "demo", workspace: "main", branch: "main", root }

    const started = await callDaemon({
      type: "run",
      config,
      workspace,
      command: "web",
      exposure: { mode: "local" },
      environment: { PATH: process.env["PATH"] ?? "" },
    })
    assert.equal(started.ok, true)
    if (!started.ok) return

    const firstPid = started.value.data.record.pid
    await waitForValue(counter, "2")
    const state = await readWorkspaceState("demo", "main")
    assert.equal(state.ok, true)
    if (state.ok) assert.notEqual(state.value?.commands["web"]?.pid, firstPid)

    await sendDaemon({ type: "down", project: "demo", workspace: "main", environment: { PATH: process.env["PATH"] ?? "" } })
  })

  test("restores on-exit supervision after daemon restart", async () => {
    const root = await tempDir()
    const counter = path.join(root, "counter")
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const script = `const fs=require("fs");const file=${JSON.stringify(counter)};const next=Number(fs.existsSync(file)?fs.readFileSync(file,"utf8"):0)+1;fs.writeFileSync(file,String(next));setTimeout(()=>{},30000)`
    const config = { project: "demo", commands: { web: { run: `node -e ${JSON.stringify(script)}`, restart: "on-exit" as const } } }
    const workspace = { project: "demo", workspace: "main", branch: "main", root }
    const environment = { PATH: process.env["PATH"] ?? "" }
    const started = await callDaemon({ type: "run", config, workspace, command: "web", exposure: { mode: "local" }, environment })
    assert.equal(started.ok, true)
    if (!started.ok) return

    try {
      await waitForValue(counter, "1")
      assert.equal((await stopDaemon()).ok, true)
      assert.equal((await ensureDaemon()).ok, true)
      process.kill(-started.value.data.record.pid, "SIGTERM")
      await waitForValue(counter, "2")
    } finally {
      await callDaemon({ type: "stop", project: "demo", workspace: "main", command: "web", environment })
    }
  })

  test("surfaces stderr when workd crashes during startup", async () => {
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    process.env["WORK_DAEMON_ENTRYPOINT"] = `echo "boom from fake workd" >&2; exit 1`

    const result = await ensureDaemon()

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.tag, "DaemonError")
      assert.match(result.error.message, /workd crashed during startup/)
      assert.match(result.error.message, /boom from fake workd/)
    }
  })

  test("times out when workd never opens the socket", async () => {
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    process.env["WORK_DAEMON_ENTRYPOINT"] = `sleep 30`

    const result = await ensureDaemon()

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.tag, "DaemonError")
      assert.match(result.error.message, /did not respond within/)
    }
  })
})

async function waitForValue(file: string, expected: string) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (await fs.readFile(file, "utf8").catch(() => "") === expected) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(await fs.readFile(file, "utf8").catch(() => ""), expected)
}
