import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { cgroupUnit, daemonLaunchPlan, proxyLaunchPlan, sessionScope, systemdUserManagerAvailable, workdUnitName } from "./systemd.js"
import { tempDir } from "./test-helpers.js"

const entrypoint = { command: "/usr/bin/node", args: ["/opt/work/dist/workd.js"] }

test("without systemd workd starts as a plain detached child", () => {
  assert.deepEqual(daemonLaunchPlan(entrypoint, { systemd: false, stateRoot: "/home/me/.work-cli" }), { ...entrypoint, unit: null })
})

test("with systemd workd runs in its own scope that inherits the caller's environment", () => {
  const plan = daemonLaunchPlan(entrypoint, { systemd: true, stateRoot: "/home/me/.work-cli", now: 1_700_000_000_000 })
  const unit = workdUnitName("/home/me/.work-cli", 1_700_000_000_000)
  assert.equal(plan.command, "systemd-run")
  assert.equal(plan.unit, `${unit}.scope`)
  assert.deepEqual(plan.args.slice(0, 5), ["--user", "--scope", "--collect", "--quiet", `--unit=${unit}`])
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--") + 1), [entrypoint.command, ...entrypoint.args])
  assert.equal(plan.args.some((arg) => arg.startsWith("--setenv") || arg === "-E" || arg.startsWith("--property")), false)
})

test("unit names separate state roots and never reuse a replaced workd's scope", () => {
  const now = 1_700_000_000_000
  assert.match(workdUnitName("/home/me/.work-cli", now), /^work-workd-[0-9a-f]{8}-[0-9a-z]+$/)
  assert.notEqual(workdUnitName("/home/me/.work-cli", now), workdUnitName("/tmp/work-state", now))
  assert.notEqual(workdUnitName("/home/me/.work-cli", now), workdUnitName("/home/me/.work-cli", now + 1))
  assert.equal(workdUnitName("/home/me/.work-cli/", now), workdUnitName("/home/me/.work-cli", now))
})

test("systemd is only used on Linux with a reachable user bus and systemd-run", async () => {
  const runtimeDir = await tempDir("work-cli-runtime-")
  const bin = await tempDir("work-cli-bin-")
  await fs.writeFile(path.join(bin, "systemd-run"), "#!/bin/sh\n", { mode: 0o755 })
  const environment = { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: runtimeDir }

  assert.equal(await systemdUserManagerAvailable({ ...environment, DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" }, "darwin"), false)
  assert.equal(await systemdUserManagerAvailable(environment, "linux"), false)
  if (!await fs.access("/run/systemd/system").then(() => true, () => false)) return
  assert.equal(await systemdUserManagerAvailable({ ...environment, DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" }, "linux"), true)
  await fs.writeFile(path.join(runtimeDir, "bus"), "")
  assert.equal(await systemdUserManagerAvailable(environment, "linux"), true)
  assert.equal(await systemdUserManagerAvailable({ ...environment, PATH: "/nonexistent" }, "linux"), false)
  assert.equal(await systemdUserManagerAvailable({ ...environment, WORK_DAEMON_SYSTEMD: "0" }, "linux"), false)
})

test("reads the unit from cgroup v2 and hybrid cgroup files", () => {
  assert.equal(cgroupUnit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-t3code-agents-43a7.slice/t3code-claude-4809dab3.scope\n"), "t3code-claude-4809dab3.scope")
  assert.equal(cgroupUnit("12:cpu:/\n1:name=systemd:/user.slice/user-1000.slice/session-2.scope\n0::/\n"), null)
  assert.equal(cgroupUnit("12:cpu:/\n1:name=systemd:/user.slice/user-1000.slice/session-2.scope\n"), "session-2.scope")
  assert.equal(cgroupUnit(""), null)
})

test("warns about session scopes but not about workd's own scope or services", () => {
  assert.equal(sessionScope("t3code-claude-4809dab3.scope"), true)
  assert.equal(sessionScope("app-foot-1234.scope"), true)
  assert.equal(sessionScope(`${workdUnitName("/home/me/.work-cli")}.scope`), false)
  assert.equal(sessionScope("work-tests.service"), false)
  assert.equal(sessionScope(proxyLaunchPlan(entrypoint, { systemd: true }).unit), false)
  assert.equal(sessionScope(null), false)
})

test("the Portless proxy gets a scope of its own so it outlives the caller", () => {
  const proxy = { command: "portless", args: ["proxy", "start", "-p", "1355", "--https"] }
  assert.deepEqual(proxyLaunchPlan(proxy, { systemd: false }), { ...proxy, unit: null })
  assert.deepEqual(proxyLaunchPlan(proxy, { systemd: true, now: 1_700_000_000_000 }), {
    command: "systemd-run",
    args: ["--user", "--scope", "--collect", "--quiet", "--unit=work-portless-loyw3v28", "--description=Portless proxy started by work", "--", "portless", "proxy", "start", "-p", "1355", "--https"],
    unit: "work-portless-loyw3v28.scope",
  })
})
