import fs from "node:fs/promises"
import path from "node:path"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { initGitRepo, runCli, tempDir, writeFile } from "./test-helpers.js"

describe("completions", () => {
  test("emits zsh script with subcommands and shebang", async () => {
    const root = await tempDir()
    const result = await runCli(["completions", "zsh"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("#compdef work"))
    assert.ok(result.stdout.includes("'up:Start workspace commands'"))
    assert.ok(result.stdout.includes("compdef _work work"))
    assert.ok(result.stdout.includes("return 0"))
  })

  test("emits bash script with complete -F", async () => {
    const root = await tempDir()
    const result = await runCli(["completions", "bash"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("_work()"))
    assert.ok(result.stdout.includes("complete -F _work work"))
    assert.ok(result.stdout.includes("work _complete workspaces"))
  })

  test("rejects unsupported shells", async () => {
    const root = await tempDir()
    const result = await runCli(["completions", "fish"], { cwd: root })

    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes("unsupported shell"))
  })

  test("help creates completion directories before redirecting", async () => {
    const root = await tempDir()
    const result = await runCli(["completions", "--help"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("mkdir -p ~/.zsh/completions"))
    assert.ok(result.stdout.includes("mkdir -p ~/.local/share/bash-completion/completions"))
  })

  test("_complete returns workspaces from worktree dir and configured commands", async () => {
    const root = await tempDir()

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "demo",
      worktrees: { dir: "worktrees" },
      commands: {
        web: { run: "echo" },
        sync: { run: "echo" },
      },
    }`)
    await fs.mkdir(path.join(root, "worktrees", "feature-a"), { recursive: true })
    await fs.mkdir(path.join(root, "worktrees", "feature-b"), { recursive: true })

    const result = await runCli(["_complete", "workspaces", "commands"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.stdout.trim().split("\n").sort(), ["feature-a", "feature-b", "sync", "web"])
  })

  test("_complete silently returns empty outside a git repo", async () => {
    const root = await tempDir()
    const result = await runCli(["_complete", "workspaces", "commands"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), "")
  })

  test("_complete returns static lists without config", async () => {
    const root = await tempDir()
    const result = await runCli(["_complete", "help-topics", "shells"], { cwd: root })

    assert.equal(result.exitCode, 0)
    const lines = result.stdout.trim().split("\n")
    assert.ok(lines.includes("config"))
    assert.ok(lines.includes("run"))
    assert.ok(lines.includes("zsh"))
  })

  test("_complete returns state commands outside a configured project", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")

    await writeFile(path.join(stateRoot, "projects", "demo", "workspaces", "feature-a", "state.json"), JSON.stringify({
      project: "demo",
      workspace: "feature-a",
      branch: null,
      root,
      commands: {
        web: {
          id: "web",
          label: "web",
          command: "web",
          run: "web",
          route: null,
          cwd: root,
          log: path.join(root, "web.log"),
          url: null,
          startedAt: new Date().toISOString(),
          pid: 99999999,
        },
      },
    }))

    const result = await runCli(["_complete", "workspaces", "commands"], { cwd: root, stateRoot })

    assert.equal(result.exitCode, 0)
    const lines = result.stdout.trim().split("\n")
    assert.ok(lines.includes("feature-a"))
    assert.ok(lines.includes("web"))
  })

  test("_complete configured excludes state-only commands", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "demo",
      commands: {
        web: { run: "echo" },
      },
    }`)
    await writeFile(path.join(stateRoot, "projects", "demo", "workspaces", "main", "state.json"), JSON.stringify({
      project: "demo",
      workspace: "main",
      branch: null,
      root,
      commands: {
        agent: {
          id: "agent",
          label: "agent",
          command: "agent",
          run: "agent",
          route: null,
          cwd: root,
          log: path.join(root, "agent.log"),
          url: null,
          startedAt: new Date().toISOString(),
          pid: 99999999,
        },
      },
    }))

    const result = await runCli(["_complete", "configured"], { cwd: root, stateRoot })

    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.stdout.trim().split("\n"), ["web"])
  })

  test("shell-init zsh includes wrapper and completion", async () => {
    const root = await tempDir()
    const result = await runCli(["shell-init", "zsh"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes('"$1" == "cd"'))
    assert.ok(result.stdout.includes("builtin cd"))
    assert.ok(result.stdout.includes("#compdef work"))
  })

  test("shell-init bash includes wrapper and completion", async () => {
    const root = await tempDir()
    const result = await runCli(["shell-init", "bash"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes('"$1" == "cd"'))
    assert.ok(result.stdout.includes("complete -F _work work"))
  })

  test("cd prints absolute worktree path for an existing workspace", async () => {
    const root = await tempDir()

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "demo",
      worktrees: { dir: "worktrees" },
      commands: {},
    }`)
    await fs.mkdir(path.join(root, "worktrees", "feature-a"), { recursive: true })

    const result = await runCli(["cd", "feature-a"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), path.join(await fs.realpath(root), "worktrees", "feature-a"))
  })

  test("cd without arg prints current workspace root", async () => {
    const root = await tempDir()

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "demo",
      commands: {},
    }`)

    const result = await runCli(["cd"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), await fs.realpath(root))
  })

  test("cd fails with non-zero exit for missing workspace", async () => {
    const root = await tempDir()

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "demo",
      worktrees: { dir: "worktrees" },
      commands: {},
    }`)

    const result = await runCli(["cd", "nonexistent"], { cwd: root })

    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes("workspace nonexistent does not exist"))
  })

  test("_complete deduplicates across kinds", async () => {
    const root = await tempDir()
    const result = await runCli(["_complete", "shells", "shells"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.stdout.trim().split("\n").sort(), ["bash", "zsh"])
  })
})
