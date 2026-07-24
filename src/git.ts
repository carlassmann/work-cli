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

export type BranchSource =
  | { kind: "local"; branch: string }
  | { kind: "remote"; branch: string; remote: string }
  | { kind: "new"; branch: string; from: string }

export function describeBranchSource(source: BranchSource) {
  switch (source.kind) {
    case "local": return `branch ${source.branch}`
    case "remote": return `${source.remote}/${source.branch}`
    case "new": return source.from
  }
}

export async function resolveBranchSource(root: string, name: string, slug: string, remote?: string): Promise<Result<BranchSource>> {
  if (remote) return await fetchedRemoteBranchSource(root, name, remote)

  if (await localBranchExists(root, name)) return ok({ kind: "local", branch: name })
  if (name !== slug && await localBranchExists(root, slug)) return ok({ kind: "local", branch: slug })

  const remotes = await listRemotes(root)
  if (!remotes.ok) return remotes

  const matches: Array<string> = []
  for (const candidate of remotes.value) {
    if (await remoteBranchExists(root, candidate, name)) matches.push(candidate)
  }

  if (matches.length > 1) {
    return errResult("GitError", `branch ${name} exists on multiple remotes (${matches.join(", ")}). Pass --remote <name> to pick one.`)
  }

  const match = matches[0]
  if (match) {
    await execOk("git", ["fetch", match, name], root)
    return ok({ kind: "remote", branch: name, remote: match })
  }

  return ok({ kind: "new", branch: slug, from: "HEAD" })
}

async function fetchedRemoteBranchSource(root: string, branch: string, remote: string): Promise<Result<BranchSource>> {
  const fetched = await exec("git", ["fetch", remote, branch], root)
  if (!fetched.ok) {
    return errResult("GitError", `failed to fetch ${branch} from ${remote}`, fetched.error)
  }

  if (await localBranchExists(root, branch)) return ok({ kind: "local", branch })

  if (!await remoteBranchExists(root, remote, branch)) {
    return errResult("GitError", `branch ${branch} not found on remote ${remote}`)
  }

  return ok({ kind: "remote", branch, remote })
}

async function localBranchExists(root: string, branch: string) {
  return await execOk("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root)
}

async function remoteBranchExists(root: string, remote: string, branch: string) {
  return await execOk("git", ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], root)
}

async function listRemotes(root: string): Promise<Result<Array<string>>> {
  const result = await exec("git", ["remote"], root)
  if (!result.ok) return errResult("GitError", `failed to list git remotes in ${root}`, result.error)
  return ok(result.value.split("\n").filter(Boolean))
}

export async function createWorktree(root: string, dir: string, source: BranchSource): Promise<Result<void>> {
  const stale = await staleWorktreeRecord(root, dir, source.branch)
  if (!stale.ok) return stale

  const result = await exec("git", worktreeAddArgs(dir, source), root)
  if (!result.ok) {
    return errResult("GitError", `failed to create worktree ${dir} for ${source.branch}`, result.error)
  }

  return ok(undefined)
}

function worktreeAddArgs(dir: string, source: BranchSource) {
  switch (source.kind) {
    case "local": return ["worktree", "add", dir, source.branch]
    case "remote": return ["worktree", "add", "--track", "-b", source.branch, dir, `${source.remote}/${source.branch}`]
    case "new": return ["worktree", "add", "-b", source.branch, dir, source.from]
  }
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
