import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { callDaemon, daemonStatus, ensureDaemon, sendDaemon, stopDaemon } from "./daemon-client.js"
import { readWorkspaceState, writeWorkspaceState } from "./state.js"
import { commandRuntimeStatus } from "./processes.js"
import { isPidRunning } from "./shell.js"
import { tempDir } from "./test-helpers.js"

const previousStateRoot = process.env["WORK_STATE_ROOT"]
const previousEntrypoint = process.env["WORK_DAEMON_ENTRYPOINT"]
const previousConfigHome = process.env["XDG_CONFIG_HOME"]

beforeEach(async () => {
  process.env["XDG_CONFIG_HOME"] = await tempDir("work-cli-config-")
})

afterEach(async () => {
  await stopDaemon()
  if (previousConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"]
  else process.env["XDG_CONFIG_HOME"] = previousConfigHome
  process.env["WORK_STATE_ROOT"] = previousStateRoot
  if (previousEntrypoint === undefined) {
    delete process.env["WORK_DAEMON_ENTRYPOINT"]
  } else {
    process.env["WORK_DAEMON_ENTRYPOINT"] = previousEntrypoint
  }
})

describe("daemon client", () => {
  test("prune preserves supervised dead records and their deadlines before and after daemon recovery", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const config = { project: "demo", maxTtlSeconds: 60, commands: { web: { run: "true", restart: "on-exit" as const } } }
    const workspace = { project: "demo", workspace: "main", branch: "main", root }
    const environment = { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "" }
    const started = await callDaemon({ type: "run", config, workspace, command: "web", exposure: { mode: "local" }, environment })
    assert.ok(started.ok)
    if (!started.ok) return
    try {
      for (const recover of [false, true]) {
        if (recover) {
          assert.equal((await stopDaemon()).ok, true)
          assert.equal((await ensureDaemon()).ok, true)
        }
        const pruned = await sendDaemon({ type: "prune", environment })
        assert.ok(pruned.ok)
        if (pruned.ok) assert.equal(pruned.value.data, 0)
        const state = await readWorkspaceState("demo", "main")
        assert.ok(state.ok && state.value?.commands["web"])
        if (state.ok) assert.equal(state.value?.commands["web"]?.ttlStartedAt, started.value.data.record.ttlStartedAt)
      }
    } finally {
      await callDaemon({ type: "down", project: "demo", workspace: "main", environment })
    }
  })

  test("expires already-dead supervised records without respawning", async () => {
    const root = await tempDir()
    const counter = path.join(root, "dead-counter")
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const config = { project: "demo", maxTtlSeconds: 60, commands: { web: { run: `node -e 'require("fs").appendFileSync(${JSON.stringify(counter)}, "started\\n")'`, restart: "on-exit" as const } } }
    const environment = { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "" }
    const started = await callDaemon({ type: "run", config, workspace: { project: "demo", workspace: "main", branch: "main", root }, command: "web", exposure: { mode: "local" }, environment })
    assert.ok(started.ok)
    if (!started.ok) return
    try {
      await waitForValue(counter, "started\n")
      assert.equal((await stopDaemon()).ok, true)
      const state = await readWorkspaceState("demo", "main")
      assert.ok(state.ok && state.value)
      if (!state.ok || !state.value) return
      state.value.commands["web"]!.ttlStartedAt = new Date(Date.now() - 61_000).toISOString()
      assert.equal((await writeWorkspaceState(state.value)).ok, true)
      assert.equal((await ensureDaemon()).ok, true)
      await waitForEmptyWorkspace("demo", "main")
      assert.equal(await fs.readFile(counter, "utf8"), "started\n")
    } finally {
      await callDaemon({ type: "down", project: "demo", workspace: "main", environment })
    }
  })

  test("TTL shutdown kills children that ignore SIGTERM", async () => {
    const root = await tempDir()
    const childFile = path.join(root, "child.pid")
    const script = path.join(root, "child.js")
    await fs.writeFile(script, `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(childFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const config = { project: "demo", maxTtlSeconds: 1, commands: { web: { run: `node ${JSON.stringify(script)} & wait` } } }
    const environment = { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "" }
    const started = await callDaemon({ type: "run", config, workspace: { project: "demo", workspace: "main", branch: "main", root }, command: "web", exposure: { mode: "local" }, environment })
    assert.ok(started.ok)
    if (!started.ok) return
    try {
      await waitForEmptyWorkspace("demo", "main")
      const childPid = Number(await fs.readFile(childFile, "utf8"))
      const deadline = Date.now() + 2000
      while (isPidRunning(childPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(isPidRunning(childPid), false)
    } finally {
      try { process.kill(-started.value.data.record.pid, "SIGKILL") } catch {}
      await callDaemon({ type: "down", project: "demo", workspace: "main", environment })
    }
  })

  test("explicit configured restart resets TTL and invalid defaults leave the process running", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const config = { project: "demo", maxTtlSeconds: 60, commands: { web: { run: "node -e 'setTimeout(() => {}, 30000)'" } } }
    const workspace = { project: "demo", workspace: "main", branch: "main", root }
    const environment = { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "" }
    const started = await callDaemon({ type: "run", config, workspace, command: "web", exposure: { mode: "local" }, environment })
    assert.ok(started.ok)
    if (!started.ok) return
    try {
      const invalid = await callDaemon({ type: "restart", config, workspace, command: "web", exposure: { mode: "local" }, environment: { ...environment, WORK_MAX_TTL_SECONDS: "invalid" } })
      assert.equal(invalid.ok, false)
      assert.equal(await commandRuntimeStatus(started.value.data.record), "up")
      const restarted = await callDaemon({ type: "restart", config, workspace, command: "web", exposure: { mode: "local" }, environment: { ...environment, WORK_MAX_TTL_SECONDS: "120" } })
      assert.ok(restarted.ok)
      if (restarted.ok) {
        assert.equal(restarted.value.data.record.maxTtlSeconds, 120)
        assert.equal(restarted.value.data.record.ttlStartedAt, restarted.value.data.record.startedAt)
        assert.notEqual(restarted.value.data.record.pid, started.value.data.record.pid)
        assert.notEqual(restarted.value.data.record.ttlStartedAt, started.value.data.record.ttlStartedAt)
      }
    } finally {
      await callDaemon({ type: "down", project: "demo", workspace: "main", environment })
    }
  })

  test("expires commands without respawning them, across automatic and daemon restarts", { timeout: 15_000 }, async () => {
    const root = await tempDir()
    const counter = path.join(root, "ttl-counter")
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const script = `const fs=require("fs");const file=${JSON.stringify(counter)};const next=Number(fs.existsSync(file)?fs.readFileSync(file,"utf8"):0)+1;fs.writeFileSync(file,String(next));if(next>1)setTimeout(()=>{},30000)`
    const config = {
      project: "demo",
      commands: {
        web: { run: `node -e ${JSON.stringify(script)}`, restart: "on-exit" as const },
        worker: { run: "node -e 'setTimeout(() => {}, 30000)'" },
      },
    }
    const environment = { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "", WORK_MAX_TTL_SECONDS: "6" }
    const workspace = { project: "demo", workspace: "main", branch: "main", root }
    const started = await callDaemon({ type: "run", config, workspace, command: "web", exposure: { mode: "local" }, environment })
    assert.ok(started.ok)
    if (!started.ok) return

    try {
      const worker = await callDaemon({ type: "run", config, workspace, command: "worker", exposure: { mode: "local" }, environment })
      assert.ok(worker.ok)
      const unlimited = await callDaemon({ type: "run", config: { ...config, maxTtlSeconds: 0 }, workspace: { ...workspace, workspace: "unlimited" }, command: "worker", exposure: { mode: "local" }, environment: { ...environment, WORK_MAX_TTL_SECONDS: "0" } })
      assert.ok(unlimited.ok)
      await waitForValue(counter, "2")
      const state = await readWorkspaceState("demo", "main")
      const restarted = state.ok ? state.value?.commands["web"] : undefined
      assert.ok(restarted)
      assert.equal(restarted?.ttlStartedAt, started.value.data.record.ttlStartedAt)
      assert.equal(restarted?.maxTtlSeconds, 6)
      if (restarted) assert.equal(await commandRuntimeStatus(restarted), "up")
      assert.equal((await stopDaemon()).ok, true)
      assert.equal((await ensureDaemon()).ok, true)
      const recovered = await readWorkspaceState("demo", "main")
      assert.equal(recovered.ok ? recovered.value?.commands["web"]?.ttlStartedAt : undefined, started.value.data.record.ttlStartedAt)

      const deadline = Date.now() + 9000
      let remaining: number | undefined
      while (Date.now() < deadline) {
        const current = await readWorkspaceState("demo", "main")
        remaining = current.ok ? Object.keys(current.value?.commands ?? {}).length : undefined
        if (remaining === 0) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.equal(remaining, 0)
      if (restarted) assert.equal(await commandRuntimeStatus(restarted), "dead")
      if (worker.ok) assert.equal(await commandRuntimeStatus(worker.value.data.record), "dead")
      if (unlimited.ok) assert.equal(await commandRuntimeStatus(unlimited.value.data.record), "up")
      await new Promise((resolve) => setTimeout(resolve, 1100))
      assert.equal(await fs.readFile(counter, "utf8"), "2")
      const afterExpiry = await readWorkspaceState("demo", "main")
      assert.deepEqual(afterExpiry.ok ? afterExpiry.value?.commands : undefined, {})
    } finally {
      for (const name of ["main", "unlimited"]) {
        await callDaemon({ type: "down", project: "demo", workspace: name, environment })
      }
    }
  })

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
        environment: { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "" },
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
        environment: { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "" },
      })
      assert.equal(repeated.ok, true)
      if (repeated.ok) {
        assert.equal(repeated.value.data.started, false)
        assert.equal(repeated.value.data.record.pid, pids[0])
      }
    } finally {
      for (const name of workspaces) {
        await callDaemon({ type: "stop", project: "demo", workspace: name, command: "web", environment: { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "" } })
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
    const environment = { PATH: `${bin}:${process.env["PATH"] ?? ""}`, XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "" }
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
      environment: { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "" },
    })
    assert.equal(started.ok, true)
    if (!started.ok) return

    const firstPid = started.value.data.record.pid
    await waitForValue(counter, "2")
    const state = await readWorkspaceState("demo", "main")
    assert.equal(state.ok, true)
    if (state.ok) assert.notEqual(state.value?.commands["web"]?.pid, firstPid)

    await sendDaemon({ type: "down", project: "demo", workspace: "main", environment: { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "" } })
  })

  test("restores on-exit supervision after daemon restart", async () => {
    const root = await tempDir()
    const counter = path.join(root, "counter")
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const script = `const fs=require("fs");const file=${JSON.stringify(counter)};const next=Number(fs.existsSync(file)?fs.readFileSync(file,"utf8"):0)+1;fs.writeFileSync(file,String(next));setTimeout(()=>{},30000)`
    const config = { project: "demo", commands: { web: { run: `node -e ${JSON.stringify(script)}`, restart: "on-exit" as const } } }
    const workspace = { project: "demo", workspace: "main", branch: "main", root }
    const environment = { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] ?? "" }
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

async function waitForEmptyWorkspace(project: string, workspace: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const state = await readWorkspaceState(project, workspace)
    if (state.ok && state.value && Object.keys(state.value.commands).length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`commands still tracked for ${project}/${workspace}`)
}
