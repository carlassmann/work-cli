import { commandSpecs } from "./commands.js"

const commandList = commandSpecs
  .map((spec) => `  ${spec.name.padEnd(11)}  ${spec.summary}`)
  .join("\n")

const sections = {
  root: `work

Worktree-aware local dev command runner.

Usage:
  work <command> [options]

Commands:
${commandList}

The workspace is implied from the current git branch. Pass it explicitly
as a positional to up/setup/down/urls/cd/run/restart/logs/stop,
or via -w where supported.
State-only commands also work outside a project; ps/status/watch show all tracked state there.

Examples:
  work init tilly
  work create feature-x
  work up feature-x
  work up feature-x --create
  work setup feature-x
  work run web
  work run feature-x web
  work restart web
  work restart -w feature-x --all
  work logs -f web
  work stop web
  work urls feature-x
  work doctor
  work daemon status
  work docs portless
  work docs config

Run:
  work <command> --help
  work docs`,

  init: `work init

Create work.config.js in the current git root or current directory.

Usage:
  work init [project]

Arguments:
  project    DNS-safe project slug. Defaults to current folder name.

Examples:
  work init
  work init tilly`,

  create: `work create

Create a git worktree without running setup or starting commands.

Usage:
  work create <workspace> [--remote <name>]

Arguments:
  workspace    Branch name. The workspace slug is derived from it.

Options:
  --remote <name>    Fetch the branch from this remote and track it.

Behavior:
  work create feature-x   Use the local branch when it exists.
  work create feature-x   Track the remote branch when exactly one remote has it.
  work create feature-x   Otherwise create a new branch from HEAD.
  work create feature-x --remote origin   Fetch origin/feature-x, then track it.

Examples:
  work create feature-x
  work create feature-x --remote origin`,

  up: `work up

Start all autoStart commands for a workspace.

Usage:
  work up [workspace] [--create|--no-create] [--remote <name>]

Arguments:
  workspace    Workspace slug. Defaults to current git branch slug.

Options:
  --create           Create a missing git worktree without asking.
  --no-create        Fail if the workspace worktree does not exist.
  --remote <name>    Fetch the branch from this remote and track it when creating.

Behavior:
  work up                      Use current worktree.
  work up feature-x            Use ../<project>.worktrees/feature-x.
  work up feature-x            Ask before creating when missing.
  work up feature-x --create   Create without asking when missing.
  work up feature-x --create   Use local branch, else track a unique remote branch, else branch from HEAD.
  work up feature-x --create   Run worktrees.setup after create.

Examples:
  work up
  work up feature-x
  work up feature-x --create
  work up feature-x --create --remote origin`,

  setup: `work setup

Run worktrees.setup for a workspace.

Usage:
  work setup [workspace]

Arguments:
  workspace    Workspace slug. Defaults to current git branch slug.

Environment:
  WORK_PROJECT       Project slug.
  WORK_WORKSPACE     Workspace slug.
  WORK_ROOT          Workspace root.
  WORK_SOURCE_ROOT   Root where work.config.js was read.
  WORK_BRANCH        Workspace branch, if known.
  WORK_URL           Web URL when a web route exists.
  WORK_WEB_URL       Same as WORK_URL.
  WORK_<ID>_URL      Full URL for each routed command id.
  WORK_<ID>_WS_URL   WebSocket URL for each routed command id.
  WORK_URLS          JSON object of routed command URLs.
  WORK_WS_URLS       JSON object of routed command WebSocket URLs.

Examples:
  work setup
  work setup feature-x`,

  down: `work down

Stop tracked commands for one workspace, or a broader scope with --all.

Usage:
  work down [workspace]
  work down --all

Arguments:
  workspace    Workspace slug. Defaults to current git branch slug.

Options:
  -a, --all                 Inside a project: stop tracked commands for this project.
                            Outside a project: stop all tracked commands.
  -p, --project <name>      Filter tracked state by project.

Examples:
  work down
  work down feature-x
  work down --all`,

  stop: `work stop

Stop a tracked command.

Usage:
  work stop [-p project] [-w workspace] <id>
  work stop [workspace] <id>

Options:
  -p, --project <name>      Target project when outside a project.
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.

Examples:
  work stop web
  work stop feature-x web
  work stop -w feature-x web`,

  restart: `work restart

Stop and start one configured command, or autoStart commands with --all.

Usage:
  work restart [workspace] <command>
  work restart [-p project] [-w workspace] <command>
  work restart [-p project] [-w workspace] --all

Arguments:
  command      Configured command id.

Options:
  -p, --project <name>      Target project when outside a project.
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.
  -a, --all                 Inside a project: restart autoStart commands for the workspace.
                            Outside a project: restart matching tracked commands.

Examples:
  work restart web
  work restart feature-x web
  work restart -w feature-x web
  work restart --all
  work restart -w feature-x --all`,

  run: `work run

Start one configured command.

Usage:
  work run [workspace] <command>
  work run [-w workspace] <command>

Arguments:
  command      Configured command id.

Options:
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.

Behavior:
  If the command is already alive, work prints "already up".
  If route is enabled, work starts it through portless.

Examples:
  work run web
  work run feature-x web
  work run -w feature-x web`,

  ps: `work ps [-a|--all]

List tracked commands for the current workspace, or all tracked state outside a project.

Usage:
  work ps
  work ps -a

Output:
  status    project/workspace    command    pid    url

Status:
  commands show up/dead

Empty state:
  no tracked commands`,

  watch: `work watch [-a|--all] [-n seconds]

Live-refresh the work ps table until interrupted.

Usage:
  work watch
  work watch -a
  work watch -n 5

Options:
  -a, --all                 Show tracked commands across all workspaces.
  -n, --interval <seconds>  Refresh interval. Defaults to 2.

Exit:
  ctrl-c`,

  status: `work status [-a|--all]

List tracked commands for the current workspace, or all tracked state outside a project.

Usage:
  work status
  work status -a

Output:
  status    project/workspace    command    pid    url

Empty state:
  no tracked commands`,

  logs: `work logs

Print or follow captured stdout/stderr for one command.

Usage:
  work logs [-f] [workspace] <command>
  work logs [-f] [-p project] [-w workspace] <command>

Arguments:
  command      Configured or ad-hoc command id.

Options:
  -f, --follow              Stream logs until interrupted.
  -p, --project <name>      Target project when outside a project.
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.

Examples:
  work logs web
  work logs claude
  work logs feature-x web
  work logs -w feature-x web
  work logs -f -w feature-x web`,

  urls: `work urls

List known URLs for routed commands in a workspace.

Usage:
  work urls [-p project] [workspace]

Arguments:
  workspace    Workspace slug. Defaults to current git branch slug.

Options:
  -p, --project <name>      Filter tracked state by project.

URL shape:
  {command}-{workspace}-{project}.localhost

Empty state:
  no routed commands for <workspace>

Examples:
  work urls
  work urls feature-x`,

  doctor: `work doctor

Check whether the current project is ready for work.

Usage:
  work doctor

Checks:
  git root
  work.config.js
  worktrees.setup
  whether portless is installed when routed commands need it
  command start mode and route mode`,

  prune: `work prune

Remove dead command records from work state.

Usage:
  work prune

Use this after crashes, manual kills, or machine restarts.`,

  daemon: `work daemon

Manage the background supervisor, workd.

Usage:
  work daemon start
  work daemon stop
  work daemon status

Behavior:
  work up/run/stop/restart/prune auto-start workd when needed.
  workd owns configured command start/stop/restart.
  Commands with restart: "on-exit" are restarted when they die.

Examples:
  work daemon status
  work daemon start
  work daemon stop`,

  completions: `work completions

Print a shell completion script.

Usage:
  work completions <shell>

Arguments:
  shell    bash or zsh.

Install (zsh):
  mkdir -p ~/.zsh/completions
  work completions zsh > ~/.zsh/completions/_work
  # add to ~/.zshrc:
  #   fpath=(~/.zsh/completions $fpath)
  #   autoload -U compinit && compinit

Install (bash):
  mkdir -p ~/.local/share/bash-completion/completions
  work completions bash > ~/.local/share/bash-completion/completions/work
  # or source it directly:
  #   source <(work completions bash)

Completes:
  subcommands, workspaces, configured command ids,
  docs topics, daemon actions.

Prefer work shell-init for completion plus the cd wrapper.`,

  "shell-init": `work shell-init

Print a shell init script: completion + a work() function that
makes 'work cd <workspace>' change the shell's directory.

Usage:
  work shell-init <shell>

Arguments:
  shell    bash or zsh.

Install:
  # add to ~/.zshrc or ~/.bashrc:
  eval "$(work shell-init zsh)"
  eval "$(work shell-init bash)"

After install:
  work cd                  cd to current workspace root
  work cd feature-x        cd to feature-x worktree root
  work <Tab>               complete subcommands, workspaces, commands`,

  cd: `work cd

Print the absolute path of a workspace root. Intended to be
invoked from a shell function that runs 'cd' on the result.

Usage:
  work cd [workspace]

Arguments:
  workspace    Workspace slug. Defaults to current git branch slug.

Install the shell wrapper:
  eval "$(work shell-init zsh)"     # zsh
  eval "$(work shell-init bash)"    # bash

Standalone use without the wrapper:
  cd "$(work cd feature-x)"

Examples:
  work cd
  work cd feature-x`,

  help: `work help

Show command help or built-in topic help.

Usage:
  work help [command|topic]

Examples:
  work help
  work help run
  work help config`,

  docs: `work docs

Show built-in reference docs.

Usage:
  work docs [topic]

Topics:
  overview
  config
  setup
  git
  workspaces
  urls
  portless
  commands
  daemon

Examples:
  work docs
  work docs config
  work docs portless
  work docs urls`,
}

type HelpSection = keyof typeof sections

export function rootHelp() {
  return sections.root
}

export function commandHelp(name: string) {
  const section = helpSection(name)

  if (section) {
    return sections[section]
  }

  return sections.root
}

export function helpSection(name: string): HelpSection | null {
  if (name in sections) return name as HelpSection
  return null
}
