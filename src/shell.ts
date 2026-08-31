import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { appError, debugLog, describe, err, ok } from "./result.js"
import type { Result } from "./result.js"

const execFileAsync = promisify(execFile)

export async function exec(command: string, args: Array<string>, cwd: string): Promise<Result<string>> {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd })
    return ok(stdout.trim())
  } catch (cause) {
    return err(appError("ShellError", `failed to run ${command} ${args.join(" ")}`, cause))
  }
}

export async function execOk(command: string, args: Array<string>, cwd: string): Promise<boolean> {
  try {
    await execFileAsync(command, args, { cwd })
    return true
  } catch (cause) {
    debugLog("shell", `${command} ${args.join(" ")} failed: ${describe(cause)}`)
    return false
  }
}

export async function commandExists(command: string, environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    await execFileAsync("which", [command], { env: environment })
    return true
  } catch {
    return false
  }
}

export async function existsAt(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export function isPidRunning(pid: number): boolean {
  if (pid <= 1) return false

  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

export async function processCommand(pid: number, environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return psValue(pid, "command", environment)
}

async function processElapsedMs(pid: number, environment: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  const value = await psValue(pid, "etime", environment)
  if (!value) return null
  const [dayPart, clockPart] = value.includes("-") ? value.split("-", 2) : ["0", value]
  if (!clockPart) return null
  const clock = clockPart.split(":").map(Number)
  if (clock.some(Number.isNaN) || clock.length < 2 || clock.length > 3) return null
  const [hours, minutes, seconds] = clock.length === 3 ? clock : [0, ...clock]
  return (((Number(dayPart) * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0)) * 1000
}

export async function isTrackedPidRunning(
  pid: number,
  startedAt: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!isPidRunning(pid)) return false
  const elapsed = await processElapsedMs(pid, environment)
  const recordedStart = new Date(startedAt)
  if (elapsed === null || Number.isNaN(recordedStart.valueOf())) return false
  return Math.abs(Date.now() - recordedStart.valueOf() - elapsed) < 10_000
}

async function psValue(pid: number, field: string, environment: NodeJS.ProcessEnv): Promise<string | null> {
  for (const executable of ["ps", "/bin/ps"]) {
    try {
      const result = await execFileAsync(executable, ["-p", String(pid), "-o", `${field}=`], { env: environment })
      return result.stdout.trim() || null
    } catch {}
  }
  return null
}
