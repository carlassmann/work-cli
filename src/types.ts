type RestartPolicy = "manual" | "on-exit"
type RouteTarget = "local" | "lan"
type RouteProtocol = "https" | "http"

export type RoutingConfig = {
  target?: RouteTarget
  protocol?: RouteProtocol
  ip?: string
}

export type CommandConfig = {
  run: string
  label?: string
  cwd?: string
  env?: Record<string, string>
  autoStart?: boolean
  restart?: RestartPolicy
  restartWhenChanged?: Array<string>
  route?: boolean
  routeName?: string
  portless?: boolean
}

export type DevConfig = {
  project: string
  routing?: RoutingConfig
  worktrees?: {
    dir?: string
    setup?: string
  }
  commands: Record<string, CommandConfig>
}

export type WorkspaceRecord = {
  project: string
  workspace: string
  branch: string | null
  root: string
}

type CommandRecordBase = {
  id: string
  label: string
  command: string
  cwd: string
  log: string
  url: string | null
  startedAt: string
}

export type ProcessCommandRecord = CommandRecordBase & {
  runner: "process"
  pid: number
}

export type TmuxCommandRecord = CommandRecordBase & {
  runner: "tmux"
  argv: Array<string>
  tmuxSession: string
  tmuxWindow: string
}

export type CommandRecord = ProcessCommandRecord | TmuxCommandRecord

export type WorkspaceState = WorkspaceRecord & {
  commands: Record<string, CommandRecord>
}

export const DAEMON_PROTOCOL_VERSION = 2

export type DaemonCommand =
  | {
      type: "run"
      config: DevConfig
      workspace: WorkspaceRecord
      command: string
    }
  | {
      type: "adhoc"
      config: DevConfig
      workspace: WorkspaceRecord
      id: string
      argv: Array<string>
    }
  | {
      type: "down"
      project: string
      workspace: string
    }
  | {
      type: "stop"
      project: string
      workspace: string
      command: string
    }
  | {
      type: "restart"
      config: DevConfig
      workspace: WorkspaceRecord
      command: string
    }
  | {
      type: "restartTracked"
      project: string
      workspace: string
      command: string
    }
  | {
      type: "prune"
    }
  | {
      type: "ping"
    }
  | {
      type: "shutdown"
    }

export type StartResult = {
  record: CommandRecord
  started: boolean
}

type DaemonResults = {
  ping: { pid: number }
  run: StartResult
  adhoc: StartResult
  restart: StartResult
  restartTracked: StartResult
  down: Array<string>
  stop: boolean
  prune: number
  shutdown: { stopping: true }
}

export type DaemonResultType<K extends DaemonCommand["type"]> = K extends keyof DaemonResults ? DaemonResults[K] : never

import type { ErrorTag } from "./result.js"

export type DaemonResponse<K extends DaemonCommand["type"] = DaemonCommand["type"]> =
  | {
      ok: true
      message?: string
      data: DaemonResultType<K>
    }
  | {
      ok: false
      error: string
      tag?: ErrorTag
    }
