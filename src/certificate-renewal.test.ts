import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cronRenewsWithAcme, launchAgentPlist } from "./certificate-renewal.js"
import { runWithTimeout } from "./tailscale-setup.js"
import { tempDir } from "./test-helpers.js"

const execFileAsync = promisify(execFile)

test("launchd agent runs acme.sh --cron daily with an explicit home and PATH", async (t) => {
  const plist = launchAgentPlist("/opt/homebrew/bin/acme.sh", "/Users/me/.acme.sh")
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/acme\.sh<\/string>\s*<string>--cron<\/string>\s*<string>--home<\/string>\s*<string>\/Users\/me\/\.acme\.sh<\/string>/)
  assert.match(plist, /<key>PATH<\/key>\s*<string>[^<]*\/opt\/homebrew\/bin/)
  assert.match(plist, /<key>StartCalendarInterval<\/key>/)

  if (process.platform !== "darwin") return
  const dir = await tempDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "agent.plist")
  await fs.writeFile(file, plist)
  await execFileAsync("plutil", ["-lint", file])
})

test("launchd agent passes custom acme.sh locations through", () => {
  const plist = launchAgentPlist("/usr/local/bin/acme.sh", "/srv/acme", { LE_WORKING_DIR: "/srv/acme", CERT_HOME: "/srv/certs" })
  assert.match(plist, /<string>--home<\/string>\s*<string>\/srv\/acme<\/string>/)
  assert.match(plist, /<key>CERT_HOME<\/key>\s*<string>\/srv\/certs<\/string>/)
  assert.match(plist, /<key>LE_WORKING_DIR<\/key>\s*<string>\/srv\/acme<\/string>/)
})

test("only an active cron entry counts as acme.sh renewal", () => {
  assert.equal(cronRenewsWithAcme(`17 4 * * * "/root/.acme.sh"/acme.sh --cron --home "/root/.acme.sh" > /dev/null`), true)
  assert.equal(cronRenewsWithAcme(`# 17 4 * * * acme.sh --cron`), false)
  assert.equal(cronRenewsWithAcme(`0 1 * * * acme.sh --upgrade\n0 2 * * * backup --cron`), false)
  assert.equal(cronRenewsWithAcme(""), false)
})

test("a timeout stops descendants that keep the output open, and fails the run", async () => {
  const startedAt = performance.now()
  const result = await runWithTimeout("sh", ["-c", "sleep 30 & exit 0"], process.env, 300)
  assert.equal(result.code, -1)
  assert.match(result.output, /did not finish/)
  assert.ok(performance.now() - startedAt < 5_000)
})
