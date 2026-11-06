import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { syncCloudflareTunnel } from "./cloudflare.js"
import { commandRuntimeStatus, pruneDeadCommands, restartTrackedCommand, startCommand, startupExits, stopCommand } from "./processes.js"
import { currentRunOffset } from "./logs.js"
import { commandLogFile, listWorkspaceStates, readWorkspaceState, writeWorkspaceState } from "./state.js"
import { isPidRunning } from "./shell.js"
import { tempDir } from "./test-helpers.js"
import type { DevConfig, WorkspaceRecord, WorkspaceState } from "./types.js"

const previousStateRoot = process.env["WORK_STATE_ROOT"]
const previousPath = process.env["PATH"]
const previousWorkspaceValue = process.env["WORKSPACE_VALUE"]
const previousConfigHome = process.env["XDG_CONFIG_HOME"]

beforeEach(async () => {
  process.env["XDG_CONFIG_HOME"] = await tempDir("work-cli-config-")
})

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"]
  else process.env["XDG_CONFIG_HOME"] = previousConfigHome
  process.env["WORK_STATE_ROOT"] = previousStateRoot
  process.env["PATH"] = previousPath
  if (previousWorkspaceValue === undefined) {
    delete process.env["WORKSPACE_VALUE"]
  } else {
    process.env["WORKSPACE_VALUE"] = previousWorkspaceValue
  }
})

describe("process lifecycle", () => {
  test("starts from global config and re-resolves TTL on tracked restarts", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const environment = { PATH: process.env["PATH"], XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] }
    const file = path.join(environment.XDG_CONFIG_HOME!, "work", "config.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{"maxTtlSeconds": 60}')
    const started = await startCommand(testConfig("node -e 'setTimeout(() => {}, 30000)'"), testWorkspace(root), "web", { mode: "local" }, environment)
    assert.ok(started.ok)
    if (!started.ok) return
    try {
      assert.equal(started.value.record.maxTtlSeconds, 60)
      await fs.writeFile(file, '{"maxTtlSeconds": 120}')
      const automatic = await restartTrackedCommand("tilly", "feature-x", "web", environment, { preserveTtl: true })
      assert.ok(automatic.ok)
      if (automatic.ok) assert.equal(automatic.value.record.maxTtlSeconds, 60)
      const manual = await restartTrackedCommand("tilly", "feature-x", "web", environment)
      assert.ok(manual.ok)
      if (manual.ok) assert.equal(manual.value.record.maxTtlSeconds, 120)
      const disabled = await restartTrackedCommand("tilly", "feature-x", "web", { ...environment, WORK_MAX_TTL_SECONDS: "0" })
      assert.ok(disabled.ok)
      if (disabled.ok) {
        assert.equal(disabled.value.record.maxTtlSeconds, undefined)
        assert.equal(disabled.value.record.ttlStartedAt, undefined)
      }
    } finally {
      await stopCommand("tilly", "feature-x", "web")
    }
  })

  test("automatic restart paths refuse expired records and missing state", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const config = { ...testConfig("true"), maxTtlSeconds: 60 }
    const workspace = testWorkspace(root)
    const started = await startCommand(config, workspace, "web")
    assert.ok(started.ok)
    if (!started.ok) return
    const state = await readWorkspaceState("tilly", "feature-x")
    assert.ok(state.ok && state.value)
    if (!state.ok || !state.value) return
    const record = state.value.commands["web"]!
    record.ttlStartedAt = new Date(Date.now() - 61_000).toISOString()
    assert.equal((await writeWorkspaceState(state.value)).ok, true)
    const environment = { PATH: process.env["PATH"], WORK_MAX_TTL_SECONDS: "invalid" }
    const configured = await startCommand(config, workspace, "web", { mode: "local" }, environment, { preserveTtl: true })
    const tracked = await restartTrackedCommand("tilly", "feature-x", "web", environment, { preserveTtl: true })
    for (const result of [configured, tracked]) {
      assert.ok(result.ok)
      if (result.ok) {
        assert.equal(result.value.started, false)
        assert.equal(result.value.record.pid, record.pid)
      }
    }
    await stopCommand("tilly", "feature-x", "web")
    assert.equal((await startCommand(config, workspace, "web", { mode: "local" }, {}, { preserveTtl: true })).ok, false)
  })

  test("stops resistant children when the shell exits or has already exited", async () => {
    for (const suffix of [" & wait", " &"]) {
      const root = await tempDir()
      process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
      const childFile = path.join(root, "child.pid")
      const script = path.join(root, "child.js")
      await fs.writeFile(script, `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(childFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
      const config = { ...testConfig(`node ${JSON.stringify(script)}${suffix}`), maxTtlSeconds: 0 }
      const started = await startCommand(config, testWorkspace(root), "web")
      assert.ok(started.ok)
      if (!started.ok) continue
      try {
        const childPid = Number(await readSoon(childFile))
        assert.equal(isPidRunning(childPid), true)
        const stopped = await stopCommand("tilly", "feature-x", "web")
        assert.ok(stopped.ok)
        const deadline = Date.now() + 2000
        while (isPidRunning(childPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
        assert.equal(isPidRunning(childPid), false)
      } finally {
        try { process.kill(-started.value.record.pid, "SIGKILL") } catch {}
        await stopCommand("tilly", "feature-x", "web")
      }
    }
  })

  test("persists TTL and preserves it only for automatic restarts", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const workspace = testWorkspace(root)
    const config = testConfig("node -e 'setTimeout(() => {}, 30000)'")
    const environment = { PATH: process.env["PATH"], WORK_MAX_TTL_SECONDS: "60" }
    const started = await startCommand(config, workspace, "web", { mode: "local" }, environment)
    assert.equal(started.ok, true)
    if (!started.ok) return

    try {
      assert.equal(started.value.record.maxTtlSeconds, 60)
      const state = await readWorkspaceState("tilly", "feature-x")
      assert.ok(state.ok && state.value)
      if (!state.ok || !state.value) return
      const record = state.value.commands["web"]!
      record.ttlStartedAt = new Date(Date.now() - 10_000).toISOString()
      assert.equal((await writeWorkspaceState(state.value)).ok, true)

      const automatic = await restartTrackedCommand("tilly", "feature-x", "web", environment, { preserveTtl: true })
      assert.ok(automatic.ok)
      if (automatic.ok) assert.equal(automatic.value.record.ttlStartedAt, record.ttlStartedAt)

      const manual = await restartTrackedCommand("tilly", "feature-x", "web", environment)
      assert.ok(manual.ok)
      if (manual.ok) {
        assert.equal(manual.value.record.maxTtlSeconds, 60)
        assert.equal(manual.value.record.ttlStartedAt, manual.value.record.startedAt)
        assert.notEqual(manual.value.record.ttlStartedAt, record.ttlStartedAt)
      }
    } finally {
      await stopCommand("tilly", "feature-x", "web")
    }
  })

  test("captures idle settings and preserves the idle clock across automatic restarts", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const workspace = testWorkspace(root)
    const config = testConfig("node -e 'setTimeout(() => {}, 30000)'")
    const environment = { PATH: process.env["PATH"], WORK_IDLE_TIMEOUT_SECONDS: "60" }
    const started = await startCommand(config, workspace, "web", { mode: "local" }, environment)
    assert.equal(started.ok, true)
    if (!started.ok) return

    try {
      assert.equal(started.value.record.idleTimeoutSeconds, 60)
      const state = await readWorkspaceState("tilly", "feature-x")
      assert.ok(state.ok && state.value)
      if (!state.ok || !state.value) return
      const record = state.value.commands["web"]!
      record.lastActivityAt = new Date(Date.now() - 10_000).toISOString()
      record.idleSockets = { retained: 42 }
      assert.equal((await writeWorkspaceState(state.value)).ok, true)

      const automatic = await restartTrackedCommand("tilly", "feature-x", "web", { ...environment, WORK_IDLE_TIMEOUT_SECONDS: "invalid" }, { preserveTtl: true })
      assert.ok(automatic.ok)
      if (automatic.ok) {
        assert.equal(automatic.value.record.lastActivityAt, record.lastActivityAt)
        assert.equal(automatic.value.record.activityStartedAt, record.activityStartedAt)
        assert.deepEqual(automatic.value.record.idleSockets, record.idleSockets)
        assert.equal(automatic.value.record.idleTimeoutSeconds, 60)
      }

      if (automatic.ok) {
        process.kill(-automatic.value.record.pid, "SIGTERM")
        const deadline = Date.now() + 2000
        while (await commandRuntimeStatus(automatic.value.record) === "up" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      const configuredAutomatic = await startCommand(config, workspace, "web", { mode: "local" }, environment, { preserveTtl: true })
      assert.ok(configuredAutomatic.ok)
      if (configuredAutomatic.ok) {
        assert.equal(configuredAutomatic.value.record.lastActivityAt, record.lastActivityAt)
        assert.equal(configuredAutomatic.value.record.activityStartedAt, record.activityStartedAt)
      }

      const invalid = await restartTrackedCommand("tilly", "feature-x", "web", { ...environment, WORK_IDLE_TIMEOUT_SECONDS: "invalid" })
      assert.equal(invalid.ok, false)
      if (configuredAutomatic.ok) assert.equal(await commandRuntimeStatus(configuredAutomatic.value.record), "up")

      const manual = await restartTrackedCommand("tilly", "feature-x", "web", { ...environment, WORK_IDLE_TIMEOUT_SECONDS: "120" })
      assert.ok(manual.ok)
      if (manual.ok) {
        assert.equal(manual.value.record.idleTimeoutSeconds, 120)
        assert.equal(manual.value.record.lastActivityAt, manual.value.record.startedAt)
        assert.equal(manual.value.record.activityStartedAt, manual.value.record.startedAt)
        assert.deepEqual(manual.value.record.idleSockets, {})
        assert.notEqual(manual.value.record.lastActivityAt, record.lastActivityAt)
      }
      const disabled = await restartTrackedCommand("tilly", "feature-x", "web", { ...environment, WORK_IDLE_TIMEOUT_SECONDS: "0" })
      assert.ok(disabled.ok)
      if (disabled.ok) {
        assert.equal(disabled.value.record.idleTimeoutSeconds, undefined)
        assert.equal(disabled.value.record.lastActivityAt, undefined)
        assert.equal(disabled.value.record.idleSockets, undefined)
      }
    } finally {
      await stopCommand("tilly", "feature-x", "web")
    }
  })

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
          env: { WORKSPACE_VALUE: "command" },
        },
        sync: {
          run: "echo sync",
          route: true,
          env: { PORTLESS_STATE_DIR: await portlessStateDir(8443) },
        },
      },
    }

    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    await fs.writeFile(path.join(root, ".env.local"), "WORKSPACE_VALUE=workspace\n")

    const started = await startCommand(config, workspace, "web", { mode: "local" }, { ...process.env, PORTLESS_STATE_DIR: await portlessStateDir(1355) })
    assert.equal(started.ok, true)
    assert.equal(started.ok && started.value.record.url, "https://web-feature-x-tilly.localhost:1355")

    const env = JSON.parse(await readSoon(output))
    assert.deepEqual(env, {
      web: "https://web-feature-x-tilly.localhost:1355",
      sync: "https://sync-feature-x-tilly.localhost:8443",
      syncWs: "wss://sync-feature-x-tilly.localhost:8443",
      workspaceValue: "command",
      urls: JSON.stringify({
        web: "https://web-feature-x-tilly.localhost:1355",
        sync: "https://sync-feature-x-tilly.localhost:8443",
      }),
    })

    const state = await readWorkspaceState("tilly", "feature-x")
    assert.deepEqual(state.ok ? state.value?.env : undefined, { WORKSPACE_VALUE: "configured" })
  })

  test("restarts a record from an older work version on the URL Portless serves", async () => {
    const root = await tempDir()
    const bin = await tempDir("work-cli-bin-")
    const routeFile = path.join(root, "route.txt")
    const output = path.join(root, "env.json")
    // Stands in for portless: records the name it was given and runs the command.
    await fs.writeFile(path.join(bin, "portless"), `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(routeFile)}\nshift\nexec "$@"\n`, { mode: 0o755 })
    process.env["PATH"] = `${bin}:${process.env["PATH"]}`
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const name = "ruler-fix-tabs-size-strip-instead-of-touch-t"
    const config: DevConfig = {
      project: "syntwin-mono",
      commands: {
        preview: {
          run: `node -e 'require("fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({ preview: process.env.WORK_PREVIEW_URL, urls: process.env.WORK_URLS })); setTimeout(() => {}, 30000)'`,
          route: true,
        },
        web: { run: "echo web", route: true },
      },
    }
    const environment = { ...process.env, PORTLESS_STATE_DIR: await portlessStateDir(1355) }
    const started = await startCommand(config, { ...testWorkspace(root, name), project: "syntwin-mono" }, "preview", { mode: "local" }, environment)
    assert.ok(started.ok)

    // What work 10e93a0 recorded: the full name, no port.
    const legacyUrl = (command: string) => `https://${command}-${name}-syntwin-mono.localhost`
    const state = await readWorkspaceState("syntwin-mono", name)
    assert.ok(state.ok && state.value)
    if (!state.ok || !state.value) return
    state.value.urls = { preview: legacyUrl("preview"), web: legacyUrl("web") }
    Object.assign(state.value.commands["preview"]!, { route: `preview-${name}-syntwin-mono`, url: legacyUrl("preview"), localUrl: legacyUrl("preview") })
    assert.equal((await writeWorkspaceState(state.value)).ok, true)
    await fs.rm(output, { force: true })

    try {
      const restarted = await restartTrackedCommand("syntwin-mono", name, "preview", environment)
      assert.ok(restarted.ok)
      const expected = {
        preview: `https://preview-${name}-syn-154ac3.localhost:1355`,
        web: `https://web-${name}-syntwin-mono.localhost:1355`,
      }
      if (restarted.ok) {
        assert.equal(restarted.value.record.route, `preview-${name}-syn-154ac3`)
        assert.equal(restarted.value.record.url, expected.preview)
        assert.equal(restarted.value.record.localUrl, expected.preview)
      }
      assert.deepEqual(JSON.parse(await readSoon(output)), { preview: expected.preview, urls: JSON.stringify(expected) })
      assert.equal(await fs.readFile(routeFile, "utf8"), `preview-${name}-syn-154ac3`)
      const saved = await readWorkspaceState("syntwin-mono", name)
      assert.deepEqual(saved.ok ? saved.value?.urls : undefined, expected)
    } finally {
      await stopCommand("syntwin-mono", name, "preview")
    }
  })

  test("uses the invoking client's environment instead of the daemon environment", async () => {
    const root = await tempDir()
    const workspace = testWorkspace(root)
    const output = path.join(root, "env.txt")
    const config = testConfig(
      `node -e 'require("fs").writeFileSync(${JSON.stringify(output)}, process.env.WORKSPACE_VALUE)'`,
    )

    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    process.env["WORKSPACE_VALUE"] = "daemon"

    const started = await startCommand(config, workspace, "web", { mode: "local" }, {
      ...process.env,
      WORKSPACE_VALUE: "client",
    })
    assert.equal(started.ok, true)
    assert.equal(await readSoonValue(output, "client"), "client")
  })

  test("tracked restarts reload project env and preserve command overrides", async () => {
    const projectRoot = await tempDir()
    const workspaceRoot = await tempDir()
    const output = path.join(workspaceRoot, "env.txt")
    const workspace = { ...testWorkspace(workspaceRoot), sourceRoot: projectRoot }
    const config: DevConfig = {
      project: "tilly",
      commands: {
        web: {
          run: `node -e 'require("fs").writeFileSync(${JSON.stringify(output)}, process.env.PROJECT_VALUE + ":" + process.env.COMMAND_VALUE); setTimeout(() => {}, 30000)'`,
          env: { COMMAND_VALUE: "command" },
        },
      },
    }

    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    await fs.writeFile(path.join(projectRoot, ".env.local"), "PROJECT_VALUE=first\n")

    const invokingEnvironment = { PATH: process.env["PATH"], XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] }
    const started = await startCommand(config, workspace, "web", { mode: "local" }, invokingEnvironment)
    assert.equal(started.ok, true)
    assert.equal(await readSoon(output), "first:command")

    await fs.writeFile(path.join(projectRoot, ".env.local"), "PROJECT_VALUE=second\n")
    const restarted = await restartTrackedCommand("tilly", "feature-x", "web", invokingEnvironment)
    assert.equal(restarted.ok, true)
    assert.equal(await readSoonValue(output, "second:command"), "second:command")

    await stopCommand("tilly", "feature-x", "web")
  })

  test("keeps one Cloudflare connector synchronized with routed processes", async () => {
    const root = await tempDir()
    const bin = await tempDir("work-cli-bin-")
    const trace = path.join(root, "cloudflared.trace")
    const failConnector = path.join(root, "fail-connector")
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
if [ -f ${JSON.stringify(failConnector)} ]; then exit 1; fi
printf '%s\n' 'Registered tunnel connection'
trap 'exit 0' TERM INT
while :; do sleep 1; done
`)
    await fs.chmod(portless, 0o755)
    await fs.chmod(cloudflared, 0o755)
    await fs.writeFile(credentialsFile, "{}")
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const invokingEnvironment = { ...process.env, PATH: `${bin}:${previousPath}` }

    const config: DevConfig = {
      project: "tilly",
      commands: {
        web: {
          run: "node -e 'setTimeout(() => {}, 30000)'",
          route: true,
        },
        api: {
          run: "node -e 'setTimeout(() => {}, 30000)'",
          route: true,
        },
      },
    }
    const started = await startCommand(config, testWorkspace(root), "web", {
      mode: "cloudflare",
      machine: "cbook",
      domain: "example.com",
      tunnelId,
      credentialsFile,
    }, invokingEnvironment)

    assert.equal(started.ok, true)
    if (!started.ok) return
    assert.equal(started.value.record.url, "https://cbook-web-feature-x-tilly.example.com")
    assert.equal(typeof started.value.record.backendPort, "number")
    const calls = await readSoon(trace)
    assert.match(calls, new RegExp(`tunnel route dns ${tunnelId} cbook-web-feature-x-tilly\\.example\\.com`))
    assert.match(calls, new RegExp(`tunnel --no-autoupdate --config .+ run ${tunnelId}`))
    const tunnelConfig = await fs.readFile(path.join(process.env["WORK_STATE_ROOT"] ?? "", "cloudflare", "config.yml"), "utf8")
    assert.match(tunnelConfig, /hostname: "cbook-web-feature-x-tilly\.example\.com"/)
    assert.match(tunnelConfig, /service: "http:\/\/127\.0\.0\.1:\d+"/)

    const resynced = await syncCloudflareTunnel(invokingEnvironment)
    assert.equal(resynced.ok, true)
    const callsAfterResync = await fs.readFile(trace, "utf8")
    assert.doesNotMatch(callsAfterResync, /tunnel route dns --overwrite-dns/)
    assert.equal(callsAfterResync.match(/tunnel --no-autoupdate --config .+ run/g)?.length, 1)

    const localReplacement = await startCommand(config, testWorkspace(root), "web", { mode: "local" }, invokingEnvironment)
    assert.equal(localReplacement.ok, false)
    if (!localReplacement.ok) assert.match(localReplacement.error.message, /work down/)

    const connectorPidFile = path.join(process.env["WORK_STATE_ROOT"] ?? "", "cloudflare", "cloudflared.pid")
    const originalConnectorPid = JSON.parse(await fs.readFile(connectorPidFile, "utf8")).pid as number
    await fs.writeFile(failConnector, "fail")
    const failedReplacement = await startCommand(config, testWorkspace(root), "api", {
      mode: "cloudflare",
      machine: "cbook",
      domain: "example.com",
      tunnelId,
      credentialsFile,
    }, invokingEnvironment)
    assert.equal(failedReplacement.ok, false)
    assert.match(await fs.readFile(trace, "utf8"), /tunnel route dns --overwrite-dns/)
    assert.equal(JSON.parse(await fs.readFile(connectorPidFile, "utf8")).pid, originalConnectorPid)
    assert.doesNotThrow(() => process.kill(originalConnectorPid, 0))
    assert.doesNotMatch(await fs.readFile(path.join(process.env["WORK_STATE_ROOT"] ?? "", "cloudflare", "config.yml"), "utf8"), /cbook-api-/)

    const stopped = await stopCommand("tilly", "feature-x", "web", { environment: invokingEnvironment })
    assert.equal(stopped.ok, true)
    await assert.rejects(fs.stat(connectorPidFile))
    const stoppedState = await readWorkspaceState("tilly", "feature-x")
    assert.equal(stoppedState.ok ? stoppedState.value?.exposure : "error", undefined)
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

  test("marks each run in the log and records where the current one starts", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const started = await startCommand(testConfig("echo first; exec sleep 30"), testWorkspace(root), "web")
    assert.ok(started.ok)
    if (!started.ok) return
    try {
      const log = started.value.record.log
      assert.equal(started.value.record.logOffset, 0)
      assert.match(await readSoonMatch(log, /first/), /^── work: start web \S+\nfirst\n$/)

      const restarted = await restartTrackedCommand("tilly", "feature-x", "web")
      assert.ok(restarted.ok)
      if (!restarted.ok) return
      const text = await readSoonMatch(log, /first[\s\S]*first/)
      const offset = restarted.value.record.logOffset ?? -1
      assert.match(text, new RegExp(`^── work: exit web pid=${started.value.record.pid} signal=SIGTERM `, "m"))
      assert.match(Buffer.from(text).subarray(offset).toString(), /^── work: start web \S+\nfirst\n$/)
    } finally {
      await stopCommand("tilly", "feature-x", "web")
    }
  })

  test("keeps dead records with their exit status until the next start", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const started = await startCommand(testConfig("echo ready; exit 3"), testWorkspace(root), "web")
    assert.ok(started.ok)
    if (!started.ok) return
    await readSoonMatch(started.value.record.log, /code=3/)

    const kept = await pruneDeadCommands(process.env, undefined, undefined, { keepDead: true })
    assert.deepEqual(kept, { ok: true, value: 0 })
    const state = await readWorkspaceState("tilly", "feature-x")
    const record = state.ok ? state.value?.commands["web"] : undefined
    assert.equal(record?.exitCode, 3)
    assert.ok(record?.exitedAt)
    assert.equal(await commandRuntimeStatus(record!), "dead")
    assert.deepEqual(await pruneDeadCommands(process.env, undefined, undefined, { keepDead: true }), { ok: true, value: 0 })

    assert.equal((await stopCommand("tilly", "feature-x", "web", { idleSeconds: 7200 })).ok, true)
    const idleStopped = await readWorkspaceState("tilly", "feature-x")
    assert.ok(idleStopped.ok && idleStopped.value)
    if (idleStopped.ok && idleStopped.value) {
      const stoppedRecord = idleStopped.value.commands["web"]!
      assert.equal(stoppedRecord.exitedAt, record!.exitedAt)
      assert.equal(stoppedRecord.exitCode, 3)
      assert.ok(stoppedRecord.idleStoppedAt)
    }

    const restarted = await restartTrackedCommand("tilly", "feature-x", "web")
    assert.ok(restarted.ok)
    if (restarted.ok) {
      assert.equal(restarted.value.record.exitCode, undefined)
      assert.equal(restarted.value.record.exitedAt, undefined)
    }
    await readSoonMatch(started.value.record.log, /code=3[\s\S]*code=3/)
    assert.deepEqual(await pruneDeadCommands(), { ok: true, value: 1 })
    assert.deepEqual((await listWorkspaceStates())[0]?.commands, {})
  })

  test("drops dead records when their worktree is gone", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const started = await startCommand(testConfig("exit 1"), testWorkspace(root), "web")
    assert.ok(started.ok)
    if (!started.ok) return
    await readSoonMatch(started.value.record.log, /code=1/)
    await fs.rm(root, { recursive: true, force: true })

    assert.deepEqual(await pruneDeadCommands(process.env, undefined, undefined, { keepDead: true }), { ok: true, value: 1 })
    assert.deepEqual((await listWorkspaceStates())[0]?.commands, {})
  })

  test("starts over a dead record tracked in another mode", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const write = await writeWorkspaceState({
      ...testWorkspace(root),
      exposure: { mode: "tailscale", domain: "dev.example.com", certFile: "cert", keyFile: "key", port: 8443 },
      commands: {
        web: {
          id: "web", label: "web", pid: 99999999, command: "gone", run: "gone", route: null, cwd: root,
          log: path.join(root, "web.log"), url: null, startedAt: new Date().toISOString(),
          exposure: { mode: "tailscale", domain: "dev.example.com", certFile: "cert", keyFile: "key", port: 8443 },
          exitedAt: new Date().toISOString(), exitCode: 1,
        },
      },
    } satisfies WorkspaceState)
    assert.equal(write.ok, true)

    const started = await startCommand(testConfig("exec sleep 30"), testWorkspace(root), "web")
    assert.ok(started.ok)
    if (started.ok) {
      assert.equal(started.value.record.exposure?.mode, "local")
      assert.equal(started.value.record.exitedAt, undefined)
    }
    await stopCommand("tilly", "feature-x", "web")
  })

  test("does not trust a recycled process id", async () => {
    const record = {
      id: "web",
      label: "web",
      pid: process.pid,
      command: "unrelated",
      run: "unrelated",
      route: null,
      cwd: process.cwd(),
      log: path.join(process.cwd(), "unrelated.log"),
      url: null,
      startedAt: "2000-01-01T00:00:00.000Z",
    }

    assert.equal(await commandRuntimeStatus(record), "dead")
  })
})

describe("startup exits", () => {
  test("reports a command that dies on launch with its exit code and only this run's output", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const config = testConfig("echo \"run $WORK_RUN\"; echo 'Proxy is not running' >&2; exit 3")
    const first = await startCommand({ ...config, env: { WORK_RUN: "1" } }, testWorkspace(root), "web")
    assert.ok(first.ok)
    if (!first.ok) return
    await startupExits([first.value])

    const second = await startCommand({ ...config, env: { WORK_RUN: "2" } }, testWorkspace(root), "web")
    assert.ok(second.ok)
    if (!second.ok) return
    const exits = await startupExits([second.value])
    assert.deepEqual(exits.get(second.value.record.pid), { code: 3, signal: null, tail: ["run 2", "Proxy is not running"] })
  })

  test("leaves running commands out and tells a clean exit apart from a failure", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const config: DevConfig = {
      project: "tilly",
      commands: {
        web: { run: "node -e 'setTimeout(() => {}, 30000)'" },
        codegen: { run: "echo generated" },
      },
    }
    const running = await startCommand(config, testWorkspace(root), "web")
    const finished = await startCommand(config, testWorkspace(root), "codegen")
    assert.ok(running.ok && finished.ok)
    if (!running.ok || !finished.ok) return

    try {
      const startedAt = Date.now()
      const exits = await startupExits([running.value, finished.value], 300)
      assert.ok(Date.now() - startedAt < 1_000)
      assert.equal(exits.has(running.value.record.pid), false)
      assert.deepEqual(exits.get(finished.value.record.pid), { code: 0, signal: null, tail: ["generated"] })
      assert.equal((await startupExits([{ ...running.value, started: false }], 10_000)).size, 0)
    } finally {
      await stopCommand("tilly", "feature-x", "web")
    }
  })

  test("reports a clean exit after output without a trailing newline", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const started = await startCommand(testConfig("printf done"), testWorkspace(root), "web")
    assert.ok(started.ok)
    if (!started.ok) return

    const exits = await startupExits([started.value])
    assert.deepEqual(exits.get(started.value.record.pid), { code: 0, signal: null, tail: ["done"] })
    assert.match(await fs.readFile(started.value.record.log, "utf8"), /^done\n── work: exit web pid=\d+ code=0 /m)
  })

  test("starts the run marker on its own line when the log ends mid-line", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const log = commandLogFile("tilly", "feature-x", "web")
    await fs.mkdir(path.dirname(log), { recursive: true })
    await fs.writeFile(log, "── work: start web 2026-11-02T10:00:00.000Z\npartial line from a command that outlived its daemon")

    const started = await startCommand(testConfig("echo second"), testWorkspace(root), "web")
    assert.ok(started.ok)
    if (!started.ok) return
    await startupExits([started.value])
    const offset = started.value.record.logOffset ?? -1
    assert.deepEqual(await currentRunOffset(log, offset), { ok: true, value: offset })
    assert.match((await fs.readFile(log)).subarray(offset).toString(), /^── work: start web \S+\nsecond\n/)
  })

  test("stops waiting as soon as every fresh start has exited", async () => {
    const root = await tempDir()
    process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
    const started = await startCommand(testConfig("exit 1"), testWorkspace(root), "web")
    assert.ok(started.ok)
    if (!started.ok) return

    const startedAt = Date.now()
    const exits = await startupExits([started.value], 10_000)
    assert.ok(Date.now() - startedAt < 2_000)
    assert.deepEqual(exits.get(started.value.record.pid), { code: 1, signal: null, tail: [] })
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

async function readSoonMatch(file: string, pattern: RegExp) {
  const deadline = Date.now() + 3_000

  while (Date.now() < deadline) {
    const value = await fs.readFile(file, "utf8").catch(() => "")
    if (pattern.test(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return await fs.readFile(file, "utf8")
}

async function readSoonValue(file: string, expected: string) {
  const deadline = Date.now() + 2_000

  while (Date.now() < deadline) {
    const value = await fs.readFile(file, "utf8").catch(() => "")
    if (value === expected) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return await fs.readFile(file, "utf8")
}

async function portlessStateDir(port: number) {
  const dir = await tempDir("portless-state-")
  await fs.writeFile(path.join(dir, "proxy.port"), `${port}\n`)
  return dir
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
