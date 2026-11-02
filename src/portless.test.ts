import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { commandProcess, commandRoute, routeEnvironmentForConfig, usesPortless, websocketUrl } from "./portless.js"
import type { DevConfig } from "./types.js"

const config: DevConfig = {
  project: "tilly",
  commands: {},
}

describe("portless", () => {
  test("uses portless for routed commands by default", () => {
    assert.equal(usesPortless({ run: "bun run dev", route: true }), true)
    assert.equal(usesPortless({ run: "bun run dev" }), false)
    assert.equal(usesPortless({ run: "bun run dev", route: true, portless: false }), false)
  })

  test("uses routeName override when set", () => {
    const route = commandRoute(config, "feature-x", "web", { run: "bun run dev", route: true, routeName: "app" })

    assert.equal(route, "app-feature-x-tilly")
    assert.deepEqual(commandProcess("bun run dev", route), {
      executable: "portless",
      args: ["app-feature-x-tilly", "sh", "-lc", "bun run dev"],
      shell: false,
      display: 'portless app-feature-x-tilly sh -lc "bun run dev"',
    })
  })

  test("wraps routed commands without depending on portless internals", () => {
    const route = commandRoute(config, "feature-x", "web", { run: "bun run dev", route: true })

    assert.deepEqual(commandProcess("bun run dev", route), {
      executable: "portless",
      args: ["web-feature-x-tilly", "sh", "-lc", "bun run dev"],
      shell: false,
      display: 'portless web-feature-x-tilly sh -lc "bun run dev"',
    })
  })

  test("pins the backend port for Cloudflare Tunnel forwarding", () => {
    assert.deepEqual(commandProcess("bun run dev", "web-feature-x-tilly", 43123), {
      executable: "portless",
      args: ["web-feature-x-tilly", "--app-port", "43123", "sh", "-lc", "bun run dev"],
      shell: false,
      display: 'portless web-feature-x-tilly --app-port 43123 sh -lc "bun run dev"',
    })
  })

  test("leaves unrouted commands as shell commands", () => {
    const route = commandRoute(config, "feature-x", "web", { run: "bun run test" })

    assert.equal(route, null)
    assert.deepEqual(commandProcess("bun run test", route), {
      executable: "bun run test",
      args: [],
      shell: true,
      display: "bun run test",
    })
  })

  test("exports full semantic URLs for routed commands", () => {
    const env = routeEnvironmentForConfig({
      project: "tilly",
      commands: {
        web: { run: "bun run dev", route: true },
        sync: { run: "bun run sync", route: true },
        worker: { run: "bun run worker" },
      },
    }, "feature-x", 443)

    assert.equal(env.WORK_URL, "https://web-feature-x-tilly.localhost")
    assert.equal(env.WORK_WEB_URL, "https://web-feature-x-tilly.localhost")
    assert.equal(env.WORK_WEB_WS_URL, "wss://web-feature-x-tilly.localhost")
    assert.equal(env.WORK_SYNC_URL, "https://sync-feature-x-tilly.localhost")
    assert.equal(env.WORK_SYNC_WS_URL, "wss://sync-feature-x-tilly.localhost")
    assert.deepEqual(JSON.parse(env.WORK_URLS), {
      web: "https://web-feature-x-tilly.localhost",
      sync: "https://sync-feature-x-tilly.localhost",
    })
    assert.deepEqual(JSON.parse(env.WORK_WS_URLS), {
      web: "wss://web-feature-x-tilly.localhost",
      sync: "wss://sync-feature-x-tilly.localhost",
    })
  })

  test("exports URLs that Portless serves on a non-default port", () => {
    const workspace = "ruler-fix-tabs-size-strip-instead-of-touch-t"
    const command = { run: "bun run preview", route: true }
    const env = routeEnvironmentForConfig({ project: "syntwin-mono", commands: { web: { run: "bun run dev", route: true }, preview: command } }, workspace, 1355)

    assert.equal(env.WORK_WEB_URL, `https://web-${workspace}-syntwin-mono.localhost:1355`)
    assert.equal(env.WORK_WEB_WS_URL, `wss://web-${workspace}-syntwin-mono.localhost:1355`)
    assert.equal(env.WORK_PREVIEW_URL, `https://preview-${workspace}-syn-154ac3.localhost:1355`)
    assert.equal(commandRoute({ project: "syntwin-mono", commands: {} }, workspace, "preview", command), `preview-${workspace}-syn-154ac3`)
  })

  test("converts http URLs to websocket URLs", () => {
    assert.equal(websocketUrl("http://web.local"), "ws://web.local")
    assert.equal(websocketUrl("https://web.local"), "wss://web.local")
  })

  test("exports single-label Cloudflare HTTPS and WebSocket URLs", () => {
    const env = routeEnvironmentForConfig({
      project: "tilly",
      commands: {
        web: { run: "bun run dev", route: true },
        sync: { run: "bun run sync", route: true },
      },
    }, "feature-x", 1355, {
      mode: "cloudflare",
      machine: "cbook",
      domain: "example.com",
      tunnelId: "11111111-1111-4111-8111-111111111111",
      credentialsFile: "/tmp/tunnel.json",
    })

    assert.equal(env.WORK_URL, "https://cbook-web-feature-x-tilly.example.com")
    assert.equal(env.WORK_SYNC_URL, "https://cbook-sync-feature-x-tilly.example.com")
    assert.equal(env.WORK_SYNC_WS_URL, "wss://cbook-sync-feature-x-tilly.example.com")
  })
})
