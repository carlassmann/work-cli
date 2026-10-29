import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, test } from "node:test"
import { checkForUpdates, formatUpdateStatus, readUpdateStatus, startUpdateChecker } from "./updates.js"
import { git, initGitRepo, runCli, tempDir, writeFile } from "./test-helpers.js"

const installed = "a".repeat(40)
const latest = "b".repeat(40)
const previousRoot = process.env["WORK_STATE_ROOT"]
const previousDisabled = process.env["WORK_NO_UPDATE_CHECK"]
const execFileAsync = promisify(execFile)

beforeEach(async () => {
  process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-updates-")
  delete process.env["WORK_NO_UPDATE_CHECK"]
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env["WORK_STATE_ROOT"]
  else process.env["WORK_STATE_ROOT"] = previousRoot
  if (previousDisabled === undefined) delete process.env["WORK_NO_UPDATE_CHECK"]
  else process.env["WORK_NO_UPDATE_CHECK"] = previousDisabled
})

describe("updates", () => {
  test("build stamps its own repository commit, marks dirty builds, and ignores an enclosing repo", async () => {
    const root = await tempDir()
    await initGitRepo(root)
    const source = await fs.readFile(path.join(process.cwd(), "scripts", "write-build-info.mjs"), "utf8")
    const script = path.join(root, "scripts", "write-build-info.mjs")
    await writeFile(script, source)
    await writeFile(path.join(root, ".gitignore"), "dist\n")
    await git(["add", "scripts", ".gitignore"], root)
    await git(["commit", "-m", "Build metadata fixture"], root)
    const commit = (await git(["rev-parse", "HEAD"], root)).stdout.trim()
    await fs.mkdir(path.join(root, "dist"))
    await execFileAsync("node", [script])
    let generated = await fs.readFile(path.join(root, "dist", "build-info.js"), "utf8")
    assert.ok(generated.includes(JSON.stringify(commit)))
    assert.match(generated, /buildDirty = false/)
    await writeFile(path.join(root, "README.md"), "changed\n")
    await execFileAsync("node", [script])
    generated = await fs.readFile(path.join(root, "dist", "build-info.js"), "utf8")
    assert.match(generated, /buildDirty = true/)

    for (const directory of [await tempDir(), path.join(root, "nested-package")]) {
      const nestedScript = path.join(directory, "scripts", "write-build-info.mjs")
      await writeFile(nestedScript, source)
      await fs.mkdir(path.join(directory, "dist"))
      await execFileAsync("node", [nestedScript])
      generated = await fs.readFile(path.join(directory, "dist", "build-info.js"), "utf8")
      assert.match(generated, /buildCommit = null/)
    }
  })

  test("uses one request when main matches the baked commit", async () => {
    const requests: string[] = []
    const fetcher: typeof fetch = async (url) => {
      requests.push(String(url))
      return Response.json({ sha: installed })
    }
    const result = await checkForUpdates(installed, fetcher)
    assert.equal(result.status, "current")
    assert.equal(requests.length, 1)
    assert.match(requests[0]!, /\/commits\/main$/)
    assert.deepEqual(await readUpdateStatus(installed), result)
    assert.equal(await readUpdateStatus(latest), null)
  })

  test("distinguishes newer remote commits, local builds ahead, and divergence", async () => {
    for (const [comparison, expected] of [["ahead", "available"], ["behind", "ahead"], ["diverged", "diverged"], ["identical", "current"]]) {
      const requests: string[] = []
      const fetcher: typeof fetch = async (url) => {
        requests.push(String(url))
        return Response.json(requests.length === 1 ? { sha: latest } : { status: comparison })
      }
      const result = await checkForUpdates(installed, fetcher)
      assert.equal(result.status, expected)
      assert.equal(result.latestCommit, latest)
      assert.equal(requests.length, 2)
      assert.match(requests[1]!, new RegExp(`/compare/${installed}\\.\\.\\.${latest}$`))
      if (result.status === "available") assert.ok(formatUpdateStatus(result, installed).includes(`https://github.com/carlassmann/work-cli/commit/${latest}`))
    }
  })

  test("retains last successful status when offline or rate limited", async () => {
    const success = await checkForUpdates(installed, async () => Response.json({ sha: installed }))
    for (const fetcher of [async () => { throw new Error("offline") }, async () => new Response("rate limited", { status: 403 })]) {
      const failure = await checkForUpdates(installed, fetcher)
      assert.equal(failure.status, "current")
      assert.equal(failure.checkedAt, success.checkedAt)
      assert.ok(failure.error)
      assert.match(formatUpdateStatus(failure, installed), /last attempt failed/)
    }
    const firstFailure = await checkForUpdates(latest, async () => new Response("error", { status: 500 }))
    assert.equal(firstFailure.status, "unknown")
    assert.equal(firstFailure.checkedAt, null)
    assert.match(formatUpdateStatus(firstFailure, latest), /no successful check/)
  })

  test("invalid API responses never claim an update", async () => {
    for (const value of [{ sha: "main" }, {}, null, []]) {
      const result = await checkForUpdates(installed, async () => Response.json(value))
      assert.equal(result.status, "unknown")
      assert.ok(result.error)
    }
    let requests = 0
    const result = await checkForUpdates(installed, async () => Response.json(++requests === 1 ? { sha: latest } : { status: "unexpected" }))
    assert.equal(result.status, "unknown")
  })

  test("missing or corrupt cache is unknown and reads never contact the network", async () => {
    assert.equal(await readUpdateStatus(installed), null)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error("cache read contacted the network") }
    try {
      const file = path.join(process.env["WORK_STATE_ROOT"]!, "updates.json")
      for (const contents of ["{", "null", "[]", '{"installedCommit":"invalid"}', JSON.stringify({ installedCommit: installed, status: "available" })]) {
        await fs.writeFile(file, contents)
        assert.equal(await readUpdateStatus(installed), null)
      }
      assert.match(formatUpdateStatus(null, installed), /no cached check/)
      assert.match(formatUpdateStatus(null, null), /no commit metadata/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("background checker returns immediately and aborts a pending check on shutdown", async () => {
    let requested = false
    let aborted = false
    const fetcher: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
      requested = true
      options?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }, { once: true })
    })
    const stop = startUpdateChecker(installed, fetcher)
    try {
      assert.equal(typeof stop, "function")
      await waitUntil(() => requested)
      stop()
      await waitUntil(() => aborted)
      assert.equal(await readUpdateStatus(installed), null)
    } finally {
      stop()
    }
  })

  test("restarting checker reuses a recent cached attempt, including failed checks", async () => {
    await checkForUpdates(installed, async () => new Response("rate limited", { status: 403 }))
    let requests = 0
    const stop = startUpdateChecker(installed, async () => { requests++; return Response.json({ sha: installed }) })
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(requests, 0)
    } finally {
      stop()
    }
  })

  test("unknown builds and explicit opt-out never start checks", async () => {
    let requests = 0
    const fetcher: typeof fetch = async () => { requests++; return Response.json({ sha: installed }) }
    const stopUnknown = startUpdateChecker(null, fetcher)
    process.env["WORK_NO_UPDATE_CHECK"] = "1"
    const stopDisabled = startUpdateChecker(installed, fetcher)
    await new Promise((resolve) => setTimeout(resolve, 25))
    stopUnknown()
    stopDisabled()
    assert.equal(requests, 0)
  })

  test("CLI exposes cached status without starting the daemon and validates arguments", async () => {
    const root = await tempDir()
    const stateRoot = process.env["WORK_STATE_ROOT"]!
    const result = await runCli(["updates"], { cwd: root, stateRoot })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /update status unknown/)
    assert.equal(result.stderr, "")
    await assert.rejects(fs.stat(path.join(stateRoot, "workd.pid")))
    const extra = await runCli(["updates", "now"], { cwd: root, stateRoot })
    assert.equal(extra.exitCode, 1)
    assert.match(extra.stderr, /unexpected argument/)
    const help = await runCli(["updates", "--help"], { cwd: root, stateRoot })
    assert.match(help.stdout, /cached update status/)
  })
})

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(predicate(), true)
}
