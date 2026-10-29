import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { childEnvironment } from "./environment.js"
import { errResult, ok } from "./result.js"
import type { Result } from "./result.js"

const exec = promisify(execFile)
const LAUNCH_AGENT_LABEL = "com.ccssmnn.work.acme-renew"
const LAUNCH_AGENT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

function acmeHome() {
  return path.join(os.homedir(), ".acme.sh")
}

function launchAgentFile() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`)
}

// acme.sh keeps one directory per certificate it manages, and renews only those.
export async function acmeManagesCertificate(domain: string) {
  return fs.access(path.join(acmeHome(), `*.${domain}_ecc`)).then(() => true, () => false)
}

export async function renewalScheduled(environment: NodeJS.ProcessEnv): Promise<boolean> {
  if (process.platform === "darwin") return fs.access(launchAgentFile()).then(() => true, () => false)
  try {
    const { stdout } = await exec("crontab", ["-l"], { env: childEnvironment(environment), timeout: 10_000 })
    return stdout.includes("acme.sh") && stdout.includes("--cron")
  } catch {
    return false
  }
}

// macOS: crontab blocks on a privacy prompt when run outside an interactive terminal,
// so renewal runs from a launchd agent instead. Elsewhere acme.sh installs its own cron job.
export async function scheduleRenewal(
  acme: string,
  environment: NodeJS.ProcessEnv,
  runAcme: (args: Array<string>) => Promise<{ code: number; output: string }>,
): Promise<Result<string>> {
  if (process.platform !== "darwin") {
    const cron = await runAcme(["--install-cronjob"])
    return cron.code === 0 ? ok("acme.sh renews it from cron.") : errResult("ProcessError", `acme.sh could not install its cron job:\n${cron.output.trim()}`)
  }

  const acmePath = await absoluteCommand(acme, environment)
  const file = launchAgentFile()
  const domain = `gui/${os.userInfo().uid}`
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, launchAgentPlist(acmePath, acmeHome()))
    await exec("launchctl", ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`], { timeout: 10_000 }).catch(() => undefined)
    await exec("launchctl", ["bootstrap", domain, file], { timeout: 10_000 })
    return ok("acme.sh renews it daily from a launchd agent.")
  } catch (cause) {
    return errResult("ProcessError", `could not schedule certificate renewal with launchd (${file})`, cause)
  }
}

export function launchAgentPlist(acmePath: string, home: string) {
  const log = path.join(home, "renew.log")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(acmePath)}</string>
    <string>--cron</string>
    <string>--home</string>
    <string>${escapeXml(home)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${LAUNCH_AGENT_PATH}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(log)}</string>
</dict>
</plist>
`
}

async function absoluteCommand(command: string, environment: NodeJS.ProcessEnv) {
  if (path.isAbsolute(command)) return command
  try {
    const { stdout } = await exec("/usr/bin/which", [command], { env: childEnvironment(environment), timeout: 5_000 })
    return stdout.trim() || command
  } catch {
    return command
  }
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
