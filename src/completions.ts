import fs from "node:fs/promises"
import path from "node:path"
import { loadConfig } from "./config.js"
import { gitRoot } from "./git.js"
import { errResult, ok } from "./result.js"
import { listWorkspaceStates } from "./state.js"
import type { Result } from "./result.js"

const docsTopics = ["overview", "config", "setup", "git", "daemon", "tmux", "workspaces", "urls", "portless", "commands"]
const daemonActions = ["start", "stop", "status"]
const shells = ["bash", "zsh"]

type Kind = "workspaces" | "commands" | "adhoc" | "docs-topics" | "daemon-actions" | "shells"

export async function complete(kinds: Array<string>): Promise<Array<string>> {
  const out = new Set<string>()

  for (const kind of kinds) {
    for (const item of await fetchKind(kind as Kind)) {
      out.add(item)
    }
  }

  return [...out].sort()
}

export function completionScript(shell: string): Result<string> {
  if (shell === "zsh") {
    return ok(zshScript)
  }

  if (shell === "bash") {
    return ok(bashScript)
  }

  return errResult("CLIError", `unsupported shell: ${shell}. Supported: bash, zsh.`)
}

export function shellInitScript(shell: string): Result<string> {
  const completion = completionScript(shell)

  if (!completion.ok) return completion

  const wrapper = shell === "zsh" ? zshWrapper : bashWrapper
  return ok(`${wrapper}\n${completion.value}`)
}

async function fetchKind(kind: Kind): Promise<Array<string>> {
  switch (kind) {
    case "workspaces":
      return await listWorkspaces()
    case "commands":
      return await listConfigCommands()
    case "adhoc":
      return await listAdhocCommands()
    case "docs-topics":
      return docsTopics
    case "daemon-actions":
      return daemonActions
    case "shells":
      return shells
    default:
      return []
  }
}

async function listWorkspaces(): Promise<Array<string>> {
  const out = new Set<string>()
  const config = await tryLoadConfig()

  if (config) {
    for (const name of await readWorktreeDir(config.root, config.worktreeDir)) {
      out.add(name)
    }

    for (const state of await listWorkspaceStates()) {
      if (state.project === config.project) {
        out.add(state.workspace)
      }
    }
  }

  return [...out]
}

async function listConfigCommands(): Promise<Array<string>> {
  const config = await tryLoadConfig()
  return config ? Object.keys(config.commands) : []
}

async function listAdhocCommands(): Promise<Array<string>> {
  const config = await tryLoadConfig()

  if (!config) {
    return []
  }

  const out = new Set<string>()

  for (const state of await listWorkspaceStates()) {
    if (state.project !== config.project) {
      continue
    }

    for (const command of Object.values(state.commands)) {
      if (command.runner === "tmux") {
        out.add(command.id)
      }
    }
  }

  return [...out]
}

async function tryLoadConfig() {
  const rootResult = await gitRoot(process.cwd())
  if (!rootResult.ok) return null

  const configResult = await loadConfig(rootResult.value)
  if (!configResult.ok) return null

  return {
    root: rootResult.value,
    project: configResult.value.project,
    worktreeDir: configResult.value.worktrees?.dir ?? `../${configResult.value.project}.worktrees`,
    commands: configResult.value.commands,
  }
}

async function readWorktreeDir(root: string, relative: string): Promise<Array<string>> {
  try {
    const dir = path.resolve(root, relative)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

const zshWrapper = `work() {
  if [[ "$1" == "cd" ]]; then
    shift
    local target
    target=$(command work cd "$@") || return
    builtin cd "$target"
  else
    command work "$@"
  fi
}
`

const bashWrapper = `work() {
  if [[ "$1" == "cd" ]]; then
    shift
    local target
    target=$(command work cd "$@") || return
    builtin cd "$target"
  else
    command work "$@"
  fi
}
`

const zshScript = `#compdef work

_work() {
  local -a subcommands
  subcommands=(
    'init:Create work.config.js'
    'create:Create git worktree'
    'up:Start workspace commands'
    'setup:Run workspace setup hook'
    'down:Stop workspace commands'
    'run:Start one configured command'
    'restart:Restart commands'
    'ps:List tracked commands'
    'status:Alias for ps'
    'watch:Live-refresh the ps table'
    'logs:Print or follow command logs'
    'urls:List workspace URLs'
    'start:Start an ad-hoc tmux command'
    'attach:Attach to an ad-hoc tmux command'
    'stop:Stop one tracked command'
    'doctor:Check project setup'
    'prune:Remove dead process records'
    'daemon:Manage workd'
    'docs:Show built-in reference docs'
    'completions:Print shell completion script'
    'shell-init:Print shell init script'
    'cd:Print workspace root for shell cd'
  )

  if (( CURRENT == 2 )); then
    _describe 'work command' subcommands
    return 0
  fi

  local cmd=$words[2]
  local pos=$(( CURRENT - 2 ))

  case $cmd in
    create|up|setup|down|urls|cd)
      (( pos == 1 )) && _work_emit workspaces
      ;;
    run|logs|stop|attach|restart)
      if (( pos == 1 )); then
        _work_emit workspaces commands adhoc
      else
        _work_emit commands adhoc
      fi
      ;;
    start)
      (( pos == 1 )) && _work_emit workspaces
      ;;
    docs)
      (( pos == 1 )) && _work_emit docs-topics
      ;;
    daemon)
      (( pos == 1 )) && _work_emit daemon-actions
      ;;
    completions|shell-init)
      (( pos == 1 )) && _work_emit shells
      ;;
  esac

  return 0
}

_work_emit() {
  local -a items
  items=("\${(@f)$(work _complete "$@" 2>/dev/null)}")
  _describe 'value' items
  return 0
}

if (( $+functions[compdef] )); then
  compdef _work work
fi
`

const bashScript = `_work() {
  local cur prev cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "init create up setup down run restart ps status watch logs urls start attach stop doctor prune daemon docs completions shell-init cd" -- "$cur") )
    return
  fi

  local values=""

  case "$cmd" in
    create|up|setup|down|urls|cd)
      values=$(work _complete workspaces 2>/dev/null)
      ;;
    run|logs|stop|attach|restart)
      if [[ $COMP_CWORD -eq 2 ]]; then
        values=$(work _complete workspaces commands adhoc 2>/dev/null)
      else
        values=$(work _complete commands adhoc 2>/dev/null)
      fi
      ;;
    start)
      if [[ $COMP_CWORD -eq 2 ]]; then
        values=$(work _complete workspaces 2>/dev/null)
      fi
      ;;
    docs)
      values=$(work _complete docs-topics 2>/dev/null)
      ;;
    daemon)
      values=$(work _complete daemon-actions 2>/dev/null)
      ;;
    completions|shell-init)
      values=$(work _complete shells 2>/dev/null)
      ;;
  esac

  COMPREPLY=( $(compgen -W "$values" -- "$cur") )
}

complete -F _work work
`
