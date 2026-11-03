import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { debugLog, describe } from "./result.js"

const execFileAsync = promisify(execFile)

// Summarizes the worktree so the daemon can tell whether anything changed since the last check:
// HEAD, every changed or untracked path, and each such file's size and mtime, so further edits to an
// already-dirty file still count. Returns null when the root is not a git worktree.
export async function worktreeFingerprint(root: string): Promise<string | null> {
  let head: string
  let status: string
  try {
    const options = { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }
    // --no-optional-locks keeps git from refreshing the index, so the user's own git commands never hit index.lock.
    const [headResult, statusResult] = await Promise.all([
      execFileAsync("git", ["--no-optional-locks", "rev-parse", "HEAD"], options).catch(() => ({ stdout: "" })),
      execFileAsync("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], options),
    ])
    head = headResult.stdout.trim()
    status = statusResult.stdout
  } catch (cause) {
    debugLog("activity", `git status in ${root} failed: ${describe(cause)}`)
    return null
  }

  const hash = crypto.createHash("sha256").update(head).update("\0").update(status)
  for (const file of changedPaths(status)) {
    try {
      const stat = await fs.lstat(path.join(root, file))
      hash.update(`\0${file}:${stat.size}:${stat.mtimeMs}`)
    } catch {
      hash.update(`\0${file}:missing`)
    }
  }
  return hash.digest("hex")
}

function changedPaths(status: string): Array<string> {
  const entries = status.split("\0")
  const paths: Array<string> = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] ?? ""
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    // Renames and copies are followed by their source path.
    if (/[RC]/.test(entry.slice(0, 2))) index++
  }
  return paths
}
