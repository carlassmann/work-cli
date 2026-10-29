import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { buildCommit } from "./build-info.js"
import { debugLog, describe } from "./result.js"
import { stateRoot } from "./state.js"

const repository = "https://github.com/carlassmann/work-cli"
const api = "https://api.github.com/repos/carlassmann/work-cli"
const checkIntervalMs = 3_600_000
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

export function startUpdateChecker(commit: string | null = buildCommit, fetcher: typeof fetch = fetch): () => void {
  if (!commit || process.env["WORK_NO_UPDATE_CHECK"] === "1") return () => undefined
  const controller = new AbortController()
  let checking = false
  const tick = async () => {
    if (checking || controller.signal.aborted) return
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
    available: `update available: ${status.latestCommit?.slice(0, 7)}\n${repository}/commit/${status.latestCommit}`,
    ahead: "installed commit is ahead of main",
    diverged: "installed commit has diverged from main",
    unknown: "update status unknown: no successful check",
  }
  const stale = status.checkedAt && Date.now() - Date.parse(status.checkedAt) > 24 * checkIntervalMs
  return `${stale ? "stale cached status: " : ""}${messages[status.status]}${status.checkedAt ? `\nlast checked: ${status.checkedAt}` : ""}${status.error ? `\nlast attempt failed: ${status.error}` : ""}`
}
