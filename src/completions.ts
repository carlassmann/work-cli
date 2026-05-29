import fs from "node:fs/promises"
import path from "node:path"
import { loadConfig } from "./config.js"
import { gitMainWorktree, gitRoot } from "./git.js"
import { errResult, ok } from "./result.js"
import { listWorkspaceStates } from "./state.js"
import type { Result } from "./result.js"

const commands = ["init", "create", "up", "setup", "down", "run", "restart", "ps", "status", "watch", "logs", "urls", "start", "exec", "tmux", "attach", "stop", "doctor", "prune", "daemon", "help", "docs", "completions", "shell-init", "cd"]
const docsTopics = ["overview", "config", "setup", "git", "daemon", "tmux", "workspaces", "urls", "portless", "commands"]
const daemonActions = ["start", "stop", "status"]
const shells = ["bash", "zsh"]

type Kind = "workspaces" | "configured" | "commands" | "adhoc" | "help-topics" | "docs-topics" | "daemon-actions" | "shells"

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
    case "configured":
      return await listConfiguredCommands()
    case "commands":
      return await listRunnableCommands()
    case "adhoc":
      return await listAdhocCommands()
    case "help-topics":
      return [...commands, ...docsTopics]
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
  } else {
    for (const state of await listWorkspaceStates()) {
      out.add(state.workspace)
    }
  }

  return [...out]
}

async function listConfiguredCommands(): Promise<Array<string>> {
  const config = await tryLoadConfig()
  return config ? Object.keys(config.commands) : []
}

async function listRunnableCommands(): Promise<Array<string>> {
  const config = await tryLoadConfig()
  const out = new Set(await listConfiguredCommands())

  for (const state of await listWorkspaceStates()) {
    if (!config || state.project === config.project) {
      for (const command of Object.keys(state.commands)) out.add(command)
    }
  }

  return [...out]
}

async function listAdhocCommands(): Promise<Array<string>> {
  const config = await tryLoadConfig()

  const out = new Set<string>()

  for (const state of await listWorkspaceStates()) {
    if (config && state.project !== config.project) {
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
  const cwdRoot = await gitRoot(process.cwd())
  if (!cwdRoot.ok) return null

  const rootResult = await gitMainWorktree(cwdRoot.value)
  const root = rootResult.ok ? rootResult.value : cwdRoot.value

  const configResult = await loadConfig(root)
  if (!configResult.ok) return null

  return {
    root,
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
    'exec:Alias for start'
    'tmux:Alias for start'
    'attach:Attach to an ad-hoc tmux command'
    'stop:Stop a tracked configured or ad-hoc command'
    'doctor:Check project setup'
    'prune:Remove dead process records'
    'daemon:Manage workd'
    'help:Show command help'
    'docs:Show built-in reference docs'
    'completions:Print shell completion script'
    'shell-init:Print shell init script'
    'cd:Print workspace root for shell cd'
  )

  if (( CURRENT == 2 )); then
    if [[ "$words[$CURRENT]" == -* ]]; then
      local -a root_flags
      root_flags=(-h --help -v --version)
      _describe 'option' root_flags
      return 0
    fi

    _describe 'work command' subcommands
    return 0
  fi

  local cmd=$words[2]
  local prev=$words[$(( CURRENT - 1 ))]
  local pos=$(_work_positional_index)
  local has_workspace=$(_work_has_workspace_flag)

  if [[ "$(_work_after_rest)" == "1" ]]; then
    return 0
  fi

  if [[ "$prev" == "-w" || "$prev" == "--workspace" ]]; then
    _work_emit workspaces
    return 0
  fi

  if [[ "$words[$CURRENT]" == --workspace=* ]]; then
    compset -P '--workspace='
    _work_emit workspaces
    return 0
  fi

  if [[ "$prev" == "-p" || "$prev" == "--project" ]]; then
    return 0
  fi

  if [[ "$words[$CURRENT]" == -* ]]; then
    _work_emit_flags "$cmd"
    return 0
  fi

  if [[ "$cmd" == "restart" || "$cmd" == "down" ]] && [[ "$(_work_has_all_flag)" == "1" ]]; then
    return 0
  fi

  case $cmd in
    create|up|setup|down|urls|cd)
      (( pos == 1 )) && _work_emit workspaces
      ;;
	    run)
	      if (( pos == 1 )); then
	        if [[ "$has_workspace" == "1" ]]; then
	          _work_emit configured
	        else
	          _work_emit workspaces configured
	        fi
	      elif (( pos == 2 && has_workspace == 0 )); then
	        _work_emit configured
	      fi
	      ;;
	    logs|stop|attach|restart)
	      if (( pos == 1 )); then
	        if [[ "$has_workspace" == "1" ]]; then
	          _work_emit commands adhoc
	        else
	          _work_emit workspaces commands adhoc
	        fi
	      elif (( pos == 2 && has_workspace == 0 )); then
	        _work_emit commands adhoc
	      fi
	      ;;
	    start|exec|tmux)
	      if (( pos == 1 )); then
	        if [[ "$has_workspace" == "1" ]]; then
	          _work_emit adhoc
	        else
	          _work_emit workspaces adhoc
	        fi
	      elif (( pos == 2 && has_workspace == 0 )); then
	        _work_emit adhoc
	      fi
      ;;
    help)
      (( pos == 1 )) && _work_emit help-topics
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

_work_emit_flags() {
  local -a flags
  case "$1" in
    up) flags=(--create --no-create --lan --no-tls --ip) ;;
    down) flags=(-a --all -p --project) ;;
    setup) flags=(--lan --no-tls --ip) ;;
    run) flags=(-w --workspace --lan --no-tls --ip) ;;
    restart) flags=(-a --all -p --project -w --workspace --lan --no-tls --ip) ;;
    ps|status) flags=(-a --all) ;;
    watch) flags=(-a --all -n --interval) ;;
    logs) flags=(-f --follow -p --project -w --workspace) ;;
    urls) flags=(-p --project --lan --no-tls --ip) ;;
    start|exec|tmux) flags=(-a --attach -w --workspace) ;;
    attach|stop) flags=(-p --project -w --workspace) ;;
    *) flags=() ;;
  esac
  flags+=(-h --help)

  _describe 'option' flags
}

_work_positional_index() {
  local i=3
  local count=0

  while (( i < CURRENT )); do
    case "$words[$i]" in
      --)
        break
        ;;
      -w|--workspace|-p|--project|-n|--interval|--ip)
        (( i += 2 ))
        ;;
      --workspace=*|--project=*|--interval=*|--ip=*)
        (( i++ ))
        ;;
      -*)
        (( i++ ))
        ;;
      *)
        (( count++ ))
        (( i++ ))
        ;;
    esac
  done

  echo $(( count + 1 ))
}

_work_has_workspace_flag() {
  local i=3

  while (( i < CURRENT )); do
    case "$words[$i]" in
      --)
        break
        ;;
      -w|--workspace|--workspace=*)
        echo 1
        return
        ;;
      -p|--project|-n|--interval|--ip)
        (( i += 2 ))
        ;;
      --project=*|--interval=*|--ip=*)
        (( i++ ))
        ;;
      *)
        (( i++ ))
        ;;
    esac
  done

  echo 0
}

_work_after_rest() {
  local i=3

  while (( i < CURRENT )); do
    if [[ "$words[$i]" == "--" ]]; then
      echo 1
      return
    fi
    (( i++ ))
  done

  echo 0
}

_work_has_all_flag() {
  local i=3

  while (( i < CURRENT )); do
    case "$words[$i]" in
      --)
        break
        ;;
      -a|--all)
        echo 1
        return
        ;;
    esac
    (( i++ ))
  done

  echo 0
}

if (( $+functions[compdef] )); then
  compdef _work work
fi
`

const bashScript = `_work() {
  local cur prev cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    if [[ "$cur" == -* ]]; then
      COMPREPLY=( $(compgen -W "-h --help -v --version" -- "$cur") )
    else
      COMPREPLY=( $(compgen -W "init create up setup down run restart ps status watch logs urls start exec tmux attach stop doctor prune daemon help docs completions shell-init cd" -- "$cur") )
    fi
    return
  fi

  local values=""
  local pos
  local has_workspace
  pos=$(_work_positional_index)
  has_workspace=$(_work_has_workspace_flag)

  if [[ "$(_work_after_rest)" == "1" ]]; then
    COMPREPLY=()
    return
  fi

  if [[ "$prev" == "-w" || "$prev" == "--workspace" ]]; then
    values=$(work _complete workspaces 2>/dev/null)
    COMPREPLY=( $(compgen -W "$values" -- "$cur") )
    return
  fi

  if [[ "$cur" == --workspace=* ]]; then
    values=$(work _complete workspaces 2>/dev/null)
    cur="\${cur#--workspace=}"
    COMPREPLY=( $(compgen -P "--workspace=" -W "$values" -- "$cur") )
    return
  fi

  if [[ "$prev" == "-p" || "$prev" == "--project" ]]; then
    COMPREPLY=()
    return
  fi

  if [[ "$cur" == -* ]]; then
    values=$(_work_flags "$cmd")
    COMPREPLY=( $(compgen -W "$values" -- "$cur") )
    return
  fi

  if [[ "$cmd" == "restart" || "$cmd" == "down" ]] && [[ "$(_work_has_all_flag)" == "1" ]]; then
    COMPREPLY=()
    return
  fi

  case "$cmd" in
    create|up|setup|down|urls|cd)
      if [[ $pos -eq 1 ]]; then
        values=$(work _complete workspaces 2>/dev/null)
      fi
      ;;
	    run)
	      if [[ $pos -eq 1 ]]; then
	        if [[ "$has_workspace" == "1" ]]; then
	          values=$(work _complete configured 2>/dev/null)
	        else
	          values=$(work _complete workspaces configured 2>/dev/null)
	        fi
	      elif [[ $pos -eq 2 && "$has_workspace" == "0" ]]; then
	        values=$(work _complete configured 2>/dev/null)
	      fi
	      ;;
	    logs|stop|attach|restart)
	      if [[ $pos -eq 1 ]]; then
	        if [[ "$has_workspace" == "1" ]]; then
	          values=$(work _complete commands adhoc 2>/dev/null)
	        else
	          values=$(work _complete workspaces commands adhoc 2>/dev/null)
	        fi
	      elif [[ $pos -eq 2 && "$has_workspace" == "0" ]]; then
	        values=$(work _complete commands adhoc 2>/dev/null)
	      fi
	      ;;
	    start|exec|tmux)
	      if [[ $pos -eq 1 ]]; then
	        if [[ "$has_workspace" == "1" ]]; then
	          values=$(work _complete adhoc 2>/dev/null)
	        else
	          values=$(work _complete workspaces adhoc 2>/dev/null)
	        fi
	      elif [[ $pos -eq 2 && "$has_workspace" == "0" ]]; then
	        values=$(work _complete adhoc 2>/dev/null)
	      fi
      ;;
    help)
      if [[ $pos -eq 1 ]]; then
        values=$(work _complete help-topics 2>/dev/null)
      fi
      ;;
    docs)
      if [[ $pos -eq 1 ]]; then
        values=$(work _complete docs-topics 2>/dev/null)
      fi
      ;;
    daemon)
      if [[ $pos -eq 1 ]]; then
        values=$(work _complete daemon-actions 2>/dev/null)
      fi
      ;;
    completions|shell-init)
      if [[ $pos -eq 1 ]]; then
        values=$(work _complete shells 2>/dev/null)
      fi
      ;;
  esac

  COMPREPLY=( $(compgen -W "$values" -- "$cur") )
}

complete -F _work work

_work_flags() {
  case "$1" in
    up) echo "--create --no-create --lan --no-tls --ip -h --help" ;;
    down) echo "-a --all -p --project -h --help" ;;
    setup) echo "--lan --no-tls --ip -h --help" ;;
    run) echo "-w --workspace --lan --no-tls --ip -h --help" ;;
    restart) echo "-a --all -p --project -w --workspace --lan --no-tls --ip -h --help" ;;
    ps|status) echo "-a --all -h --help" ;;
    watch) echo "-a --all -n --interval -h --help" ;;
    logs) echo "-f --follow -p --project -w --workspace -h --help" ;;
    urls) echo "-p --project --lan --no-tls --ip -h --help" ;;
    start|exec|tmux) echo "-a --attach -w --workspace -h --help" ;;
    attach|stop) echo "-p --project -w --workspace -h --help" ;;
    *) echo "-h --help" ;;
  esac
}

_work_positional_index() {
  local i=2
  local count=0

  while [[ $i -lt $COMP_CWORD ]]; do
    case "\${COMP_WORDS[$i]}" in
      --)
        break
        ;;
      -w|--workspace|-p|--project|-n|--interval|--ip)
        i=$((i + 2))
        ;;
      --workspace=*|--project=*|--interval=*|--ip=*)
        i=$((i + 1))
        ;;
      -*)
        i=$((i + 1))
        ;;
      *)
        count=$((count + 1))
        i=$((i + 1))
        ;;
    esac
  done

  echo $((count + 1))
}

_work_has_workspace_flag() {
  local i=2

  while [[ $i -lt $COMP_CWORD ]]; do
    case "\${COMP_WORDS[$i]}" in
      --)
        break
        ;;
      -w|--workspace|--workspace=*)
        echo 1
        return
        ;;
      -p|--project|-n|--interval|--ip)
        i=$((i + 2))
        ;;
      --project=*|--interval=*|--ip=*)
        i=$((i + 1))
        ;;
      *)
        i=$((i + 1))
        ;;
    esac
  done

  echo 0
}

_work_after_rest() {
  local i=2

  while [[ $i -lt $COMP_CWORD ]]; do
    if [[ "\${COMP_WORDS[$i]}" == "--" ]]; then
      echo 1
      return
    fi
    i=$((i + 1))
  done

  echo 0
}

_work_has_all_flag() {
  local i=2

  while [[ $i -lt $COMP_CWORD ]]; do
    case "\${COMP_WORDS[$i]}" in
      --)
        break
        ;;
      -a|--all)
        echo 1
        return
        ;;
    esac
    i=$((i + 1))
  done

  echo 0
}
`
