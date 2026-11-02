import fs from "node:fs/promises"
import fsSync from "node:fs"
import { debugLog, describe, tryAsync } from "./result.js"
import type { Result } from "./result.js"

const MARKER_PREFIX = "── work: "
const START_MARKER = `${MARKER_PREFIX}start `
const MAX_LOG_BYTES = 10 * 1024 * 1024
const SCAN_CHUNK_BYTES = 64 * 1024
export const MAX_TAIL_BYTES = 1024 * 1024

export type CommandExit = { code: number | null; signal: string | null; at: string }

export function startMarker(id: string, at: string) {
  return `${START_MARKER}${id} ${at}\n`
}

export function exitMarker(id: string, pid: number, exit: CommandExit) {
  const status = exit.signal ? `signal=${exit.signal}` : `code=${exit.code}`
  return `${MARKER_PREFIX}exit ${id} pid=${pid} ${status} ${exit.at}\n`
}

const EXIT_MARKER = new RegExp(`^${MARKER_PREFIX}exit \\S+ pid=(\\d+) (?:code=(-?\\d+)|signal=(\\S+)) `)

export function parseExitMarker(line: string): { pid: number; code: number | null; signal: string | null } | null {
  const match = EXIT_MARKER.exec(line)
  if (!match) return null
  return { pid: Number(match[1]), code: match[2] === undefined ? null : Number(match[2]), signal: match[3] ?? null }
}

// Writes a marker on a line of its own, even when the log ends mid-line, and returns the byte offset where it starts.
export function writeMarker(fd: number, marker: string) {
  const size = fsSync.fstatSync(fd).size
  const last = Buffer.alloc(1)
  const prefix = size > 0 && fsSync.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a ? "\n" : ""
  fsSync.writeSync(fd, `${prefix}${marker}`)
  return size + prefix.length
}

export function isMarkerLine(line: string) {
  return line.startsWith(MARKER_PREFIX)
}

// Starts each run in a fresh file once the log passes the limit, keeping one older file as <log>.1.
export async function rotateLargeLog(file: string) {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat || stat.size <= MAX_LOG_BYTES) return
  await fs.rename(file, `${file}.1`).catch((cause) => debugLog("logs", `rotate ${file} failed: ${describe(cause)}`))
}

// Byte offset where the latest run starts: the recorded offset when it still points at a start marker,
// otherwise the last start marker in the file, otherwise 0.
export async function currentRunOffset(file: string, recorded?: number): Promise<Result<number>> {
  return tryAsync("IOError", `failed to read log ${file}`, async () => {
    const handle = await fs.open(file, "r")
    try {
      const { size } = await handle.stat()
      if (recorded !== undefined && recorded <= size && await markerAt(handle, recorded)) return recorded
      return await lastMarkerOffset(handle, size)
    } finally {
      await handle.close()
    }
  })
}

// Reads from start to the current end of the file in bounded chunks. onChunk returns true to stop early.
// Resolves to the position after the last chunk read.
export async function forEachLogChunk(
  file: string,
  start: number,
  onChunk: (chunk: Buffer) => boolean | void | Promise<boolean | void>,
): Promise<Result<number>> {
  return tryAsync("IOError", `failed to read log ${file}`, async () => {
    const handle = await fs.open(file, "r")
    try {
      const { size } = await handle.stat()
      let position = start
      while (position < size) {
        const buffer = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, size - position))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        position += bytesRead
        if (await onChunk(buffer.subarray(0, bytesRead))) break
      }
      return position
    } finally {
      await handle.close()
    }
  })
}

// Reads only the last count lines after start, scanning backward from the end of the file.
// Output stops at MAX_TAIL_BYTES; truncated says the selected lines started earlier.
export async function readLastLines(
  file: string,
  start: number,
  count: number,
): Promise<Result<{ data: Buffer; end: number; truncated: boolean }>> {
  return tryAsync("IOError", `failed to read log ${file}`, async () => {
    const handle = await fs.open(file, "r")
    try {
      const { size: end } = await handle.stat()
      const floor = Math.max(start, end - MAX_TAIL_BYTES)
      const found = count === 0 ? end : await lineStart(handle, floor, end, count)
      const truncated = found === null && floor > start
      const data = Buffer.alloc(end - (found ?? floor))
      const { bytesRead } = await handle.read(data, 0, data.length, found ?? floor)
      const read = data.subarray(0, bytesRead)
      return { data: truncated ? read.subarray(utf8Start(read)) : read, end: (found ?? floor) + bytesRead, truncated }
    } finally {
      await handle.close()
    }
  })
}

// Skips UTF-8 continuation bytes so a cut never starts inside a character.
function utf8Start(data: Buffer) {
  let index = 0
  while (index < Math.min(3, data.length) && (data[index]! & 0xc0) === 0x80) index++
  return index
}

async function lineStart(handle: fs.FileHandle, start: number, end: number, count: number) {
  let position = end
  let newlines = 0

  while (position > start) {
    const chunkStart = Math.max(start, position - SCAN_CHUNK_BYTES)
    const buffer = Buffer.alloc(position - chunkStart)
    await handle.read(buffer, 0, buffer.length, chunkStart)
    for (let index = buffer.length - 1; index >= 0; index--) {
      // A newline as the last byte ends the last line rather than starting a new one.
      if (buffer[index] !== 0x0a || chunkStart + index === end - 1) continue
      if (++newlines === count) return chunkStart + index + 1
    }
    position = chunkStart
  }

  return null
}

async function markerAt(handle: fs.FileHandle, offset: number) {
  const expected = Buffer.from(START_MARKER)
  const buffer = Buffer.alloc(expected.length)
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
  if (bytesRead !== expected.length || !buffer.equals(expected)) return false
  if (offset === 0) return true
  const previous = Buffer.alloc(1)
  await handle.read(previous, 0, 1, offset - 1)
  return previous[0] === 0x0a
}

async function lastMarkerOffset(handle: fs.FileHandle, size: number) {
  const needle = Buffer.from(`\n${START_MARKER}`)
  let end = size

  while (end > 0) {
    const start = Math.max(0, end - SCAN_CHUNK_BYTES)
    // Overlap the following chunk so a marker split across chunks is still found.
    const length = Math.min(size, end + needle.length - 1) - start
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    const index = buffer.subarray(0, bytesRead).lastIndexOf(needle)
    if (index !== -1) return start + index + 1
    end = start
  }

  return 0
}
