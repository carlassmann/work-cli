const docs = {
  overview: `work is a tiny control plane for local development.

It reads work.config.js from the project root, treats git worktrees as named
workspaces, keeps command logs/state outside the terminal, and gives routed
commands stable local URLs.

work intentionally sits on top of existing tools:
  git       owns repositories, branches, and worktrees
  portless  owns HTTPS local routing and port allocation
  tmux      owns resumable interactive commands

Core workflow:
  work init my-project
  work up feature-x --create
  work run -w feature-x web
  work start -w feature-x claude -- claude
  work attach -w feature-x claude
  work status
  work urls feature-x
  work logs -f -w feature-x web
  work restart -w feature-x web
  work doctor
  work daemon status
  work prune
  work down feature-x`,

  config: `work.config.js is executable JavaScript.

Example:
  export default {
    project: "tilly",
    worktrees: {
      dir: "../tilly.worktrees",
      setup: "bun scripts/work-setup.ts",
    },
    commands: {
      web: {
        run: "bun run dev",
        autoStart: true,
        route: true,
      },
      sync: {
        run: "bun run dev:sync",
        autoStart: true,
        route: true,
      },
    },
  }

Command fields:
  run                 shell command to start
  label               optional display name
  cwd                 optional working dir relative to workspace
  env                 extra environment variables
  autoStart           included in work up
  restart             "manual" or "on-exit"
  restartWhenChanged  reserved for file-watch restarts
  route               true to publish a {command}-{workspace}-{project} URL
  routeName           override the first URL segment (default: command id)
  portless            false disables portless wrapping

Worktree fields:
  dir                 parent directory for created worktrees
  setup               shell command run after worktree creation and by work setup

Setup hook environment:
  WORK_PROJECT        project slug
  WORK_WORKSPACE      workspace slug
  WORK_ROOT           workspace root
  WORK_SOURCE_ROOT    root where work.config.js was read
  WORK_BRANCH         workspace branch, if known
  WORK_URL            web URL when a web route exists
  WORK_WEB_URL        same as WORK_URL
  WORK_URLS           JSON object of routed command URLs`,

  setup: `Setup hooks prepare a workspace before commands start.

Config:
  export default {
    worktrees: {
      setup: "bun scripts/work-setup.ts",
    },
  }

When setup runs:
  work up feature-x --create     after the worktree is created
  work setup feature-x           manually for an existing workspace
  work setup                     manually for the current workspace

Setup runs in the workspace root.

Environment:
  WORK_PROJECT        project slug
  WORK_WORKSPACE      workspace slug
  WORK_ROOT           workspace root
  WORK_SOURCE_ROOT    root where work.config.js was read
  WORK_BRANCH         workspace branch, if known
  WORK_URL            web URL when a web route exists
  WORK_WEB_URL        same as WORK_URL
  WORK_URLS           JSON object of routed command URLs

Typical setup work:
  copy or generate .env.local
  select/create per-workspace cloud services
  sync remote env variables
  install dependencies when needed
  run one-shot codegen or schema pushes`,

  git: `work assumes git because workspaces are git worktrees.

git owns:
  repository discovery
  current branch detection
  branch creation
  worktree creation
  worktree checkout state

work owns:
  project/workspace naming
  when to ask before creating a worktree
  command state and logs for each workspace
  consistent URLs for routed commands

Commands using git:
  work init                 finds the git root when possible
  work up                   derives workspace from current branch
  work up feature-x         creates ../project.worktrees/feature-x when needed
  work setup feature-x      resolves an existing worktree
  work run/restart/logs     use current branch when workspace is omitted

State-only commands:
  ps/status/prune/daemon/docs/completions/shell-init/doctor do not need config
  logs/urls/attach/stop/down/restart can use tracked state outside a project
  up/setup/run/start/cd need work.config.js

Why:
  git already knows branches and worktrees
  existing git tools keep working
  work can stay a small orchestration layer`,

  daemon: `workd is the background supervisor.

The CLI auto-starts workd for:
  work up
  work run
  work restart
  work prune

Manual lifecycle:
  work daemon start
  work daemon status
  work daemon stop

What workd owns:
  starting commands
  stopping commands
  restart command execution
  ps data when running
  pruning dead records
  restart: "on-exit"

Restart policy:
  restart: "manual"    do not restart after exit
  restart: "on-exit"   daemon restarts after process exits

The daemon communicates over a Unix socket in ~/.work-cli.
Logs and state remain file-based so they are inspectable.`,

  tmux: `Ad-hoc commands share one tmux session per workspace.
Each command becomes a named window in that session.

Session name:  work-<project>-<workspace>
Window name:   <command id>

work owns:
  command ids
  workspace association
  state records
  log paths

tmux owns:
  interactive process lifetime
  attach and detach
  switching between windows (prefix + w, prefix + n, prefix + p)

Start:
  work start claude -- claude
  work start claude -- claude --dangerously-skip-permissions
  work start shell -- zsh
  work start -w feature-x claude -- claude

Attach:
  work attach claude                 attach session, focus the claude window
  work attach -w feature-x claude    same, explicit workspace

Once attached, switch between windows for the same workspace
using the tmux prefix (prefix + w lists them).

Stop:
  work stop claude
  work stop -w feature-x claude

Stopping the last window in a session ends the session.

Logs:
  work logs claude
  work logs -f claude

State:
  ad-hoc commands live only in work state
  work.config.js is not edited
  tmux is only required for start/attach`,

  workspaces: `Workspace identity is project + workspace.

Project:
  required in work.config.js
  DNS-safe slug

Workspace:
  explicit CLI name, or current git branch slug
  DNS-safe slug

Worktree behavior:
  work up                 uses current worktree
  work up feature-x       starts ../project.worktrees/feature-x
  work up feature-x       asks before creating when missing
  work up feature-x --create     creates without asking
  work up feature-x --no-create  fails if missing

Setup behavior:
  work up feature-x --create     runs worktrees.setup after creating
  work setup feature-x           reruns worktrees.setup for an existing workspace
  work setup                     runs setup for the current workspace`,

  urls: `Canonical URL shape:
  {command}-{workspace}-{project}.localhost

Examples:
  web-feature-x-tilly.localhost
  sync-feature-x-tilly.localhost
  api-fix-auth-my-app.localhost

With route: true:
  command id becomes first URL segment.

With route: true, routeName: "app":
  app-feature-x-tilly.localhost

Routed commands are started through portless:
  portless web-feature-x-tilly sh -lc "bun run dev"`,

  portless: `work coexists with portless like it coexists with git.

portless owns:
  proxy startup
  HTTPS/TLS
  port allocation
  PORT/HOST/PORTLESS_URL injection
  route internals

work owns:
  project/workspace naming
  command orchestration
  logs/state
  consistent route names

For routed commands, work checks that portless exists, then starts:
  portless {command}-{workspace}-{project} sh -lc "{run}"

Example:
  portless web-feature-x-tilly sh -lc "bun run dev"

Install:
  install portless and make sure it is on PATH

Config:
  route: true              publish via portless under command id
  routeName: "app"         override first URL segment
  portless: false          do not wrap this command`,

  commands: `CLI commands:
  work init [project]
    create work.config.js

  work create <workspace>
    create a git worktree without setup or commands

  work up [workspace] [--create|--no-create]
    start autoStart commands for a workspace

  work setup [workspace]
    run worktrees.setup for a workspace

  work down [workspace]
  work down --all
    stop all tracked commands for a workspace

  work start [-w workspace] <id> -- <command>
    start an ad-hoc command in tmux

  work attach [-p project] [-w workspace] <id>
    attach to an ad-hoc tmux command

  work stop [-p project] [-w workspace] <id>
    stop one tracked command

  work restart [-p project] [-w workspace] <command>
    stop and start one configured or ad-hoc command

  work restart [-p project] [-w workspace] --all
    stop and start all configured commands, or tracked commands outside a project

  work run [-w workspace] <command>
    start one configured command, idempotently

  work ps
    list tracked commands across projects

  work status
    alias for work ps

  work logs [-f|--follow] [-p project] [-w workspace] <command>
    print or stream captured stdout/stderr for one command

  work urls [-p project] [workspace]
    print known URLs for routed commands

  work doctor
    check git, config, portless, tmux, and command setup

  work prune
    remove dead process records

  work daemon <start|stop|status>
    manage background supervisor

  work completions <shell>
    print bash or zsh completion script

  work shell-init <shell>
    print shell init: completion plus cd wrapper

  work cd [workspace]
    print workspace root for shell cd

  work docs [topic]
    show this reference`,
}

type DocsTopic = keyof typeof docs

const docsTopics = Object.keys(docs) as Array<DocsTopic>

import { errResult, ok } from "./result.js"
import type { Result } from "./result.js"

export function docsText(topic: string | undefined): Result<string> {
  if (!topic) {
    return ok(docs.overview + `\n\nTopics:\n  ${docsTopics.join("\n  ")}\n\nRun: work docs <topic>`)
  }

  if (topic in docs) {
    return ok(docs[topic as DocsTopic])
  }

  return errResult("CLIError", `unknown docs topic: ${topic}. Try: ${docsTopics.join(", ")}`)
}
