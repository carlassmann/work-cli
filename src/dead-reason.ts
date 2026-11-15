import os from "node:os"
import type { CommandRecord } from "./types.js"

type DeadRecord = Pick<CommandRecord, "startedAt" | "exitedAt" | "exitCode" | "exitSignal" | "idleStoppedAt" | "idleStoppedSeconds" | "maxTtlSeconds" | "stopReason">

export type DeadReason = {
  kind: "idle" | "ttl" | "reboot" | "lost" | "signal" | "exit"
  // Short form for the ps status column.
  label: string
  // Reads after "<command> was ".
  text: string
}

export function deadReason(record: DeadRecord): DeadReason | null {
  if (!record.exitedAt) return null
  const at = formatTime(new Date(record.exitedAt))
  if (record.idleStoppedAt && record.exitedAt === record.idleStoppedAt) {
    const idle = formatDuration(record.idleStoppedSeconds ?? 0)
    return { kind: "idle", label: `idle ${idle}`, text: `stopped at ${at} after ${idle} without traffic (idleTimeoutSeconds)` }
  }
  if (record.stopReason === "ttl") {
    const ttl = formatDuration(record.maxTtlSeconds ?? 0)
    return { kind: "ttl", label: `ttl ${ttl}`, text: `stopped at ${at} after ${ttl} without worktree changes (maxTtlSeconds)` }
  }
  if (record.exitSignal) return { kind: "signal", label: record.exitSignal, text: `killed by ${record.exitSignal} at ${at}` }
  if (record.exitCode !== undefined) return { kind: "exit", label: `exit ${record.exitCode}`, text: `dead after exiting with code ${record.exitCode} at ${at}` }
  if (record.stopReason === "reboot" || diedInReboot(record)) return { kind: "reboot", label: "reboot", text: `gone after a machine reboot (noticed ${at})` }
  if (record.stopReason === "lost") {
    return { kind: "lost", label: "exit unknown", text: `found dead at ${at}; it died while no workd watched it (workd restarted, or its session ended)` }
  }
  return null
}

// Records marked dead before workd stored a cause: started before this boot, noticed after it.
function diedInReboot(record: DeadRecord) {
  if (record.stopReason || record.exitCode !== undefined || record.exitSignal || !record.exitedAt) return false
  const bootedAt = Date.now() - os.uptime() * 1000
  return Date.parse(record.startedAt) < bootedAt && Date.parse(record.exitedAt) >= bootedAt
}

function formatDuration(seconds: number) {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`
  return `${seconds}s`
}

export function formatTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0")
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  if (date.toDateString() === new Date().toDateString()) return time
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}
