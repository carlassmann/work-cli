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
as a positional to up/setup/down/urls/cd/ps/run/restart/logs/stop,
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
  work restart web api
  work restart -w feature-x --all
  work logs -f web
  work stop web
  work urls feature-x
  work doctor
  work tailscale setup
  work daemon status
  work docs portless
  work docs config

Run:
  work <command> --help
  work docs`,

  updates: `work updates

Show the cached update status for this build. Does not contact the network or start workd.

Usage:
  work updates

workd checks main in the background at startup and hourly. Start it with work daemon start.
WORK_NO_UPDATE_CHECK=1 disables background checks.
work --version shows the commit baked into the installed build.`,

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
  work up [workspace] [--create|--no-create] [--remote <name>] [--cloudflare|--tailscale]

Arguments:
  workspace    Workspace slug. Defaults to current git branch slug.

Options:
  --create           Create a missing git worktree without asking.
  --no-create        Fail if the workspace worktree does not exist.
  --remote <name>    Fetch the branch from this remote and track it when creating.
  --cloudflare       Publish routed commands through Cloudflare Tunnel.
  --tailscale        Serve routed commands to your tailnet devices (work docs tailscale).

Behavior:
  work up                      Use current worktree.
  work up feature-x            Use ../<project>.worktrees/feature-x.
  work up feature-x            Ask before creating when missing.
  work up feature-x --create   Create without asking when missing.
  work up feature-x --create   Use local branch, else track a unique remote branch, else branch from HEAD.
  work up feature-x --create   Run worktrees.setup after create.
  work up                      Start nothing routed while the portless proxy is down; print how to start it.
  work up                      Report a command that exits within 1.5s as failed, with its last log lines.

Examples:
  work up
  work up feature-x
  work up feature-x --create
  work up feature-x --create --remote origin`,

  setup: `work setup

Run worktrees.setup for a workspace.

Usage:
  work setup [workspace] [--cloudflare|--tailscale]

Arguments:
  workspace    Workspace slug. Defaults to current git branch slug.

Options:
  --cloudflare    Use stable Cloudflare URLs in setup environment.
  --tailscale     Use stable tailnet URLs in setup environment.

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

Stop one or more tracked commands.

Usage:
  work stop [-p project] [-w workspace] <id>...
  work stop [workspace] <id>...

Options:
  -p, --project <name>      Target project when outside a project.
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.

Workspace or id:
  With two or more arguments and no -w, the first is an id when it names a
  command but no workspace; otherwise it is the workspace. A name that is both
  is read as the workspace; pass -w to name the workspace instead.

Examples:
  work stop web
  work stop web api
  work stop feature-x web
  work stop -w feature-x web api`,

  wait: `work wait

Wait until a tracked command is ready, for up to 60 seconds unless --timeout
says otherwise. Routed commands are ready when their URL answers with HTTP 2xx or 3xx.
Redirects are not followed. Prints the URL once it answers. With --tailscale it
checks the local URL, since this machine cannot reach its own tailnet URL.
Commands with ready: { log: "<regex>" } in work.config.js, or --log, are ready
once a line of the current run's log matches; without a URL this prints that line.

Usage:
  work wait [-p project] [-w workspace] <id> [--timeout seconds] [--log regex]
  work wait [workspace] <id> [--timeout seconds] [--log regex]

Options:
  -p, --project <name>      Target project when outside a project.
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.
  --timeout <seconds>       Give up after this many seconds. Defaults to 60.
  --log <regex>             Wait for a log line matching regex instead of ready.log.

Exit:
  1 on timeout or when the command stops before it is ready.

Examples:
  work wait web
  work wait feature-x web --timeout 120
  work wait convex --log "functions ready"`,

  restart: `work restart

Stop and start configured commands, or autoStart commands with --all.

Usage:
  work restart [workspace] <command>... [--cloudflare|--tailscale]
  work restart [-p project] [-w workspace] <command>... [--cloudflare|--tailscale]
  work restart [-p project] [-w workspace] --all [--cloudflare|--tailscale]

Arguments:
  command      Configured command id. Pass several to restart them in order.

Options:
  -p, --project <name>      Target project when outside a project.
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.
  -a, --all                 Inside a project: restart autoStart commands for the workspace.
                            Outside a project: restart matching tracked commands.
  --cloudflare              Publish routed commands through Cloudflare Tunnel.
  --tailscale               Serve routed commands to your tailnet devices.

Workspace or command:
  With two or more arguments and no -w, the first is a command when it names a
  configured command but no workspace; otherwise it is the workspace. A name
  that is both is read as the workspace; pass -w to name the workspace instead.
  Outside a project the same rule uses tracked state.

Behavior:
  If a routed command needs the portless proxy and it is down, work prints how to start it and restarts nothing.
  Several commands restart as one batch; work then watches them together for 1.5s
  and reports any that exit as failed with their last log lines.

Examples:
  work restart web
  work restart web api
  work restart feature-x web
  work restart -w feature-x web api
  work restart --all
  work restart -w feature-x --all`,

  run: `work run

Start one configured command.

Usage:
  work run [workspace] <command> [--cloudflare|--tailscale]
  work run [-w workspace] <command> [--cloudflare|--tailscale]

Arguments:
  command      Configured command id.

Options:
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.
  --cloudflare              Publish the routed command through Cloudflare Tunnel.
  --tailscale               Serve the routed command to your tailnet devices.

Behavior:
  If the command is already alive, work prints "already up".
  If route is enabled, work starts it through portless.
  If route is enabled and the portless proxy is down, work prints how to start it and starts nothing.
  If the command exits within 1.5s, work reports it as failed with its last log lines.
  An exit with code 0 in that time prints "exited" and is not a failure.

Examples:
  work run web
  work run feature-x web
  work run -w feature-x web`,

  ps: `work ps [workspace] [-w workspace] [-a|--all] [--json]

List tracked commands for the current workspace, or all tracked state outside a project.

Usage:
  work ps
  work ps feature-x
  work ps -a

Arguments:
  workspace    Workspace slug. Defaults to current git branch slug.

Options:
  -w, --workspace <name>    Same as the workspace argument.
  -a, --all                 Show tracked commands across all workspaces.
  --json                    Print an array of command objects.

Output:
  status    project/workspace    command    pid    url

Status:
  up
  dead (exit 1, 12:04:31)   exit code or signal and time, once workd notices
  stopped (idle 2h, 14:03:00)   workspace stopped after routed servers were idle

Dead commands stay listed until they start again, work down, work stop, or work prune.

Empty state:
  no tracked commands for <project>/<workspace> (work up starts them; work ps -a lists every workspace)`,

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

  status: `work status [workspace] [-w workspace] [-a|--all] [--json]

Alias for work ps. Lists tracked commands for the current workspace, or all
tracked state outside a project.

Usage:
  work status
  work status feature-x
  work status -a

Output:
  status    project/workspace    command    pid    url

Empty state:
  no tracked commands for <project>/<workspace> (work up starts them; work ps -a lists every workspace)`,

  logs: `work logs

Print or follow captured stdout/stderr for one command.
Shows the current run: output since the command last started. Each start writes
a "── work: start <command> <time>" line, and each exit under workd a
"── work: exit <command> pid=<pid> code=<n>|signal=<name> <time>" line.
Logs stay readable after the command dies or its record is pruned.

Usage:
  work logs [-f] [-n lines] [-a] [workspace] <command>
  work logs [-f] [-n lines] [-a] [-p project] [-w workspace] <command>

Arguments:
  command      Configured or ad-hoc command id.

Options:
  -f, --follow              Stream logs until interrupted.
  -n, --tail <lines>        Print only the last lines. --lines is an alias.
  -a, --all                 Include earlier runs. A log above 10 MB moves to
                            <log>.1 when the command next starts.
  -p, --project <name>      Target project when outside a project.
  -w, --workspace <name>    Target workspace. Defaults to current git branch slug.

Examples:
  work logs web
  work logs -n 50 web
  work logs --all web
  work logs claude
  work logs feature-x web
  work logs -w feature-x web
  work logs -f -n 20 -w feature-x web`,

  urls: `work urls

List known URLs for routed commands in a workspace.

Usage:
  work urls [-p project] [workspace] [--json]

Arguments:
  workspace    Workspace slug. Defaults to current git branch slug.

Options:
  -p, --project <name>      Filter tracked state by project.

URL shape:
  https://{command}-{workspace}-{project}.localhost[:port]
  The port is the Portless proxy port, left out when it is 443. A name over
  63 characters is shortened like Portless does: its first 56 characters
  and a 6-character hash.

Empty state:
  no routed commands for <project>/<workspace>

Examples:
  work urls
  work urls feature-x`,

  tailscale: `work tailscale setup

Set up private HTTPS previews for your other tailnet devices, once per machine.

Usage:
  work tailscale setup [--domain <domain>] [--serve-port <port>] [--default | --no-default] [--yes]

Steps (each is skipped when already done):
  1. Reads this machine's Tailscale IPv4 address.
  2. Points *.<domain> at it. On Cloudflare DNS work creates the record with an
     API token (CLOUDFLARE_API_TOKEN, or asked for); elsewhere it prints the record.
  3. Gets a Let's Encrypt certificate for *.<domain> with acme.sh (DNS challenge)
     and installs it under ~/.config/work/tailscale. acme.sh renews it.
  4. Offers to let Portless serve the domain on this machine too, so the URLs
     also open here (portless service install --tld localhost --tld <domain>,
     Portless 0.15.1 or newer on port 443). If the Portless service has other
     custom settings, it prints the command instead of running it.
  5. Saves the domain in ~/.config/work/config.json.

Options:
  --domain <domain>     For example dev.example.com. Defaults to the saved domain.
  --serve-port <port>   Tailnet port for previews (default 443). Use another one
                        when tailscale serve already uses 443 on this machine;
                        the URLs then carry it, as in https://web-….dev.example.com:9443.
  --default             Make plain work up use tailnet URLs on this machine.
  --no-default          Go back to needing --tailscale.
  -y, --yes             Answer yes to every question (for scripts).

Afterwards:
  work up --tailscale  (or plain work up after --default)
  work doctor          checks the certificate, the DNS record, and whether
                       Portless serves the domain on this machine`,

  doctor: `work doctor

Check whether the current project is ready for work.

Usage:
  work doctor

Checks:
  git root
  work.config.js
  worktrees.setup
  whether portless is installed and its proxy answers when routed commands need it
  Cloudflare Tunnel configuration when environment variables are set
  whether workd runs, and on Linux the systemd unit it runs in
  command start mode and route mode`,

  prune: `work prune

Remove dead command records from work state.

Usage:
  work prune

workd keeps dead records with their exit status so work ps and work logs can
explain a crash; it drops them on its own only when their worktree is gone.
Use this to clear them after crashes, manual kills, or machine restarts.`,

  daemon: `work daemon

Manage the background supervisor, workd.

Usage:
  work daemon start
  work daemon stop
  work daemon status

Behavior:
  work up/run/stop/restart/prune auto-start workd when needed.
  workd owns configured command start/stop/restart.
  Commands with restart: "on-exit" are restarted when they die while workd runs.
  idleTimeoutSeconds or WORK_IDLE_TIMEOUT_SECONDS stops idle workspaces on Linux.
  Set 7200 for two hours. Requires ss; see work docs config.
  Idle stops suppress on-exit restarts. work up brings commands back.
  Stopping workd leaves tracked commands running; use work stop or work down to stop them.
  On Linux with a systemd user session, workd starts in its own scope
  (work-workd-*.scope), so it and its commands outlive the terminal or agent
  session that started it. WORK_DAEMON_SYSTEMD=0 starts it as a plain child instead.
  work daemon status warns when workd runs inside another session's scope.

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
