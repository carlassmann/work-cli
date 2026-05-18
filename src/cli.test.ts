import fs from "node:fs/promises"
import path from "node:path"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { initGitRepo, runCli, tempDir, writeFile } from "./test-helpers.js"

describe("cli", () => {
  test("prints curated help without requiring a git repo", async () => {
    const root = await tempDir()
    const result = await runCli(["--help"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("Worktree-aware local dev command runner."))
    assert.ok(result.stdout.includes("work docs"))
    assert.equal(result.stderr, "")
  })

  test("prints docs topics without requiring config", async () => {
    const root = await tempDir()
    const result = await runCli(["docs", "git"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("work assumes git"))
    assert.ok(result.stdout.includes("work can stay a small orchestration layer"))
  })

  test("init creates config at the git root from a child directory", async () => {
    const root = await tempDir()
    const child = path.join(root, "apps", "web")

    await initGitRepo(root)
    await fs.mkdir(child, { recursive: true })

    const result = await runCli(["init", "My App"], { cwd: child })

    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("created work.config.js for my-app"))
    assert.ok((await fs.readFile(path.join(root, "work.config.js"), "utf8")).includes('project: "my-app"'))
  })

  test("up --no-create fails cleanly for a missing workspace", async () => {
    const root = await tempDir()

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      commands: {},
    }`)

    const result = await runCli(["up", "feature-x", "--no-create"], { cwd: root })

    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes("workspace feature-x does not exist"))
  })

  test("ps aligns columns for long workspace names", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const pid = process.pid

    await writeFile(path.join(stateRoot, "projects", "alkalye", "workspaces", "feat-i18n", "state.json"), JSON.stringify({
      project: "alkalye",
      workspace: "feat-i18n",
      branch: null,
      root,
      commands: {
        sync: {
          id: "sync",
          label: "sync",
          command: "sync",
          cwd: root,
          log: path.join(root, "sync.log"),
          url: "https://sync-feat-i18n-alkalye.localhost",
          startedAt: new Date().toISOString(),
          runner: "process",
          pid,
        },
      },
    }))
    await writeFile(path.join(stateRoot, "projects", "syntwin-mono", "workspaces", "fix-chat-flickering", "state.json"), JSON.stringify({
      project: "syntwin-mono",
      workspace: "fix-chat-flickering",
      branch: null,
      root,
      commands: {
        livekit: {
          id: "livekit",
          label: "livekit",
          command: "livekit",
          cwd: root,
          log: path.join(root, "livekit.log"),
          url: null,
          startedAt: new Date().toISOString(),
          runner: "process",
          pid,
        },
      },
    }))

    const result = await runCli(["ps"], { cwd: root, stateRoot })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stderr, "")
    assert.ok(!result.stdout.includes("\t"))

    const lines = result.stdout.trimEnd().split("\n")
    assert.equal(lines.length, 2)
    assert.equal(lines[0].indexOf("sync"), lines[1].indexOf("livekit"))
    assert.equal(lines[0].indexOf("process"), lines[1].indexOf("process"))
    assert.equal(lines[0].indexOf(String(pid)), lines[1].indexOf(String(pid)))
  })

  test("up --create creates a worktree and runs setup with workspace env", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const setupFile = path.join(root, "setup-env.json")
    const setupCommand = `node -e 'require("fs").writeFileSync(${JSON.stringify(setupFile)}, JSON.stringify({ project: process.env.WORK_PROJECT, workspace: process.env.WORK_WORKSPACE, root: process.env.WORK_ROOT }))'`

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
        project: "tilly",
        worktrees: {
          dir: "worktrees",
          setup: ${JSON.stringify(setupCommand)},
        },
        commands: {},
      }`)

    const result = await runCli(["up", "feature-x", "--create"], { cwd: root, stateRoot })

    assert.equal(result.stderr, "")
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("setup feature-x"))
    assert.partialDeepStrictEqual(JSON.parse(await fs.readFile(setupFile, "utf8")), {
      project: "tilly",
      workspace: "feature-x",
      root: await fs.realpath(path.join(root, "worktrees", "feature-x")),
    })
  })
})
