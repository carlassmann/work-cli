import assert from "node:assert/strict"
import { test } from "node:test"
import { parseSocketSample, recordSocketActivity, workspaceIdleSeconds } from "./idle.js"
import type { CommandRecord } from "./types.js"

function command(overrides: Partial<CommandRecord> = {}): CommandRecord {
  return {
    id: "web", label: "web", command: "node server.js", run: "node server.js",
    route: "web", cwd: "/tmp", log: "/tmp/web.log", url: "http://web.localhost",
    backendPort: 3000, pid: 1, startedAt: new Date(0).toISOString(), idleTimeoutSeconds: 60,
    ...overrides,
  }
}

test("parses IPv4/IPv6 receive counters, closing sockets and client TIME-WAIT, ignoring listeners", () => {
  const sample = parseSocketSample(`LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* sk:1
ESTAB 0 0 127.0.0.1:3000 127.0.0.1:4000 ino:12 sk:2
\t cubic bytes_sent:999 bytes_received:42 segs_in:4
ESTAB 0 0 [::1]:3000 [::1]:4001 sk:3
\t cubic bytes_received:120
FIN-WAIT-2 0 0 127.0.0.1:3000 127.0.0.1:4002 sk:4 bytes_received:10
TIME-WAIT 0 0 127.0.0.1:4003 127.0.0.1:3000 sk:5
ESTAB 0 0 127.0.0.1:4004 127.0.0.1:3000 sk:6
\t bytes_received:99999
ESTAB 0 0 127.0.0.1:5000 127.0.0.1:4005 sk:7
\t bytes_received:100
`, new Set([3000, 3001]))
  assert.deepEqual(sample, {
    3000: { "127.0.0.1:3000/127.0.0.1:4000/2": 42, "[::1]:3000/[::1]:4001/3": 120,
      "127.0.0.1:3000/127.0.0.1:4002/4": 10, "127.0.0.1:4003/127.0.0.1:3000/5": 0 },
    3001: {},
  })
  assert.deepEqual(parseSocketSample("", new Set([3000])), { 3000: {} })
})

test("new connections and increased receives count; open sockets, disappearing connections and counter resets do not", () => {
  const record = command()
  recordSocketActivity(record, { a: 100, b: 500 }, 10_000)
  assert.equal(record.lastActivityAt, new Date(10_000).toISOString())
  recordSocketActivity(record, { a: 100, b: 500 }, 20_000)
  assert.equal(record.lastActivityAt, new Date(10_000).toISOString())
  recordSocketActivity(record, { a: 101 }, 30_000)
  assert.equal(record.lastActivityAt, new Date(30_000).toISOString())
  recordSocketActivity(record, { a: 101, c: 0 }, 40_000)
  assert.equal(record.lastActivityAt, new Date(40_000).toISOString())
  const recovered = JSON.parse(JSON.stringify(record)) as CommandRecord
  recordSocketActivity(recovered, { a: 101, c: 0 }, 50_000)
  recordSocketActivity(recovered, { a: 1 }, 55_000)
  recordSocketActivity(recovered, {}, 60_000)
  assert.equal(recovered.lastActivityAt, new Date(40_000).toISOString())
})

test("idle decision requires all routed commands, ignores workers, and starts the clock on launch", () => {
  const web = command()
  const worker = command({ url: null, backendPort: undefined, idleTimeoutSeconds: undefined })
  assert.equal(workspaceIdleSeconds([worker], 120_000), undefined)
  assert.equal(workspaceIdleSeconds([web, worker], 59_999), undefined)
  assert.equal(workspaceIdleSeconds([web, worker], 60_000), 60)
  const api = command({ id: "api", lastActivityAt: new Date(40_000).toISOString(), idleTimeoutSeconds: 90 })
  assert.equal(workspaceIdleSeconds([web, api, worker], 120_000), undefined)
  assert.equal(workspaceIdleSeconds([web, api, worker], 130_000), 90)
  assert.equal(workspaceIdleSeconds([web, command({ idleTimeoutSeconds: 0 })], 130_000), undefined)
  assert.equal(workspaceIdleSeconds([web, command({ backendPort: undefined })], 130_000), undefined)
  assert.equal(workspaceIdleSeconds([command({ idleStoppedAt: new Date(0).toISOString() })], 130_000), undefined)
  assert.equal(workspaceIdleSeconds([web, command({ url: null, startedAt: new Date(100_000).toISOString() })], 130_000), undefined)
})

test("automatic server and worker restarts do not extend the idle deadline", () => {
  const activityStartedAt = new Date(0).toISOString()
  const startedAt = new Date(119_000).toISOString()
  const web = command({ startedAt, activityStartedAt, lastActivityAt: activityStartedAt })
  const worker = command({ url: null, startedAt, activityStartedAt })
  assert.equal(workspaceIdleSeconds([web, worker], 120_000), 120)
  assert.equal(workspaceIdleSeconds([web, { ...worker, activityStartedAt: startedAt }], 120_000), undefined)
})
