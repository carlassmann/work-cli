import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { debugLog, describe, errResult, ok, tryAsync } from "./result.js"
import type { Result } from "./result.js"
import type { WorkspaceState } from "./types.js"

export function stateRoot() {
  if (process.env["WORK_STATE_ROOT"]) {
    return process.env["WORK_STATE_ROOT"]
  }

  return path.join(os.homedir(), ".work-cli")
}

export function daemonSocketFile() {
  return path.join(stateRoot(), "workd.sock")
}

export function daemonPidFile() {
  return path.join(stateRoot(), "workd.pid")
}

export function daemonLockFile() {
  return path.join(stateRoot(), "workd.lock")
}

function workspaceStateDir(project: string, workspace: string) {
  return path.join(stateRoot(), "projects", project, "workspaces", workspace)
}

function workspaceStateFile(project: string, workspace: string) {
  return path.join(workspaceStateDir(project, workspace), "state.json")
}

export function commandLogFile(project: string, workspace: string, command: string) {
  return path.join(workspaceStateDir(project, workspace), "logs", `${command}.log`)
}

export async function readWorkspaceState(project: string, workspace: string): Promise<Result<WorkspaceState | null>> {
  const file = workspaceStateFile(project, workspace)

  let text: string

  try {
    text = await fs.readFile(file, "utf8")
  } catch (cause) {
    if (isNotFound(cause)) return ok(null)
    return errResult("IOError", `failed to read state file ${file}`, cause)
  }

  try {
    return ok(JSON.parse(text) as WorkspaceState)
  } catch (cause) {
    return errResult("IOError", `state file is corrupt: ${file}. Remove it to reset.`, cause)
  }
}

export async function writeWorkspaceState(state: WorkspaceState): Promise<Result<void>> {
  const file = workspaceStateFile(state.project, state.workspace)
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`

  return tryAsync("IOError", `failed to write workspace state for ${state.project}/${state.workspace}`, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
    await fs.rename(tmp, file)
  })
}

export async function listWorkspaceStates(): Promise<Array<WorkspaceState>> {
  const projectsDir = path.join(stateRoot(), "projects")
  const states: Array<WorkspaceState> = []

  for (const project of await readDirNames(projectsDir)) {
    const workspacesDir = path.join(projectsDir, project, "workspaces")

    for (const workspace of await readDirNames(workspacesDir)) {
      const result = await readWorkspaceState(project, workspace)

      if (!result.ok) {
        console.error(`warning: ${result.error.message}`)
        continue
      }

      if (result.value) {
        states.push(result.value)
      }
    }
  }

  return states
}

async function readDirNames(dir: string): Promise<Array<string>> {
  try {
    return await fs.readdir(dir)
  } catch (cause) {
    if (!isNotFound(cause)) {
      debugLog("state", `readdir ${dir} failed: ${describe(cause)}`)
    }
    return []
  }
}

function isNotFound(cause: unknown): boolean {
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
}
