import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { createWorktree } from "./git.js"
import { initGitRepo, tempDir } from "./test-helpers.js"

const execFileAsync = promisify(execFile)

describe("git worktrees", () => {
  test("explains stale worktree metadata before create", async () => {
    const root = await tempDir()
    const dir = path.join(root, "worktrees", "test")

    await initGitRepo(root)
    await execFileAsync("git", ["worktree", "add", "-b", "test", dir], { cwd: root })
    await fs.rm(dir, { recursive: true, force: true })

    const result = await createWorktree(root, dir, "test")

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error.message, /stale git worktree metadata for test/)
      assert.match(result.error.message, /git -C .* worktree prune/)
    }
  })
})
