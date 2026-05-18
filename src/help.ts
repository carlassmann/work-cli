const sections = {
  root: `work

Worktree-aware local dev command runner.

Usage:
  work <command> [options]

Commands:
  init       Create work.config.js.
  create     Create a git worktree.
  up         Start workspace commands.
  setup      Run the workspace setup hook.
  down       Stop workspace commands.
  run        Start one configured command.
  restart    Restart commands.
  ps         List tracked commands.
  status     Alias for ps.
  logs       Print or follow command logs.
  urls       List workspace URLs.
  start      Start an ad-hoc tmux command.
  attach     Attach to an ad-hoc tmux command.
  stop       Stop one tracked command.
  doctor     Check project setup.
  prune      Remove dead process records.
  daemon     Manage workd.
  docs       Show built-in reference docs.
  completions  Print shell completion script.
  shell-init   Print shell init (completion + cd wrapper).
  cd         Print workspace root for shell cd.

The workspace is implied from the current git branch. Pass it explicitly
as a positional to up/setup/down/urls/cd, or via -w to run/restart/logs/stop/attach/start.
State-only commands also work outside a project; use -p/-w if ambiguous.

Examples:
  work init tilly
  work create feature-x
  work up feature-x
  work up feature-x --create
  work setup feature-x
  work run web
  work run -w feature-x web
  work restart web
  work restart -w feature-x --all
  work start claude -- claude
  work attach claude
  work logs -f claude
  work stop claude
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
  work create <workspace>

Arguments:
  workspace    Workspace slug.

Behavior:
  work create feature-x   Create ../<project>.worktrees/feature-x from HEAD.
  work create feature-x   Print existing path when already created.

Examples:
  work create feature-x`,

  up: `work up

Start all autoStart commands for a workspace.

Usage:
  work up [workspace] [--create|--no-create]

Arguments:
  workspace    Workspace slug. Defaults to current git branch slug.

Options:
  --create       Create a missing git worktree without asking.
  --no-create    Fail if the workspace worktree does not exist.

Behavior:
  work up                      Use current worktree.
  work up feature-x            Use ../<project>.worktrees/feature-x.
  work up feature-x            Ask before creating when missing.
  work up feature-x --create   Create without asking when missing.
  work up feature-x --create   Run worktrees.setup after create.

Examples:
  work up
  work up feature-x
  work up feature-x --create`,

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
  WORK_URLS          JSON object of routed command URLs.

Examples:
  work setup
  work setup feature-x`,

  down: `work down

Stop all tracked commands for a workspace.

Usage:
  work down [workspace]
  work down --all

Arguments:
  workspace    Workspace slug. Defaults to current git branch slug.

Options:
  -a, --all                 Stop all tracked commands outside a project.
  -p, --project <name>      Filter tracked state by project.

Examples:
  work down
  work down feature-x
  work down --all`,

  start: `work start

Start an ad-hoc command in a detached tmux session.

Usage:
  work start [-w workspace] <id> -- <command>

Arguments:
  id           DNS-safe command id.
  command      Command to run.

Options:
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.

Examples:
  work start claude -- claude
  work start claude -- claude --dangerously-skip-permissions
  work start shell -- zsh
  work start -w feature-x claude -- claude`,

  attach: `work attach

Attach to an ad-hoc tmux command.

Usage:
  work attach [-p project] [-w workspace] <id>

Options:
  -p, --project <name>      Target project when outside a project.
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.

Examples:
  work attach claude
  work attach -w feature-x claude`,

  stop: `work stop

Stop one tracked command.

Usage:
  work stop [-p project] [-w workspace] <id>

Options:
  -p, --project <name>      Target project when outside a project.
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.

Examples:
  work stop claude
  work stop -w feature-x claude`,

  restart: `work restart

Stop and start one configured or ad-hoc command, or all configured commands.

Usage:
  work restart [-p project] [-w workspace] <command>
  work restart [-p project] [-w workspace] --all

Arguments:
  command      Configured or ad-hoc command id.

Options:
  -p, --project <name>      Target project when outside a project.
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.
  -a, --all                 Restart every autoStart command, or tracked commands outside a project.

Examples:
  work restart web
  work restart claude
  work restart -w feature-x web
  work restart --all
  work restart -w feature-x --all`,

  run: `work run

Start one configured command.

Usage:
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
  work run -w feature-x web`,

  ps: `work ps

List tracked commands across all known workspaces.

Usage:
  work ps

Output:
  status    project/workspace    command    runner    handle    url

Empty state:
  no tracked commands`,

  status: `work status

List tracked commands across all known workspaces.

Usage:
  work status

Output:
  status    project/workspace    command    runner    handle    url

Empty state:
  no tracked commands`,

  logs: `work logs

Print or follow captured stdout/stderr for one command.

Usage:
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
  whether tmux is installed for ad-hoc commands
  command start mode and route mode`,

  prune: `work prune

Remove dead command records from work state.

Usage:
  work prune

Use this after crashes, manual kills, closed tmux sessions, or machine restarts.`,

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
  work completions zsh > ~/.zsh/completions/_work
  # add to ~/.zshrc:
  #   fpath=(~/.zsh/completions $fpath)
  #   autoload -U compinit && compinit

Install (bash):
  work completions bash > ~/.local/share/bash-completion/completions/work
  # or source it directly:
  #   source <(work completions bash)

Completes:
  subcommands, workspaces, configured and ad-hoc command ids,
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
  tmux

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
  if (name in sections) {
    return sections[name as HelpSection]
  }

  return sections.root
}
