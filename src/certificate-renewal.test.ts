import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { launchAgentPlist } from "./certificate-renewal.js"
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
