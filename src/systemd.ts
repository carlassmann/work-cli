import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { commandExists, existsAt } from "./shell.js"

const WORK_UNIT_PREFIX = "work-"
const WORKD_UNIT_PREFIX = `${WORK_UNIT_PREFIX}workd-`
const PROXY_UNIT_PREFIX = `${WORK_UNIT_PREFIX}portless-`

type Entrypoint = { command: string; args: Array<string> }

export type DaemonLaunch = Entrypoint & { unit: string | null }

// A detached child still lives in the caller's cgroup, so systemd kills workd and every
// command it supervises when the caller's scope stops (an agent thread, a terminal tab).
// systemd-run --scope moves workd into its own scope and then execs it, so workd keeps
// the caller's environment, cwd and stderr pipe, and its commands follow it into the scope.
export function daemonLaunchPlan(entrypoint: Entrypoint, options: { systemd: boolean; stateRoot: string; now?: number }): DaemonLaunch {
  if (!options.systemd) return { ...entrypoint, unit: null }

  return scopeLaunch(entrypoint, workdUnitName(options.stateRoot, options.now), `work daemon for ${options.stateRoot}`)
}

// The Portless proxy outlives the work command that starts it, so it gets its own scope
// for the same reason workd does: in the caller's scope it dies with the agent thread or
// terminal that happened to start it, and takes every routed URL down with it.
export function proxyLaunchPlan(entrypoint: Entrypoint, options: { systemd: boolean; now?: number }): DaemonLaunch {
  if (!options.systemd) return { ...entrypoint, unit: null }
  return scopeLaunch(entrypoint, `${PROXY_UNIT_PREFIX}${(options.now ?? Date.now()).toString(36)}`, "Portless proxy started by work")
}

// systemd-run --scope moves the command into a new scope and then execs it; whatever it
// forks or daemonizes stays in that scope after systemd-run returns.
function scopeLaunch(entrypoint: Entrypoint, unit: string, description: string): DaemonLaunch {
  return {
    command: "systemd-run",
    args: ["--user", "--scope", "--collect", "--quiet", `--unit=${unit}`, `--description=${description}`, "--", entrypoint.command, ...entrypoint.args],
    unit: `${unit}.scope`,
  }
}

// The state root hash keeps isolated state dirs apart. The time suffix lets a new workd
// start while the scope of a replaced one still holds the commands it started.
export function workdUnitName(stateRoot: string, now = Date.now()) {
  const hash = crypto.createHash("sha256").update(path.resolve(stateRoot)).digest("hex").slice(0, 8)
  return `${WORKD_UNIT_PREFIX}${hash}-${now.toString(36)}`
}

export async function systemdUserManagerAvailable(environment: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  if (platform !== "linux" || environment["WORK_DAEMON_SYSTEMD"] === "0") return false
  if (!await existsAt("/run/systemd/system")) return false
  const runtimeDir = environment["XDG_RUNTIME_DIR"]
  const bus = Boolean(environment["DBUS_SESSION_BUS_ADDRESS"]) || (runtimeDir ? await existsAt(path.join(runtimeDir, "bus")) : false)
  return bus && await commandExists("systemd-run", environment)
}

export async function processUnit(pid: number) {
  try {
    return cgroupUnit(await fs.readFile(`/proc/${pid}/cgroup`, "utf8"))
  } catch {
    return null
  }
}

export function cgroupUnit(cgroup: string) {
  const lines = cgroup.split("\n")
  const line = lines.find((entry) => entry.startsWith("0::")) ?? lines.find((entry) => entry.includes(":name=systemd:"))
  const unit = line?.slice(line.indexOf(":/") + 1).split("/").pop()
  return unit || null
}

// Scopes other than the ones work creates belong to a terminal, IDE or agent session and
// are stopped, with everything inside, when that session ends.
export function sessionScope(unit: string | null) {
  return unit !== null && unit.endsWith(".scope") && !unit.startsWith(WORK_UNIT_PREFIX)
}
