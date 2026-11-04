import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { childEnvironment } from "./environment.js"
import { errResult, ok } from "./result.js"
import { commandExists } from "./shell.js"
import type { Result } from "./result.js"

const exec = promisify(execFile)
const LAUNCH_AGENT_LABEL = "com.ccssmnn.work.acme-renew"
const LAUNCH_AGENT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
const SYSTEMD_UNIT = "work-acme-renew"

// acme.sh reads these variables to find its state; renewal must use the same ones as issuance.
const ACME_LOCATION_VARIABLES = ["LE_WORKING_DIR", "LE_CONFIG_HOME", "CERT_HOME"] as const

function acmeHome(environment: NodeJS.ProcessEnv) {
  return environment["LE_WORKING_DIR"] || path.join(os.homedir(), ".acme.sh")
}

function acmeCertificateHome(environment: NodeJS.ProcessEnv) {
  return environment["CERT_HOME"] || acmeHome(environment)
}

function launchAgentFile() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`)
}

// acme.sh keeps one directory per certificate it manages, and renews only those.
export async function acmeManagesCertificate(domain: string, environment: NodeJS.ProcessEnv) {
  return fs.access(path.join(acmeCertificateHome(environment), `*.${domain}_ecc`)).then(() => true, () => false)
}

export async function renewalScheduled(environment: NodeJS.ProcessEnv): Promise<boolean> {
  // A plist on disk is not enough: it stays behind when bootstrap fails, so ask launchd.
  if (process.platform === "darwin") {
    return exec("launchctl", ["print", launchdService()], { timeout: 10_000 }).then(() => true, () => false)
  }
  try {
    const { stdout } = await exec("crontab", ["-l"], { env: childEnvironment(environment), timeout: 10_000 })
    if (cronRenewsWithAcme(stdout)) return true
  } catch {
    // No crontab, or no cron at all: the systemd timer may still renew.
  }
  return exec("systemctl", ["--user", "is-enabled", `${SYSTEMD_UNIT}.timer`], { env: childEnvironment(environment), timeout: 10_000 }).then(() => true, () => false)
}

export function cronRenewsWithAcme(crontab: string) {
  return crontab.split("\n").some((line) => {
    const entry = line.trim()
    return entry !== "" && !entry.startsWith("#") && entry.includes("acme.sh") && entry.includes("--cron")
  })
}

function launchdService() {
  return `gui/${os.userInfo().uid}/${LAUNCH_AGENT_LABEL}`
}

// macOS: crontab blocks on a privacy prompt when run outside an interactive terminal,
// so renewal runs from a launchd agent instead. Elsewhere acme.sh installs its own cron job.
export async function scheduleRenewal(
  acme: string,
  environment: NodeJS.ProcessEnv,
  runAcme: (args: Array<string>) => Promise<{ code: number; output: string }>,
): Promise<Result<string>> {
  if (process.platform !== "darwin") {
    // Many Linux desktops ship systemd but no cron, where acme.sh cannot install its job.
    if (!await commandExists("crontab", environment) && await commandExists("systemctl", environment)) {
      return scheduleSystemdTimer(await absoluteCommand(acme, environment), environment)
    }
    const cron = await runAcme(["--install-cronjob"])
    return cron.code === 0 ? ok("acme.sh renews it from cron.") : errResult("ProcessError", `acme.sh could not install its cron job:\n${cron.output.trim()}`)
  }

  const acmePath = await absoluteCommand(acme, environment)
  const file = launchAgentFile()
  const locations = Object.fromEntries(ACME_LOCATION_VARIABLES.flatMap((name) => environment[name] ? [[name, environment[name]]] : []))
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, launchAgentPlist(acmePath, acmeHome(environment), locations))
    await exec("launchctl", ["bootout", launchdService()], { timeout: 10_000 }).catch(() => undefined)
    await exec("launchctl", ["bootstrap", `gui/${os.userInfo().uid}`, file], { timeout: 10_000 })
    return ok("acme.sh renews it daily from a launchd agent.")
  } catch (cause) {
    await fs.rm(file, { force: true })
    return errResult("ProcessError", "could not schedule certificate renewal with launchd", cause)
  }
}

export function launchAgentPlist(acmePath: string, home: string, locations: Record<string, string> = {}) {
  const log = path.join(home, "renew.log")
  const variables = { PATH: LAUNCH_AGENT_PATH, ...locations }
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
${Object.entries(variables).map(([name, value]) => `    <key>${escapeXml(name)}</key>\n    <string>${escapeXml(value)}</string>\n`).join("")}  </dict>
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

async function scheduleSystemdTimer(acmePath: string, environment: NodeJS.ProcessEnv): Promise<Result<string>> {
  const dir = path.join(environment["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config"), "systemd", "user")
  const locations = Object.fromEntries(ACME_LOCATION_VARIABLES.flatMap((name) => environment[name] ? [[name, environment[name]]] : []))
  const units = systemdRenewalUnits(acmePath, acmeHome(environment), locations)
  const files = [path.join(dir, `${SYSTEMD_UNIT}.service`), path.join(dir, `${SYSTEMD_UNIT}.timer`)] as const
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(files[0], units.service)
    await fs.writeFile(files[1], units.timer)
    const env = childEnvironment(environment)
    await exec("systemctl", ["--user", "daemon-reload"], { env, timeout: 10_000 })
    await exec("systemctl", ["--user", "enable", "--now", `${SYSTEMD_UNIT}.timer`], { env, timeout: 10_000 })
    return ok(`acme.sh renews it daily from the systemd user timer ${SYSTEMD_UNIT}.timer.`)
  } catch (cause) {
    await Promise.all(files.map((file) => fs.rm(file, { force: true })))
    return errResult("ProcessError", "could not schedule certificate renewal with a systemd user timer", cause)
  }
}

export function systemdRenewalUnits(acmePath: string, home: string, locations: Record<string, string> = {}) {
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  const environmentLines = Object.entries(locations).map(([name, value]) => `Environment=${quote(`${name}=${value}`)}\n`).join("")
  return {
    service: `[Unit]
Description=Renew work's tailnet preview certificates with acme.sh

[Service]
Type=oneshot
${environmentLines}ExecStart=${quote(acmePath)} --cron --home ${quote(home)}
`,
    timer: `[Unit]
Description=Daily acme.sh renewal for work's tailnet previews

[Timer]
OnCalendar=*-*-* 04:17
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
`,
  }
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
