import fs from "node:fs/promises"
import path from "node:path"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { initGitRepo, runCli, tempDir, writeFile } from "./test-helpers.js"

const fakeTmuxBin = path.resolve(import.meta.dirname, "test-fixtures/tmux-fake.sh")

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

  test("create creates a worktree without setup or commands", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const setupFile = path.join(root, "setup-env.json")
    const setupCommand = `node -e 'require("fs").writeFileSync(${JSON.stringify(setupFile)}, "ran")'`

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      worktrees: {
        dir: "worktrees",
        setup: ${JSON.stringify(setupCommand)},
      },
      commands: {
        web: {
          run: "node -e 'setTimeout(() => {}, 10_000)'",
          autoStart: true,
        },
      },
    }`)

    const result = await runCli(["create", "feature-x"], { cwd: root, stateRoot })

    assert.equal(result.stderr, "")
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("created feature-x"))
    assert.ok(await fs.stat(path.join(root, "worktrees", "feature-x")))
    await assert.rejects(fs.stat(setupFile))
    await assert.rejects(fs.stat(path.join(stateRoot, "projects", "tilly", "workspaces", "feature-x", "state.json")))
  })

  test("ps -a aligns columns for long workspace names", async () => {
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

    const result = await runCli(["ps", "-a"], { cwd: root, stateRoot })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stderr, "")
    assert.ok(!result.stdout.includes("\t"))

    const lines = result.stdout.trimEnd().split("\n")
    assert.equal(lines.length, 2)
    assert.equal(lines[0].indexOf("sync"), lines[1].indexOf("livekit"))
    assert.equal(lines[0].indexOf("process"), lines[1].indexOf("process"))
    assert.equal(lines[0].indexOf(String(pid)), lines[1].indexOf(String(pid)))
  })

  test("ps defaults to the current workspace", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const pid = process.pid

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      commands: {},
    }`)
    await writeFile(path.join(stateRoot, "projects", "tilly", "workspaces", "main", "state.json"), JSON.stringify({
      project: "tilly",
      workspace: "main",
      branch: "main",
      root,
      commands: {
        web: {
          id: "web",
          label: "web",
          command: "web",
          cwd: root,
          log: path.join(root, "web.log"),
          url: null,
          startedAt: new Date().toISOString(),
          runner: "process",
          pid,
        },
      },
    }))
    await writeFile(path.join(stateRoot, "projects", "tilly", "workspaces", "other", "state.json"), JSON.stringify({
      project: "tilly",
      workspace: "other",
      branch: "other",
      root: path.join(root, "worktrees", "other"),
      commands: {
        api: {
          id: "api",
          label: "api",
          command: "api",
          cwd: root,
          log: path.join(root, "api.log"),
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
    assert.ok(result.stdout.includes("tilly/main"))
    assert.ok(result.stdout.includes("web"))
    assert.ok(!result.stdout.includes("tilly/other"))
    assert.ok(!result.stdout.includes("api"))
  })

  test("state commands work outside a configured project", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const log = path.join(root, "web.log")

    await writeFile(log, "hello from state\n")
    await writeFile(path.join(stateRoot, "projects", "tilly", "workspaces", "feature-x", "state.json"), JSON.stringify({
      project: "tilly",
      workspace: "feature-x",
      branch: null,
      root,
      commands: {
        web: {
          id: "web",
          label: "web",
          command: "bun run dev",
          cwd: root,
          log,
          url: "https://web-feature-x-tilly.localhost",
          startedAt: new Date().toISOString(),
          runner: "process",
          pid: 99999999,
        },
      },
    }))

    const urls = await runCli(["urls"], { cwd: root, stateRoot })
    assert.equal(urls.exitCode, 0)
    assert.ok(urls.stdout.includes("tilly/feature-x"))
    assert.ok(urls.stdout.includes("https://web-feature-x-tilly.localhost"))

    const logs = await runCli(["logs", "web"], { cwd: root, stateRoot })
    assert.equal(logs.exitCode, 0)
    assert.equal(logs.stdout, "hello from state\n\n")

    const stop = await runCli(["stop", "-p", "tilly", "-w", "feature-x", "web"], { cwd: root, stateRoot })
    assert.equal(stop.exitCode, 0)
    assert.ok(stop.stdout.includes("stopped feature-x/web"))
  })

  test("restart --all works outside a configured project", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const log = path.join(root, "web.log")
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`

    await writeFile(path.join(stateRoot, "projects", "tilly", "workspaces", "feature-x", "state.json"), JSON.stringify({
      project: "tilly",
      workspace: "feature-x",
      branch: null,
      root,
      commands: {
        web: {
          id: "web",
          label: "web",
          command,
          cwd: root,
          log,
          url: null,
          startedAt: new Date().toISOString(),
          runner: "process",
          pid: 99999999,
        },
      },
    }))

    const restart = await runCli(["restart", "--all"], { cwd: root, stateRoot })
    assert.equal(restart.exitCode, 0)
    assert.ok(restart.stdout.includes("restarted tilly/feature-x/web pid="))

    const state = JSON.parse(await fs.readFile(path.join(stateRoot, "projects", "tilly", "workspaces", "feature-x", "state.json"), "utf8"))
    assert.notEqual(state.commands.web.pid, 99999999)

    await runCli(["stop", "-p", "tilly", "-w", "feature-x", "web"], { cwd: root, stateRoot })
  })

  test("daemon failures include the underlying cause", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const missingCwd = path.join(root, "missing")

    await writeFile(path.join(stateRoot, "projects", "tilly", "workspaces", "feature-x", "state.json"), JSON.stringify({
      project: "tilly",
      workspace: "feature-x",
      branch: null,
      root,
      commands: {
        web: {
          id: "web",
          label: "web",
          command: "node -e 'setInterval(() => {}, 1000)'",
          cwd: missingCwd,
          log: path.join(root, "web.log"),
          url: null,
          startedAt: new Date().toISOString(),
          runner: "process",
          pid: 99999999,
        },
      },
    }))

    const restart = await runCli(["restart", "--all"], { cwd: root, stateRoot })

    assert.equal(restart.exitCode, 1)
    assert.match(restart.stderr, /failed to spawn/)
    assert.match(restart.stderr, /ENOENT/)
  })

  test("start --attach starts an ad-hoc tmux command and attaches", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const tmuxState = await tempDir("tmux-fake-")

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      commands: {},
    }`)

    const result = await runCli(["start", "--attach", "agent", "--", "sleep", "30"], {
      cwd: root,
      stateRoot,
      env: {
        WORK_TMUX_BIN: fakeTmuxBin,
        WORK_TMUX_STATE_DIR: tmuxState,
      },
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stderr, "")
    assert.ok(result.stdout.includes("started agent tmux=work-tilly-main"))

    const calls = await fs.readFile(path.join(tmuxState, "calls.log"), "utf8")
    assert.ok(calls.includes("new-session -d -s work-tilly-main"))
    assert.ok(calls.includes("select-window -t work-tilly-main:agent"))
    assert.ok(calls.includes("attach-session -t work-tilly-main"))

    await runCli(["stop", "agent"], { cwd: root, stateRoot })
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
