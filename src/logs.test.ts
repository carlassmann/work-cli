import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { currentRunOffset, exitMarker, forEachLogChunk, parseExitMarker, readLastLines, rotateLargeLog, startMarker, writeMarker } from "./logs.js"
import { tempDir } from "./test-helpers.js"

describe("logs", () => {
  test("finds the current run from the recorded offset or the last start marker", async () => {
    const file = path.join(await tempDir(), "web.log")
    const first = `${startMarker("web", "2026-11-02T10:00:00.000Z")}ready\n${exitMarker("web", 41, { code: 1, signal: null, at: "2026-11-02T10:00:05.000Z" })}`
    const second = `${startMarker("web", "2026-11-02T11:00:00.000Z")}booting\n`
    await fs.writeFile(file, first + second)
    const secondOffset = Buffer.byteLength(first)

    assert.deepEqual(await currentRunOffset(file, secondOffset), { ok: true, value: secondOffset })
    assert.deepEqual(await currentRunOffset(file), { ok: true, value: secondOffset })
    assert.deepEqual(await currentRunOffset(file, 3), { ok: true, value: secondOffset })
    assert.deepEqual(await currentRunOffset(file, 10_000), { ok: true, value: secondOffset })
    assert.deepEqual(await currentRunOffset(file, 0), { ok: true, value: 0 })

    const read = await readLastLines(file, secondOffset, 100)
    assert.ok(read.ok)
    if (read.ok) assert.equal(read.value.data.toString("utf8"), second)

    assert.match(first, /^── work: exit web pid=41 code=1 2026-11-02T10:00:05.000Z$/m)
  })

  test("treats a log without markers as one run and finds markers across scan chunks", async () => {
    const file = path.join(await tempDir(), "web.log")
    await fs.writeFile(file, "old output\nmore\n")
    assert.deepEqual(await currentRunOffset(file), { ok: true, value: 0 })

    for (const before of [64 * 1024 - 5, 64 * 1024 + 3, 200_000]) {
      const padding = `${"x".repeat(before - 1)}\n`
      await fs.writeFile(file, `${padding}${startMarker("web", "2026-11-02T11:00:00.000Z")}${"y".repeat(70_000)}\n`)
      assert.deepEqual(await currentRunOffset(file), { ok: true, value: before }, String(before))
    }
  })

  test("writes markers on their own line and returns where they start", async () => {
    const file = path.join(await tempDir(), "web.log")
    await fs.writeFile(file, "done")
    const fd = fsSync.openSync(file, "a+")
    try {
      const exit = writeMarker(fd, exitMarker("web", 7, { code: 0, signal: null, at: "2026-11-02T10:00:00.000Z" }))
      const start = writeMarker(fd, startMarker("web", "2026-11-02T10:00:01.000Z"))
      const text = await fs.readFile(file, "utf8")
      assert.equal(text, "done\n── work: exit web pid=7 code=0 2026-11-02T10:00:00.000Z\n── work: start web 2026-11-02T10:00:01.000Z\n")
      assert.equal(exit, 5)
      assert.deepEqual(parseExitMarker(text.split("\n")[1]!), { pid: 7, code: 0, signal: null })
      assert.deepEqual(await currentRunOffset(file, start), { ok: true, value: start })
    } finally {
      fsSync.closeSync(fd)
    }

    const empty = path.join(path.dirname(file), "empty.log")
    const emptyFd = fsSync.openSync(empty, "a+")
    assert.equal(writeMarker(emptyFd, startMarker("web", "t")), 0)
    fsSync.closeSync(emptyFd)
  })

  test("reads the last lines by scanning backward across chunks", async () => {
    const file = path.join(await tempDir(), "web.log")
    const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index} ${"x".repeat(index % 50)}`)
    const run = `${lines.join("\n")}\n`
    await fs.writeFile(file, `earlier run\n${run}`)
    const start = "earlier run\n".length

    const tail = async (count: number) => {
      const read = await readLastLines(file, start, count)
      assert.ok(read.ok)
      return read.ok ? read.value : { data: Buffer.alloc(0), end: -1 }
    }
    assert.equal((await tail(2)).data.toString(), `${lines.at(-2)}\n${lines.at(-1)}\n`)
    assert.equal((await tail(3_000)).data.toString(), `${lines.slice(-3_000).join("\n")}\n`)
    assert.equal((await tail(50_000)).data.toString(), run)
    assert.deepEqual(await tail(0), { data: Buffer.alloc(0), end: start + Buffer.byteLength(run), truncated: false })
    assert.equal((await tail(3_000)).truncated, false)

    await fs.writeFile(file, "a\nb\nc")
    const unterminated = await readLastLines(file, 0, 2)
    assert.ok(unterminated.ok && unterminated.value.data.toString() === "b\nc")
  })

  test("caps the tail at the last MiB of an over-long line", async () => {
    const file = path.join(await tempDir(), "web.log")
    const marker = startMarker("web", "2026-11-02T11:00:00.000Z")
    await fs.writeFile(file, `${marker}${"x".repeat(4 * 1024 * 1024)}END`)

    const read = await readLastLines(file, Buffer.byteLength(marker), 1)
    assert.ok(read.ok)
    if (!read.ok) return
    assert.equal(read.value.truncated, true)
    assert.equal(read.value.data.length, 1024 * 1024)
    assert.ok(read.value.data.toString().endsWith("xEND"))
    assert.equal(read.value.end, Buffer.byteLength(marker) + 4 * 1024 * 1024 + 3)

    // A cut inside a multi-byte character moves forward to the next character.
    await fs.writeFile(file, `${"é".repeat(600_000)}\n`)
    const multibyte = await readLastLines(file, 0, 1)
    assert.ok(multibyte.ok)
    if (!multibyte.ok) return
    assert.equal(multibyte.value.truncated, true)
    assert.ok(multibyte.value.data.length <= 1024 * 1024)
    assert.ok(!multibyte.value.data.toString().includes("\ufffd"))
    assert.match(multibyte.value.data.toString(), /^é+\n$/)
  })

  test("streams a log in bounded chunks and stops when asked", async () => {
    const file = path.join(await tempDir(), "web.log")
    await fs.writeFile(file, Buffer.alloc(200_000, "x"))
    const sizes: Array<number> = []

    const all = await forEachLogChunk(file, 1_000, (chunk) => { sizes.push(chunk.length) })
    assert.deepEqual(all, { ok: true, value: 200_000 })
    assert.equal(sizes.reduce((total, size) => total + size, 0), 199_000)
    assert.ok(sizes.every((size) => size <= 64 * 1024))

    const stopped = await forEachLogChunk(file, 0, () => true)
    assert.deepEqual(stopped, { ok: true, value: 64 * 1024 })
  })

  test("rotates a large log to .1 and leaves small logs alone", async () => {
    const dir = await tempDir()
    const small = path.join(dir, "small.log")
    const large = path.join(dir, "large.log")
    await fs.writeFile(small, "short\n")
    await fs.writeFile(large, Buffer.alloc(10 * 1024 * 1024 + 1, "x"))

    await rotateLargeLog(small)
    await rotateLargeLog(large)
    await rotateLargeLog(path.join(dir, "missing.log"))

    assert.equal(await fs.readFile(small, "utf8"), "short\n")
    await assert.rejects(fs.stat(large))
    assert.equal((await fs.stat(`${large}.1`)).size, 10 * 1024 * 1024 + 1)
  })
})
