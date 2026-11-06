import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { CommandRecord } from "./types.js"

const exec = promisify(execFile)

type SocketSample = Record<string, Record<string, number>>

// Include client-side TIME-WAIT entries: short requests may close between samples.
// Only server-side sockets contribute byte counters; ACKs and sent bytes are not activity.
export function parseSocketSample(output: string, ports: ReadonlySet<number>): SocketSample {
  const sample: SocketSample = Object.fromEntries([...ports].map((port) => [port, {}]))
  let sockets: Record<string, number> | undefined
  let identity: string | undefined
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    if (/^\s/.test(line)) {
      const received = /\bbytes_received:(\d+)/.exec(line)
      if (sockets && identity && received) sockets[identity] = Number(received[1])
      continue
    }
    sockets = undefined
    identity = undefined
    const fields = line.trim().split(/\s+/)
    const [state, , , local, peer] = fields
    if (!local || !peer || state === "LISTEN" || state === "SYN-SENT" || state === "SYN-RECV") continue
    const localPort = Number(local.slice(local.lastIndexOf(":") + 1))
    const peerPort = Number(peer.slice(peer.lastIndexOf(":") + 1))
    const port = ports.has(localPort) ? localPort : state === "TIME-WAIT" && ports.has(peerPort) ? peerPort : undefined
    if (port === undefined) continue
    const cookie = /\bsk:(\S+)/.exec(line)?.[1] ?? ""
    identity = `${local}/${peer}/${cookie}`
    sockets = sample[String(port)]!
    sockets[identity] = Number(/\bbytes_received:(\d+)/.exec(line)?.[1] ?? 0)
  }
  return sample
}

export async function sampleBackendSockets(ports: ReadonlySet<number>): Promise<SocketSample> {
  const filter = [...ports].flatMap((port) => [`sport = :${port}`, `dport = :${port}`]).join(" or ")
  const { stdout } = await exec("ss", ["-tinaHe", "(", filter, ")"], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
  return parseSocketSample(stdout, ports)
}

export function recordSocketActivity(command: CommandRecord, sockets: Record<string, number>, now: number) {
  const previous = command.idleSockets ?? {}
  if (Object.entries(sockets).some(([id, received]) => previous[id] === undefined || received > previous[id]!)) {
    command.lastActivityAt = new Date(now).toISOString()
  }
  command.idleSockets = sockets
}

export function workspaceIdleSeconds(commands: Array<CommandRecord>, now: number): number | undefined {
  const routed = commands.filter((command) => command.url && !command.idleStoppedAt)
  if (routed.length === 0) return undefined
  const newestStart = Math.max(...commands.filter((command) => !command.exitedAt).map((command) => Date.parse(command.activityStartedAt ?? command.startedAt)))
  if (!routed.every((command) => command.idleTimeoutSeconds && command.backendPort &&
    now - Math.max(newestStart, Date.parse(command.lastActivityAt ?? command.startedAt)) >= command.idleTimeoutSeconds * 1000)) return undefined
  return Math.floor(Math.min(...routed.map((command) =>
    (now - Math.max(newestStart, Date.parse(command.lastActivityAt ?? command.startedAt))) / 1000)))
}
