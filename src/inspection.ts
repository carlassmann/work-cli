import { commandRuntimeStatus } from "./processes.js"
import type { WorkspaceState } from "./types.js"

export async function commandStatuses(states: ReadonlyArray<WorkspaceState>) {
  const rows = []
  for (const state of states) {
    for (const command of Object.values(state.commands)) {
      rows.push({
        project: state.project,
        workspace: state.workspace,
        command: command.id,
        status: await commandRuntimeStatus(command),
        pid: command.pid,
        url: command.url,
      })
    }
  }
  return rows
}

export function commandUrls(states: ReadonlyArray<WorkspaceState>) {
  return states.flatMap((state) => Object.values(state.commands).flatMap((command) =>
    command.url ? [{ project: state.project, workspace: state.workspace, command: command.id, url: command.url }] : [],
  ))
}
