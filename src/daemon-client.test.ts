import { afterEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { daemonStatus, ensureDaemon, sendDaemon, stopDaemon } from "./daemon-client.js"
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
