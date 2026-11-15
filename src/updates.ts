import fs from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildCommit } from "./build-info.js"
import { debugLog, describe } from "./result.js"
import { stateRoot } from "./state.js"

const repository = "https://github.com/carlassmann/work-cli"
const api = "https://api.github.com/repos/carlassmann/work-cli"
const checkIntervalMs = 3_600_000
const noticeIntervalMs = 24 * checkIntervalMs
const commitPattern = /^[a-f0-9]{40}$/
const statuses = ["current", "available", "ahead", "diverged", "unknown"] as const

type UpdateState = (typeof statuses)[number]

export type UpdateStatus = {
  installedCommit: string
  latestCommit: string | null
  checkedAt: string | null
  attemptedAt: string
  status: UpdateState
  error?: string
}

function cacheFile() {
  return path.join(stateRoot(), "updates.json")
}

export async function readUpdateStatus(commit: string | null = buildCommit): Promise<UpdateStatus | null> {
  if (!commit) return null
  try {
    const value = JSON.parse(await fs.readFile(cacheFile(), "utf8")) as UpdateStatus
    if (!value || value.installedCommit !== commit || !commitPattern.test(value.installedCommit) ||
      !statuses.includes(value.status) || !validTimestamp(value.attemptedAt) ||
      (value.latestCommit !== null && !commitPattern.test(value.latestCommit)) ||
      (value.checkedAt !== null && !validTimestamp(value.checkedAt)) ||
      (value.status !== "unknown" && (!value.latestCommit || !value.checkedAt)) ||
      (value.error !== undefined && typeof value.error !== "string")) return null
    return value
  } catch {
    return null
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

export async function checkForUpdates(
  commit: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<UpdateStatus> {
  const previous = await readUpdateStatus(commit)
  let result: UpdateStatus = {
    installedCommit: commit,
    latestCommit: null,
    checkedAt: null,
    status: "unknown",
    ...previous,
    attemptedAt: new Date().toISOString(),
  }
  try {
    const latest = await githubJson(`${api}/commits/main`, fetcher, signal)
    const latestCommit = latest["sha"]
    if (typeof latestCommit !== "string" || !commitPattern.test(latestCommit)) throw new Error("invalid latest commit")
    let status: UpdateState = "current"
    if (commit !== latestCommit) {
      const comparison = await githubJson(`${api}/compare/${commit}...${latestCommit}`, fetcher, signal)
      switch (comparison["status"]) {
        case "ahead": status = "available"; break
        case "behind": status = "ahead"; break
        case "diverged": status = "diverged"; break
        case "identical": status = "current"; break
        default: throw new Error("invalid commit comparison")
      }
    }
    result = { installedCommit: commit, latestCommit, status, attemptedAt: result.attemptedAt, checkedAt: new Date().toISOString() }
  } catch (cause) {
    if (signal?.aborted) throw cause
    result.error = describe(cause)
    debugLog("updates", `check failed: ${result.error}`)
  }

  signal?.throwIfAborted()
  await fs.mkdir(stateRoot(), { recursive: true, mode: 0o700 })
  const temporaryFile = `${cacheFile()}.tmp.${process.pid}.${randomUUID()}`
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
    signal?.throwIfAborted()
    await fs.rename(temporaryFile, cacheFile())
  } finally {
    await fs.rm(temporaryFile, { force: true })
  }
  return result
}

async function githubJson(url: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(5000)
  const response = await fetcher(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: "application/vnd.github+json", "User-Agent": "work-cli", "X-GitHub-Api-Version": "2026-03-10" },
  })
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`)
  const data: unknown = await response.json()
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid GitHub response")
  return data as Record<string, unknown>
}

// installedCommit is read on every tick, so a long-lived workd can check the build now on disk after a rebuild.
export function startUpdateChecker(
  initialCommit: string | null = buildCommit,
  fetcher: typeof fetch = fetch,
  installedCommit: () => string | null = () => initialCommit,
): () => void {
  if (!initialCommit || process.env["WORK_NO_UPDATE_CHECK"] === "1") return () => undefined
  const controller = new AbortController()
  let checking = false
  const tick = async () => {
    if (checking || controller.signal.aborted) return
    const commit = installedCommit()
    if (!commit) return
    checking = true
    try {
      const cached = await readUpdateStatus(commit)
      if (cached && Date.now() - Date.parse(cached.attemptedAt) < checkIntervalMs) return
      await checkForUpdates(commit, fetcher, controller.signal)
    } catch (cause) {
      if (!controller.signal.aborted) debugLog("updates", `cache refresh failed: ${describe(cause)}`)
    } finally {
      checking = false
    }
  }
  const timer = setInterval(() => void tick(), 60_000).unref()
  void tick()
  return () => {
    clearInterval(timer)
    controller.abort()
  }
}

export function formatUpdateStatus(status: UpdateStatus | null, commit: string | null = buildCommit): string {
  if (!commit) return "update status unknown: this build has no commit metadata"
  if (!status) return "update status unknown: no cached check for this build; run work daemon start"
  const messages: Record<UpdateState, string> = {
    current: "up to date with main",
    available: `update available: ${status.latestCommit?.slice(0, 7)}\n${repository}/commit/${status.latestCommit}\nupdate with: ${updateCommand()}`,
    ahead: "installed commit is ahead of main",
    diverged: "installed commit has diverged from main",
    unknown: "update status unknown: no successful check",
  }
  const stale = status.checkedAt && Date.now() - Date.parse(status.checkedAt) > 24 * checkIntervalMs
  return `${stale ? "stale cached status: " : ""}${messages[status.status]}${status.checkedAt ? `\nlast checked: ${status.checkedAt}` : ""}${status.error ? `\nlast attempt failed: ${status.error}` : ""}`
}

function packageRoot() {
  return fileURLToPath(new URL("../", import.meta.url))
}

export function installedBuildCommit(file = path.join(packageRoot(), "dist", "build-info.js")): string | null {
  try {
    const match = /buildCommit = "([a-f0-9]{40})"/.exec(readFileSync(file, "utf8"))
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export function updateCommand(root = packageRoot()): string {
  if (!existsSync(path.join(root, ".git"))) return `reinstall from ${repository}#install`
  const directory = root.replace(/\/$/, "")
  const quoted = /^[\w./-]+$/.test(directory) ? directory : `'${directory.replaceAll("'", "'\\''")}'`
  return `cd ${quoted} && git pull && bun install && bun run build && work daemon stop && work daemon start`
}

function noticeFile() {
  return path.join(stateRoot(), "update-notice.json")
}

// Shown at most once a day per available commit, so agents and humans notice an outdated build without noise.
export async function takeUpdateNotice(commit: string | null = buildCommit, now = Date.now()): Promise<string | null> {
  if (process.env["WORK_NO_UPDATE_CHECK"] === "1") return null
  const status = await readUpdateStatus(commit)
  if (status?.status !== "available" || !status.latestCommit) return null
  try {
    const shown = JSON.parse(await fs.readFile(noticeFile(), "utf8")) as { latestCommit?: unknown; shownAt?: unknown }
    if (shown.latestCommit === status.latestCommit && typeof shown.shownAt === "string" && now - Date.parse(shown.shownAt) < noticeIntervalMs) return null
  } catch {
    // no notice shown yet
  }
  try {
    await fs.writeFile(noticeFile(), `${JSON.stringify({ latestCommit: status.latestCommit, shownAt: new Date(now).toISOString() })}\n`, { mode: 0o600 })
  } catch {
    return null
  }
  return availableUpdateLine(status)
}

export async function outdatedBuildHint(commit: string | null = buildCommit): Promise<string | null> {
  if (process.env["WORK_NO_UPDATE_CHECK"] === "1") return null
  const status = await readUpdateStatus(commit)
  if (status?.status !== "available") return null
  return `your work build may be outdated: ${availableUpdateLine(status)}`
}

function availableUpdateLine(status: UpdateStatus) {
  return `work ${status.latestCommit?.slice(0, 7)} available (installed ${status.installedCommit.slice(0, 7)}). Update: ${updateCommand()}`
}
