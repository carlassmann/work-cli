import fs from "node:fs/promises"
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

    const result = await runCli(["up", "feature-x", "--create"], { cwd: root, stateRoot })

    assert.equal(result.stderr, "")
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes("setup feature-x"))
    assert.partialDeepStrictEqual(JSON.parse(await fs.readFile(setupFile, "utf8")), {
      project: "tilly",
      workspace: "feature-x",
      root: await fs.realpath(path.join(root, "worktrees", "feature-x")),
      web: "https://web-feature-x-tilly.localhost",
      sync: "https://sync-feature-x-tilly.localhost",
      syncWs: "wss://sync-feature-x-tilly.localhost",
    })

    const env = JSON.parse(await fs.readFile(setupFile, "utf8"))
    assert.deepEqual(JSON.parse(env.urls), {
      web: "https://web-feature-x-tilly.localhost",
      sync: "https://sync-feature-x-tilly.localhost",
    })
    assert.deepEqual(JSON.parse(env.wsUrls), {
      web: "wss://web-feature-x-tilly.localhost",
      sync: "wss://sync-feature-x-tilly.localhost",
    })
  })

  test("setup --cloudflare exports stable Cloudflare URLs", async () => {
    const root = await tempDir()
    const setupFile = path.join(root, "setup-env.json")

    await initGitRepo(root)
    await writeFile(path.join(root, "work.config.js"), `export default {
      project: "tilly",
      env: {
        WORK_CLOUDFLARE_DOMAIN: "dev.example.com",
        WORK_CLOUDFLARE_MACHINE: "cbook",
        WORK_CLOUDFLARE_TUNNEL_ID: "11111111-1111-4111-8111-111111111111",
        WORK_CLOUDFLARE_CREDENTIALS: "~/.cloudflared/test.json",
      },
      worktrees: {
        setup: ${JSON.stringify(`node -e 'require("fs").writeFileSync(${JSON.stringify(setupFile)}, JSON.stringify({ web: process.env.WORK_WEB_URL, webWs: process.env.WORK_WEB_WS_URL, urls: process.env.WORK_URLS, credentials: process.env.WORK_CLOUDFLARE_CREDENTIALS, apiToken: process.env.CLOUDFLARE_API_TOKEN }))'`)},
      },
      commands: {
        web: { run: "echo web", route: true },
      },
    }`)

    const result = await runCli(["setup", "--cloudflare"], {
      cwd: root,
      env: {
        CLOUDFLARE_API_TOKEN: "must-not-leak",
      },
    })

    assert.equal(result.stderr, "")
    assert.equal(result.exitCode, 0)
    assert.deepEqual(JSON.parse(await fs.readFile(setupFile, "utf8")), {
      web: "https://cbook-web-main-tilly.dev.example.com",
      webWs: "wss://cbook-web-main-tilly.dev.example.com",
      urls: JSON.stringify({ web: "https://cbook-web-main-tilly.dev.example.com" }),
    })
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
