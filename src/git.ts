import path from "node:path"
import { exec, execOk, existsAt } from "./shell.js"
import { slugify } from "./names.js"
import { errResult, ok } from "./result.js"
import type { Result } from "./result.js"

export async function gitRoot(cwd: string): Promise<Result<string>> {
  const result = await exec("git", ["rev-parse", "--show-toplevel"], cwd)

  if (!result.ok) {
    return errResult("GitError", `not a git repository: ${cwd}`, result.error)
  }

  return ok(result.value)
}

export async function gitMainWorktree(cwd: string): Promise<Result<string>> {
  const result = await exec("git", ["worktree", "list", "--porcelain"], cwd)

  if (!result.ok) {
    return errResult("GitError", `failed to list git worktrees from ${cwd}`, result.error)
  }

  const firstLine = result.value.split("\n", 1)[0] ?? ""
  if (!firstLine.startsWith("worktree ")) {
    return errResult("GitError", `unexpected output from git worktree list: ${result.value.slice(0, 120)}`)
  }

  return ok(firstLine.slice("worktree ".length))
}

export async function gitBranch(cwd: string): Promise<Result<string | null>> {
  const result = await exec("git", ["branch", "--show-current"], cwd)

  if (!result.ok) {
    return errResult("GitError", `failed to read current branch in ${cwd}`, result.error)
  }

  return ok(result.value || null)
}

export async function workspaceFromGit(cwd: string): Promise<Result<string>> {
  const branch = await gitBranch(cwd)

  if (!branch.ok) return branch

  if (branch.value) {
    return ok(slugify(branch.value))
  }

  const root = await gitRoot(cwd)
  if (!root.ok) return root

  return ok(path.basename(root.value))
}

export async function createWorktree(root: string, dir: string, branch: string, from?: string): Promise<Result<void>> {
  const stale = await staleWorktreeRecord(root, dir, branch)
  if (!stale.ok) return stale

  const exists = await execOk("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root)
  const args = exists
    ? ["worktree", "add", dir, branch]
    : ["worktree", "add", "-b", branch, dir, from ?? "HEAD"]

  const result = await exec("git", args, root)
  if (!result.ok) {
    return errResult("GitError", `failed to create worktree ${dir} for ${branch}`, result.error)
  }

  return ok(undefined)
}

async function staleWorktreeRecord(root: string, dir: string, branch: string): Promise<Result<void>> {
  const list = await exec("git", ["worktree", "list", "--porcelain"], root)
  if (!list.ok) return errResult("GitError", `failed to inspect git worktrees from ${root}`, list.error)

  const record = parseWorktreeList(list.value)
    .find((item) => item.worktree === dir || item.branch === `refs/heads/${branch}`)

  if (!record) return ok(undefined)
  if (await existsAt(record.worktree)) return ok(undefined)

  const reason = record.prunable ? ` (${record.prunable})` : ""
  return errResult("GitError", [
    `stale git worktree metadata for ${branch}: Git still tracks ${record.worktree}, but the directory is missing${reason}.`,
    `Run: git -C ${root} worktree prune`,
    "Then retry the work command.",
  ].join("\n"))
}

function parseWorktreeList(output: string) {
  const records: Array<{ worktree: string; branch?: string; prunable?: string }> = []
  let current: { worktree: string; branch?: string; prunable?: string } | null = null

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current)
      current = { worktree: line.slice("worktree ".length) }
      continue
    }

    if (!current) continue

    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length)
    } else if (line.startsWith("prunable")) {
      current.prunable = line.slice("prunable".length).trim()
    }
  }

  if (current) records.push(current)
  return records
}
