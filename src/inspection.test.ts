import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { commandStatuses, commandUrls } from "./inspection.js"
import type { WorkspaceState } from "./types.js"

function state(project: string): WorkspaceState {
  return {
    project,
    workspace: "main",
    branch: "main",
    root: "/tmp/project",
    env: { SECRET: "workspace-secret" },
    commands: {
      web: {
        id: "web",
        label: "Web",
        pid: process.pid,
        command: "SECRET=command-secret node server.js",
        run: "SECRET=command-secret node server.js",
        route: "web-main-demo",
        cwd: "/tmp/project",
        log: "/tmp/server.log",
        url: `https://web-main-${project}.localhost`,
        startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        env: { SECRET: "command-secret" },
      },
      worker: {
        id: "worker",
        label: "Worker",
        pid: 2_147_483_647,
        command: "node worker.js",
        run: "node worker.js",
        route: null,
        cwd: "/tmp/project",
        log: "/tmp/worker.log",
        url: null,
        startedAt: new Date().toISOString(),
      },
    },
  }
}

describe("public command inspection", () => {
  test("status preserves typed process status and exposes only public fields", async () => {
    assert.deepEqual(await commandStatuses([state("demo")]), [
      { project: "demo", workspace: "main", command: "web", status: "up", pid: process.pid, url: "https://web-main-demo.localhost" },
      { project: "demo", workspace: "main", command: "worker", status: "dead", pid: 2_147_483_647, url: null },
    ])
  })

  test("URLs exclude unrouted commands and distinguish matching workspace names", () => {
    assert.deepEqual(commandUrls([state("demo"), state("other")]), [
      { project: "demo", workspace: "main", command: "web", url: "https://web-main-demo.localhost" },
      { project: "other", workspace: "main", command: "web", url: "https://web-main-other.localhost" },
    ])
  })

  test("empty state stays an empty array for both outputs", async () => {
    assert.deepEqual(await commandStatuses([]), [])
    assert.deepEqual(commandUrls([{ ...state("demo"), commands: {} }]), [])
  })
})
