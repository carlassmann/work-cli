import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { git, initGitRepo, runCli, tempDir, writeFile } from "./test-helpers.js"

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

  test("help forwards unknown command names to docs topics", async () => {
    const root = await tempDir()
    const result = await runCli(["help", "config"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("work.config.js"))
  })

  test("help has its own help page", async () => {
    const root = await tempDir()
    const result = await runCli(["help", "help"], { cwd: root })
    const flag = await runCli(["help", "--help"], { cwd: root })

    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("work help [command|topic]"))
    assert.equal(flag.exitCode, 0)
    assert.ok(flag.stdout.includes("work help [command|topic]"))
  })

  test("help rejects unknown topics", async () => {
    const root = await tempDir()
    const result = await runCli(["help", "wat"], { cwd: root })

    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes("unknown help topic: wat"))
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

  test("init rejects extra args", async () => {
    const root = await tempDir()
    const result = await runCli(["init", "one", "two"], { cwd: root })

    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes("unexpected argument: two"))
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

  test("up rejects conflicting create flags", async () => {
    const root = await tempDir()
    const result = await runCli(["up", "--create", "--no-create"], { cwd: root })

    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes("only one of --create or --no-create"))
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

  test("create checks out an already-fetched remote branch with tracking", async () => {
    const { root } = await cloneWithRemoteBranch("feature-y")

    const result = await runCli(["create", "feature-y"], { cwd: root })

    assert.equal(result.stderr, "")
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("created feature-y from origin/feature-y"))

    const worktree = path.join(root, "worktrees", "feature-y")
    assert.ok(await fs.stat(path.join(worktree, "marker.txt")))
    assert.equal((await git(["branch", "--show-current"], worktree)).stdout.trim(), "feature-y")
    assert.equal(
      (await git(["rev-parse", "--abbrev-ref", "feature-y@{upstream}"], worktree)).stdout.trim(),
      "origin/feature-y",
    )
  })

  test("create --remote fetches a branch unknown locally", async () => {
    const { origin, root } = await cloneWithRemoteBranch("feature-y")
    await addRemoteBranch(origin, "feature-z")

    const result = await runCli(["create", "feature-z", "--remote", "origin"], { cwd: root })

    assert.equal(result.stderr, "")
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("created feature-z from origin/feature-z"))

    const worktree = path.join(root, "worktrees", "feature-z")
    assert.ok(await fs.stat(path.join(worktree, "marker.txt")))
    assert.equal(
      (await git(["rev-parse", "--abbrev-ref", "feature-z@{upstream}"], worktree)).stdout.trim(),
      "origin/feature-z",
    )
  })

  test("create --remote fails cleanly when the branch is missing on the remote", async () => {
    const { root } = await cloneWithRemoteBranch("feature-y")

    const result = await runCli(["create", "nope", "--remote", "origin"], { cwd: root })

    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes("failed to fetch nope from origin"))
  })

  test("create keeps the real branch name for remote slash branches", async () => {
    const { root } = await cloneWithRemoteBranch("feat/foo")

    const result = await runCli(["create", "feat/foo"], { cwd: root })

    assert.equal(result.stderr, "")
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("created feat-foo from origin/feat/foo"))

    const worktree = path.join(root, "worktrees", "feat-foo")
    assert.equal((await git(["branch", "--show-current"], worktree)).stdout.trim(), "feat/foo")
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
          run: "sync",
          route: null,
          cwd: root,
          log: path.join(root, "sync.log"),
          url: "https://sync-feat-i18n-alkalye.localhost",
          startedAt: new Date().toISOString(),
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
          run: "livekit",
          route: null,
          cwd: root,
          log: path.join(root, "livekit.log"),
          url: null,
          startedAt: new Date().toISOString(),
          pid,
        },
      },
    }))

    const result = await runCli(["ps", "-a"], { cwd: root, stateRoot })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stderr, "")
    assert.ok(!result.stdout.includes("\t"))

    const lines = result.stdout.trimEnd().split("\n")
    assert.equal(lines.length, 3)
    assert.ok(lines[0].includes("status"))
    assert.equal(lines[1].indexOf("sync"), lines[2].indexOf("livekit"))
    assert.equal(lines[1].indexOf(String(pid)), lines[2].indexOf(String(pid)))
  })

  test("unknown commands and flags suggest close matches", async () => {
    const root = await tempDir()

    const command = await runCli(["statsu"], { cwd: root })
    assert.equal(command.exitCode, 1)
    assert.ok(command.stderr.includes("Did you mean status?"))

    const flag = await runCli(["ps", "--al"], { cwd: root })
    assert.equal(flag.exitCode, 1)
    assert.ok(flag.stderr.includes("Did you mean --all?"))

    const unknownHelp = await runCli(["statsu", "--help"], { cwd: root })
    assert.equal(unknownHelp.exitCode, 1)
    assert.ok(unknownHelp.stderr.includes("Did you mean status?"))
    assert.ok(!unknownHelp.stderr.includes("?."))
  })

  test("stop missing command prints stop usage", async () => {
    const root = await tempDir()
    const result = await runCli(["stop"], { cwd: root })

    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes("Usage: work stop"))
  })

  test("restart typo suggests configured commands", async () => {
    const root = await tempDir()

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      commands: {
        web: { run: "echo web" },
      },
    }`)

    const result = await runCli(["restart", "weeb"], { cwd: root })

    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes("Did you mean web?"))
  })

  test("value flags accept --flag=value", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")

    await writeFile(path.join(stateRoot, "projects", "tilly", "workspaces", "feature-x", "state.json"), JSON.stringify({
      project: "tilly",
      workspace: "feature-x",
      branch: null,
      root,
      commands: {},
    }))

    const result = await runCli(["down", "--project=tilly", "feature-x"], { cwd: root, stateRoot })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stderr, "")
  })

  test("workspace command forms reject extra args", async () => {
    const root = await tempDir()

    const positional = await runCli(["logs", "feature-x", "web", "extra"], { cwd: root })
    assert.equal(positional.exitCode, 1)
    assert.ok(positional.stderr.includes("unexpected argument: extra"))

    const withFlag = await runCli(["logs", "-w", "feature-x", "web", "extra"], { cwd: root })
    assert.equal(withFlag.exitCode, 1)
    assert.ok(withFlag.stderr.includes("unexpected argument: extra"))
  })

  test("single-workspace commands reject extra args", async () => {
    const root = await tempDir()

    for (const args of [["create", "one", "two"], ["up", "one", "two"], ["urls", "one", "two"], ["cd", "one", "two"]]) {
      const result = await runCli(args, { cwd: root })
      assert.equal(result.exitCode, 1)
      assert.ok(result.stderr.includes("unexpected argument: two"))
    }
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
          run: "web",
          route: null,
          cwd: root,
          log: path.join(root, "web.log"),
          url: null,
          startedAt: new Date().toISOString(),
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
          run: "api",
          route: null,
          cwd: root,
          log: path.join(root, "api.log"),
          url: null,
          startedAt: new Date().toISOString(),
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

  test("ps and urls --json print public command fields only", async (t) => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    // A fresh process, so its start time matches startedAt however long the suite has run.
    const sleeper = spawn("sleep", ["60"], { stdio: "ignore" })
    t.after(() => sleeper.kill())
    const pid = sleeper.pid!
    const startedAt = new Date().toISOString()

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      commands: {},
    }`)
    const statePath = path.join(stateRoot, "projects", "tilly", "workspaces", "main", "state.json")
    await writeFile(statePath, JSON.stringify({
      project: "tilly",
      workspace: "main",
      branch: "main",
      root,
      commands: {
        web: {
          id: "web", label: "web", command: "web", run: "web", route: "web-main-tilly", cwd: root,
          log: path.join(root, "web.log"), url: "https://web-main-tilly.localhost", startedAt, pid,
          env: { API_TOKEN: "secret" },
        },
        worker: {
          id: "worker", label: "worker", command: "worker", run: "worker", route: null, cwd: root,
          log: path.join(root, "worker.log"), startedAt, pid,
        },
      },
    }))

    const ps = await runCli(["status", "--json"], { cwd: root, stateRoot })
    assert.equal(ps.exitCode, 0)
    assert.equal(ps.stderr, "")
    assert.deepEqual(JSON.parse(ps.stdout), [
      { project: "tilly", workspace: "main", command: "web", status: "up", pid, url: "https://web-main-tilly.localhost" },
      { project: "tilly", workspace: "main", command: "worker", status: "up", pid, url: null },
    ])

    const urls = await runCli(["urls", "--json"], { cwd: root, stateRoot })
    assert.equal(urls.exitCode, 0)
    assert.deepEqual(JSON.parse(urls.stdout), [
      { project: "tilly", workspace: "main", command: "web", url: "https://web-main-tilly.localhost" },
    ])

    const empty = await runCli(["urls", "other", "--json"], { cwd: root, stateRoot })
    assert.equal(empty.stdout, "[]\n")
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
          run: "bun run dev",
          route: null,
          cwd: root,
          log,
          url: "https://web-feature-x-tilly.localhost",
          startedAt: new Date().toISOString(),
          pid: 99999999,
        },
      },
    }))

    const urls = await runCli(["urls"], { cwd: root, stateRoot })
    assert.equal(urls.exitCode, 0)
    assert.ok(urls.stdout.includes("tilly/feature-x"))
    assert.ok(urls.stdout.includes("https://web-feature-x-tilly.localhost"))

    const json = await runCli(["urls", "-p", "tilly", "feature-x", "--json"], { cwd: root, stateRoot })
    assert.equal(json.exitCode, 0)
    assert.equal(json.stderr, "")
    assert.deepEqual(JSON.parse(json.stdout), [{ project: "tilly", workspace: "feature-x", command: "web", url: "https://web-feature-x-tilly.localhost" }])

    const ps = await runCli(["ps"], { cwd: root, stateRoot })
    assert.equal(ps.exitCode, 0)
    assert.ok(ps.stdout.includes("tilly/feature-x"))
    assert.ok(ps.stdout.includes("web"))

    const logs = await runCli(["logs", "web"], { cwd: root, stateRoot })
    assert.equal(logs.exitCode, 0)
    assert.equal(logs.stdout, "hello from state\n")

    const typoLogs = await runCli(["logs", "weeb"], { cwd: root, stateRoot })
    assert.equal(typoLogs.exitCode, 1)
    assert.ok(typoLogs.stderr.includes("Did you mean web?"))

    const positionalLogs = await runCli(["logs", "feature-x", "web"], { cwd: root, stateRoot })
    assert.equal(positionalLogs.exitCode, 0)
    assert.equal(positionalLogs.stdout, "hello from state\n")

    await writeFile(path.join(stateRoot, "projects", "tilly", "workspaces", "feature-slash", "state.json"), JSON.stringify({
      project: "tilly",
      workspace: "feature-slash",
      branch: null,
      root,
      commands: {
        api: {
          id: "api",
          label: "api",
          command: "bun run api",
          run: "bun run api",
          route: null,
          cwd: root,
          log,
          url: null,
          startedAt: new Date().toISOString(),
          pid: 99999999,
        },
      },
    }))

    const sluggedLogs = await runCli(["logs", "feature/slash", "api"], { cwd: root, stateRoot })
    assert.equal(sluggedLogs.exitCode, 0)
    assert.equal(sluggedLogs.stdout, "hello from state\n")

    const stop = await runCli(["stop", "feature-x", "web"], { cwd: root, stateRoot })
    assert.equal(stop.exitCode, 0)
    assert.ok(stop.stdout.includes("stopped tilly/feature-x/web"))
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
          run: command,
          route: null,
          cwd: root,
          log,
          url: null,
          startedAt: new Date().toISOString(),
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

  test("down --all inside a project scopes to the current project", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      commands: {},
    }`)
    await writeFile(path.join(stateRoot, "projects", "tilly", "workspaces", "main", "state.json"), JSON.stringify({
      project: "tilly",
      workspace: "main",
      branch: null,
      root,
      commands: {},
    }))
    await writeFile(path.join(stateRoot, "projects", "other", "workspaces", "main", "state.json"), JSON.stringify({
      project: "other",
      workspace: "main",
      branch: null,
      root,
      commands: {},
    }))

    const result = await runCli(["down", "--all"], { cwd: root, stateRoot })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stderr, "")
    assert.equal(result.stdout.trim(), "no tracked commands")
  })

  test("ps accepts a workspace as argument or -w and names what it checked when empty", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      commands: {},
    }`)
    await writeTrackedState(stateRoot, root, "tilly", "other", ["api"], process.pid)

    const current = await runCli(["ps"], { cwd: root, stateRoot })
    assert.equal(current.exitCode, 0)
    assert.equal(current.stdout.trim(), "no tracked commands for tilly/main (work up starts them; work ps -a lists every workspace)")

    for (const args of [["ps", "other"], ["ps", "-w", "other"], ["status", "--workspace=other"]]) {
      const result = await runCli(args, { cwd: root, stateRoot })
      assert.equal(result.exitCode, 0)
      assert.equal(result.stderr, "")
      assert.ok(result.stdout.includes("tilly/other"))
      assert.ok(result.stdout.includes("api"))
    }

    const missing = await runCli(["ps", "feature/x"], { cwd: root, stateRoot })
    assert.equal(missing.stdout.trim(), "no tracked commands for tilly/feature-x (work up feature-x starts them; work ps -a lists every workspace)")

    const json = await runCli(["ps", "other", "--json"], { cwd: root, stateRoot })
    assert.deepEqual(JSON.parse(json.stdout).map((record: { command: string }) => record.command), ["api"])

    const withAll = await runCli(["ps", "-a", "other"], { cwd: root, stateRoot })
    assert.equal(withAll.exitCode, 1)
    assert.ok(withAll.stderr.includes("work ps --all accepts no workspace argument"))

    const extra = await runCli(["ps", "-w", "other", "more"], { cwd: root, stateRoot })
    assert.equal(extra.exitCode, 1)
    assert.ok(extra.stderr.includes("unexpected argument: more"))

    const urls = await runCli(["urls"], { cwd: root, stateRoot })
    assert.equal(urls.stdout.trim(), "no routed commands for tilly/main")
  })

  test("ps filters tracked state by workspace outside a project", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")

    await writeTrackedState(stateRoot, root, "tilly", "feature-x", ["web"], process.pid)
    await writeTrackedState(stateRoot, root, "tilly", "other", ["api"], process.pid)

    const result = await runCli(["ps", "feature-x"], { cwd: root, stateRoot })
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("tilly/feature-x"))
    assert.ok(!result.stdout.includes("tilly/other"))

    const missing = await runCli(["ps", "nope"], { cwd: root, stateRoot })
    assert.equal(missing.stdout.trim(), "no tracked commands for workspace nope (work ps -a lists every workspace)")
  })

  test("restart reads a leading command id as a command unless it names a workspace", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      worktrees: { dir: "worktrees" },
      commands: {
        web: { run: "echo web" },
        api: { run: "echo api" },
      },
    }`)

    const unknown = await runCli(["restart", "web", "nope"], { cwd: root, stateRoot })
    assert.equal(unknown.exitCode, 1)
    assert.ok(unknown.stderr.includes("unknown command: nope"))
    assert.equal(unknown.stdout, "")

    const workspace = await runCli(["restart", "nope", "web"], { cwd: root, stateRoot })
    assert.equal(workspace.exitCode, 1)
    assert.equal(workspace.stderr.trim(), "workspace nope does not exist")

    const flag = await runCli(["restart", "-w", "web", "api"], { cwd: root, stateRoot })
    assert.equal(flag.exitCode, 1)
    assert.ok(flag.stderr.includes("workspace web does not exist; web is a command id. Usage: work restart [-w workspace] <command>..."))

    const run = await runCli(["run", "web", "api"], { cwd: root, stateRoot })
    assert.equal(run.exitCode, 1)
    assert.ok(run.stderr.includes("workspace web does not exist; web is a command id. Usage: work run [-w workspace] <command>"))

    const all = await runCli(["restart", "--all", "web"], { cwd: root, stateRoot })
    assert.equal(all.exitCode, 1)
    assert.ok(all.stderr.includes("work restart --all accepts no command argument"))
  })

  test("restart and stop take several command ids", async (t) => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      worktrees: { dir: "worktrees" },
      commands: {
        web: { run: ${JSON.stringify(command)} },
        api: { run: ${JSON.stringify(command)} },
      },
    }`)
    t.after(async () => {
      await runCli(["down", "--all"], { cwd: root, stateRoot })
      await runCli(["daemon", "stop"], { cwd: root, stateRoot })
    })

    const restart = await runCli(["restart", "web", "api"], { cwd: root, stateRoot })
    assert.equal(restart.stderr, "")
    assert.equal(restart.exitCode, 0)
    assert.match(restart.stdout, /^restarted web pid=\d+\nrestarted api pid=\d+\n$/)

    const stop = await runCli(["stop", "web", "api"], { cwd: root, stateRoot })
    assert.equal(stop.exitCode, 0)
    assert.equal(stop.stdout, "stopped tilly/main/web\nstopped tilly/main/api\n")

    // A name that is both a workspace and a command keeps meaning the workspace.
    await fs.mkdir(path.join(root, "worktrees", "web"), { recursive: true })
    const both = await runCli(["restart", "web", "api"], { cwd: root, stateRoot })
    assert.equal(both.exitCode, 0)
    assert.match(both.stdout, /^restarted api pid=\d+\n$/)

    const stopBoth = await runCli(["stop", "web", "api"], { cwd: root, stateRoot })
    assert.equal(stopBoth.stdout, "stopped tilly/web/api\n")
  })

  test("stop reports every untracked id after stopping the rest", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      commands: { web: { run: "echo web" } },
    }`)
    await writeTrackedState(stateRoot, root, "tilly", "main", ["web"], 99999999)

    const result = await runCli(["stop", "web", "nope", "gone"], { cwd: root, stateRoot })
    assert.equal(result.exitCode, 1)
    assert.equal(result.stdout, "stopped tilly/main/web\n")
    assert.ok(result.stderr.includes("no tracked command: main/nope"))
    assert.ok(result.stderr.includes("no tracked command: main/gone"))
  })

  test("stop by tracked state stops what it finds and reports every missing id", async () => {
    const root = await tempDir()
    const project = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const statePath = path.join(stateRoot, "projects", "demo", "workspaces", "main", "state.json")

    await initGitRepo(project)
    await writeFile(path.join(project, "work.config.js"), `export default {
      project: "demo",
      commands: { web: { run: "echo web" } },
    }`)

    for (const [cwd, args] of [[root, ["stop", "web", "missing", "also-missing"]], [project, ["stop", "-p", "demo", "-w", "main", "web", "missing"]]] as const) {
      await writeTrackedState(stateRoot, root, "demo", "main", ["web"], 99999999)

      const result = await runCli([...args], { cwd, stateRoot })
      assert.equal(result.exitCode, 1)
      assert.equal(result.stdout, "stopped demo/main/web\n")
      for (const id of args.slice(args.indexOf("web") + 1)) {
        assert.ok(result.stderr.includes(`no tracked command: ${id}`), result.stderr)
      }
      assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")).commands, {})
    }
  })

  test("stop and restart take several ids outside a project", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")

    await writeTrackedState(stateRoot, root, "tilly", "feature-x", ["web"], 99999999)
    await writeTrackedState(stateRoot, root, "tilly", "other", ["api"], 99999999)

    const stop = await runCli(["stop", "web", "api"], { cwd: root, stateRoot })
    assert.equal(stop.exitCode, 0)
    assert.equal(stop.stdout, "stopped tilly/feature-x/web\nstopped tilly/other/api\n")

    await writeTrackedState(stateRoot, root, "tilly", "feature-x", ["web"], 99999999)
    const scoped = await runCli(["restart", "other", "web"], { cwd: root, stateRoot })
    assert.equal(scoped.exitCode, 1)
    assert.ok(scoped.stderr.includes("no tracked command: web"))
  })

  test("down --all rejects workspace argument", async () => {
    const root = await tempDir()
    const result = await runCli(["down", "--all", "feature-x"], { cwd: root })

    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes("work down --all accepts no workspace argument"))
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
          run: "node -e 'setInterval(() => {}, 1000)'",
          route: null,
          cwd: missingCwd,
          log: path.join(root, "web.log"),
          url: null,
          startedAt: new Date().toISOString(),
          pid: 99999999,
        },
      },
    }))

    const restart = await runCli(["restart", "--all"], { cwd: root, stateRoot })

    assert.equal(restart.exitCode, 1)
    assert.match(restart.stderr, /failed to spawn/)
    assert.match(restart.stderr, /ENOENT/)
  })

  test("removed tmux commands are unknown", async () => {
    const root = await tempDir()

    for (const name of ["start", "exec", "tmux", "attach"]) {
      const result = await runCli([name], { cwd: root })
      assert.equal(result.exitCode, 1)
      assert.ok(result.stderr.includes(`unknown command: ${name}`))
    }
  })

  test("metadata commands reject extra args", async () => {
    const root = await tempDir()

    for (const args of [["daemon", "status", "extra"], ["docs", "config", "extra"], ["completions", "zsh", "extra"], ["shell-init", "zsh", "extra"]]) {
      const result = await runCli(args, { cwd: root })
      assert.equal(result.exitCode, 1)
      assert.ok(result.stderr.includes("unexpected argument: extra"))
    }
  })

  test("up --create creates a worktree and runs setup with workspace env", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const setupFile = path.join(root, "setup-env.json")
    const setupCommand = `node -e 'require("fs").writeFileSync(${JSON.stringify(setupFile)}, JSON.stringify({ project: process.env.WORK_PROJECT, workspace: process.env.WORK_WORKSPACE, root: process.env.WORK_ROOT, web: process.env.WORK_WEB_URL, sync: process.env.WORK_SYNC_URL, syncWs: process.env.WORK_SYNC_WS_URL, urls: process.env.WORK_URLS, wsUrls: process.env.WORK_WS_URLS }))'`

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
        project: "tilly",
        worktrees: {
          dir: "worktrees",
          setup: ${JSON.stringify(setupCommand)},
        },
        commands: {
          web: { run: "echo web", route: true },
          sync: { run: "echo sync", route: true },
        },
      }`)

    const portlessState = await tempDir("portless-state-")
    await fs.writeFile(path.join(portlessState, "proxy.port"), "1355\n")
    const result = await runCli(["up", "feature-x", "--create"], { cwd: root, stateRoot, env: { PORTLESS_STATE_DIR: portlessState } })

    assert.equal(result.stderr, "")
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("setup feature-x"))
    assert.partialDeepStrictEqual(JSON.parse(await fs.readFile(setupFile, "utf8")), {
      project: "tilly",
      workspace: "feature-x",
      root: await fs.realpath(path.join(root, "worktrees", "feature-x")),
      web: "https://web-feature-x-tilly.localhost:1355",
      sync: "https://sync-feature-x-tilly.localhost:1355",
      syncWs: "wss://sync-feature-x-tilly.localhost:1355",
    })

    const env = JSON.parse(await fs.readFile(setupFile, "utf8"))
    assert.deepEqual(JSON.parse(env.urls), {
      web: "https://web-feature-x-tilly.localhost:1355",
      sync: "https://sync-feature-x-tilly.localhost:1355",
    })
    assert.deepEqual(JSON.parse(env.wsUrls), {
      web: "wss://web-feature-x-tilly.localhost:1355",
      sync: "wss://sync-feature-x-tilly.localhost:1355",
    })
  })

  test("up --create reloads env generated by setup before starting commands", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const output = path.join(root, "generated-env.txt")
    const setup = `node -e 'require("fs").writeFileSync(require("path").join(process.env.WORK_ROOT, ".env.local"), "GENERATED_VALUE=ready\\n")'`
    const run = `node -e 'require("fs").writeFileSync(${JSON.stringify(output)}, process.env.GENERATED_VALUE)'`

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      worktrees: { dir: "worktrees", setup: ${JSON.stringify(setup)} },
      commands: { probe: { run: ${JSON.stringify(run)}, autoStart: true } },
    }`)

    const result = await runCli(["up", "feature-x", "--create"], { cwd: root, stateRoot })

    assert.equal(result.stderr, "")
    assert.equal(result.exitCode, 0)
    assert.equal(await readFileSoon(output), "ready")
  })

  test("up refuses routed commands while the Portless proxy is stopped", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const bin = await fakePortlessBin()
    const port = await freePort()

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      commands: { web: { run: "node -e 'setTimeout(() => {}, 30000)'", route: true, autoStart: true } },
    }`)

    const result = await runCli(["up"], {
      cwd: root,
      stateRoot,
      env: { PATH: `${bin}:${process.env["PATH"]}`, PORTLESS_PORT: String(port), PORTLESS_STATE_DIR: await tempDir("portless-state-") },
    })

    assert.equal(result.exitCode, 1)
    assert.equal(result.stdout, "")
    assert.ok(result.stderr.includes(`the Portless proxy is not running on :${port}, and routed commands need it (web).`))
    assert.ok(result.stderr.includes(`  portless proxy start -p ${port} --https`))
    await assert.rejects(fs.access(path.join(stateRoot, "projects")))
  })

  test("run and tracked restart check the proxy each command's own env points at", async () => {
    const root = await tempDir()
    const elsewhere = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const bin = await fakePortlessBin()
    const portless = http.createServer((_request, response) => response.writeHead(404, { "x-portless": "1" }).end())
    await new Promise<void>((resolve) => portless.listen(0, "127.0.0.1", resolve))
    const livePort = (portless.address() as net.AddressInfo).port
    const closedPort = await freePort()
    const portlessState = await tempDir("portless-state-")

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      commands: {
        web: { run: "node -e 'setTimeout(() => {}, 30000)'", route: true, env: { PORTLESS_PORT: "${livePort}" } },
        api: { run: "node -e 'setTimeout(() => {}, 30000)'", route: true, env: { PORTLESS_PORT: "${closedPort}" } },
      },
    }`)
    const env = { PATH: `${bin}:${process.env["PATH"]}`, PORTLESS_PORT: String(closedPort), PORTLESS_STATE_DIR: portlessState }

    try {
      const run = await runCli(["run", "web"], { cwd: root, stateRoot, env })
      assert.equal(run.stderr, "")
      assert.equal(run.exitCode, 0)

      const restart = await runCli(["restart", "-p", "tilly", "web"], { cwd: elsewhere, stateRoot, env: { ...env, PORTLESS_PORT: String(await freePort()) } })
      assert.equal(restart.stderr, "")
      assert.equal(restart.exitCode, 0)

      const api = await runCli(["run", "api"], { cwd: root, stateRoot, env: { ...env, PORTLESS_PORT: String(livePort) } })
      assert.equal(api.exitCode, 1)
      assert.ok(api.stderr.includes(`the Portless proxy is not running on :${closedPort}, and routed commands need it (api).`))
    } finally {
      portless.close()
      await runCli(["down"], { cwd: root, stateRoot, env })
      await runCli(["daemon", "stop"], { cwd: root, stateRoot, env })
    }
  })

  test("restart --all checks a proxy shared by several workspaces once", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const closedPort = await freePort()
    for (const workspace of ["a", "b"]) {
      await writeFile(path.join(stateRoot, "projects", "tilly", "workspaces", workspace, "state.json"), JSON.stringify({
        project: "tilly",
        workspace,
        branch: workspace,
        root,
        commands: {
          web: {
            id: "web",
            label: "web",
            command: "web",
            run: "true",
            route: `web-${workspace}-tilly`,
            cwd: root,
            log: path.join(root, `${workspace}.log`),
            url: null,
            startedAt: new Date().toISOString(),
            pid: 999_999,
          },
        },
      }))
    }

    const result = await runCli(["restart", "--all", "-p", "tilly"], {
      cwd: root,
      stateRoot,
      env: { PATH: `${await fakePortlessBin()}:${process.env["PATH"]}`, PORTLESS_PORT: String(closedPort), PORTLESS_STATE_DIR: await tempDir("portless-state-") },
    })

    assert.equal(result.exitCode, 1)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr.split("is not running").length, 2)
    const named = new RegExp(`not running on :${closedPort}, and routed commands need it \\((.+)\\)\\.`).exec(result.stderr)?.[1]
    assert.deepEqual(named?.split(", ").sort(), ["tilly/a/web", "tilly/b/web"])
  })

  test("setup --cloudflare exports stable Cloudflare URLs", async () => {
    const root = await tempDir()
    const stateRoot = await tempDir("work-cli-state-")
    const setupFile = path.join(root, "setup-env.json")

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      worktrees: {
        setup: ${JSON.stringify(`node -e 'require("fs").writeFileSync(${JSON.stringify(setupFile)}, JSON.stringify({ web: process.env.WORK_WEB_URL, webWs: process.env.WORK_WEB_WS_URL, urls: process.env.WORK_URLS, domain: process.env.WORK_CLOUDFLARE_DOMAIN, tunnelId: process.env.WORK_CLOUDFLARE_TUNNEL_ID, machine: process.env.WORK_CLOUDFLARE_MACHINE, credentials: process.env.WORK_CLOUDFLARE_CREDENTIALS, apiToken: process.env.CLOUDFLARE_API_TOKEN }))'`)},
      },
      commands: {
        web: { run: "echo web", route: true },
      },
    }`)
    await writeFile(path.join(root, ".env.local"), `
WORK_CLOUDFLARE_DOMAIN=example.com
WORK_CLOUDFLARE_MACHINE=cbook
WORK_CLOUDFLARE_TUNNEL_ID=11111111-1111-4111-8111-111111111111
WORK_CLOUDFLARE_CREDENTIALS=~/.cloudflared/test.json
`)

    const result = await runCli(["setup", "--cloudflare"], {
      cwd: root,
      stateRoot,
      env: {
        CLOUDFLARE_API_TOKEN: "available-to-command",
      },
    })

    assert.equal(result.stderr, "")
    assert.equal(result.exitCode, 0)
    assert.deepEqual(JSON.parse(await fs.readFile(setupFile, "utf8")), {
      web: "https://cbook-web-main-tilly.example.com",
      webWs: "wss://cbook-web-main-tilly.example.com",
      urls: JSON.stringify({ web: "https://cbook-web-main-tilly.example.com" }),
      apiToken: "available-to-command",
    })

    await fs.mkdir(path.join(stateRoot, "projects", "tilly", "workspaces", "main"), { recursive: true })
    await writeFile(path.join(stateRoot, "projects", "tilly", "workspaces", "main", "state.json"), JSON.stringify({
      project: "tilly",
      workspace: "main",
      root,
      sourceRoot: root,
      commands: {},
      exposure: {
        mode: "cloudflare",
        machine: "cbook",
        domain: "example.com",
        tunnelId: "11111111-1111-4111-8111-111111111111",
        credentialsFile: "~/.cloudflared/test.json",
      },
    }))
    const inherited = await runCli(["setup"], {
      cwd: root,
      stateRoot,
      env: { CLOUDFLARE_API_TOKEN: "available-to-command" },
    })
    assert.equal(inherited.exitCode, 0)
    assert.equal(JSON.parse(await fs.readFile(setupFile, "utf8")).web, "https://cbook-web-main-tilly.example.com")
  })
})

async function cloneWithRemoteBranch(branch: string) {
  const origin = await tempDir()
  await initGitRepo(origin)
  await addRemoteBranch(origin, branch)

  const root = await tempDir()
  await git(["clone", origin, "."], root)
  await writeFile(path.join(root, "work.config.js"), `export default {
    project: "tilly",
    worktrees: { dir: "worktrees" },
    commands: {},
  }`)

  return { origin, root }
}

async function addRemoteBranch(origin: string, branch: string) {
  await git(["checkout", "-b", branch], origin)
  await writeFile(path.join(origin, "marker.txt"), branch)
  await git(["add", "marker.txt"], origin)
  await git(["commit", "-m", `add ${branch}`], origin)
  await git(["checkout", "main"], origin)
}

async function readFileSoon(file: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(file, "utf8")
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  return await fs.readFile(file, "utf8")
}

async function writeTrackedState(stateRoot: string, root: string, project: string, workspace: string, commands: Array<string>, pid: number) {
  await writeFile(path.join(stateRoot, "projects", project, "workspaces", workspace, "state.json"), JSON.stringify({
    project,
    workspace,
    branch: null,
    root,
    commands: Object.fromEntries(commands.map((id) => [id, {
      id, label: id, command: id, run: id, route: null, cwd: root,
      log: path.join(root, `${id}.log`), url: null, startedAt: new Date().toISOString(), pid,
    }])),
  }))
}

async function fakePortlessBin() {
  const bin = await tempDir("work-cli-bin-")
  await writeFile(path.join(bin, "portless"), `#!/bin/sh
[ "$1" = "service" ] && exit 0
while [ "$#" -gt 0 ] && [ "$1" != "sh" ]; do shift; done
exec "$@"
`)
  await fs.chmod(path.join(bin, "portless"), 0o755)
  return bin
}

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}
