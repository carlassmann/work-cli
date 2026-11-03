import { describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { worktreeFingerprint } from "./worktree-activity.js"
import { tempDir } from "./test-helpers.js"

const execFileAsync = promisify(execFile)

describe("worktreeFingerprint", () => {
  test("changes with new files, further edits, and commits, but not on its own", async () => {
    const root = await tempDir()
    const git = (...args: Array<string>) => execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root })
    await git("init", "-q")
    const empty = await worktreeFingerprint(root)
    assert.ok(empty)
    assert.equal(await worktreeFingerprint(root), empty)

    await fs.writeFile(path.join(root, "a.txt"), "one\n")
    const dirty = await worktreeFingerprint(root)
    assert.notEqual(dirty, empty)
    assert.equal(await worktreeFingerprint(root), dirty)

    await fs.writeFile(path.join(root, "a.txt"), "two!\n")
    const edited = await worktreeFingerprint(root)
    assert.notEqual(edited, dirty)

    await git("add", "a.txt")
    await git("commit", "-q", "-m", "first")
    const committed = await worktreeFingerprint(root)
    assert.notEqual(committed, edited)
    assert.notEqual(committed, empty)
  })

  test("ignores gitignored files and returns null outside a git worktree", async () => {
    const root = await tempDir()
    await execFileAsync("git", ["init", "-q"], { cwd: root })
    await fs.writeFile(path.join(root, ".gitignore"), "build/\n")
    const before = await worktreeFingerprint(root)
    await fs.mkdir(path.join(root, "build"))
    await fs.writeFile(path.join(root, "build", "out.js"), "x")
    assert.equal(await worktreeFingerprint(root), before)

    assert.equal(await worktreeFingerprint(await tempDir()), null)
  })
})
