import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { createWorktree, parseWorktreeList } from "./git.js"
import { initGitRepo, tempDir } from "./test-helpers.js"

const execFileAsync = promisify(execFile)

describe("git worktrees", () => {
  test("explains stale worktree metadata before create", async () => {
    const root = await tempDir()
    const dir = path.join(root, "worktrees", "test")

    await initGitRepo(root)
    await execFileAsync("git", ["worktree", "add", "-b", "test", dir], { cwd: root })
    await fs.rm(dir, { recursive: true, force: true })

    const result = await createWorktree(root, dir, { kind: "local", branch: "test" })

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error.message, /stale git worktree metadata for test/)
      assert.match(result.error.message, /git -C .* worktree prune/)
    }
  })

  test("parses porcelain worktree output with CRLF line endings", () => {
    const crlfOutput = [
      "worktree /repo/main\r",
      "HEAD 1234567890\r",
      "branch refs/heads/main\r",
      "\r",
      "worktree /repo/worktrees/feature\r",
      "HEAD abcdef1234\r",
      "branch refs/heads/feature\r",
      "prunable gitdir file points to non-existent location\r",
    ].join("\n")

    const parsed = parseWorktreeList(crlfOutput)
    assert.equal(parsed.length, 2)
    assert.equal(parsed[0]?.worktree, "/repo/main")
    assert.equal(parsed[0]?.branch, "refs/heads/main")
    assert.equal(parsed[1]?.worktree, "/repo/worktrees/feature")
    assert.equal(parsed[1]?.branch, "refs/heads/feature")
    assert.equal(parsed[1]?.prunable, "gitdir file points to non-existent location")
  })
})
