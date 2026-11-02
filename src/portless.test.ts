import { describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { commandProcess, commandRoute, portlessEndpoints, portlessPortsForConfig, refreshRouteUrl, routeEnvironmentForConfig, usesPortless, websocketUrl } from "./portless.js"
import { tempDir } from "./test-helpers.js"
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
    }, "feature-x", { web: 443, sync: 443 })

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
    const env = routeEnvironmentForConfig({ project: "syntwin-mono", commands: { web: { run: "bun run dev", route: true }, preview: command } }, workspace, { web: 1355, preview: 1355 })

    assert.equal(env.WORK_WEB_URL, `https://web-${workspace}-syntwin-mono.localhost:1355`)
    assert.equal(env.WORK_WEB_WS_URL, `wss://web-${workspace}-syntwin-mono.localhost:1355`)
    assert.equal(env.WORK_PREVIEW_URL, `https://preview-${workspace}-syn-154ac3.localhost:1355`)
    assert.equal(commandRoute({ project: "syntwin-mono", commands: {} }, workspace, "preview", command), `preview-${workspace}-syn-154ac3`)
  })

  test("resolves each routed command's port with its own env overrides", async () => {
    const stateDir = async (port: number) => {
      const dir = await tempDir("portless-state-")
      await fs.writeFile(path.join(dir, "proxy.port"), `${port}\n`)
      return dir
    }
    const ports = await portlessPortsForConfig({
      project: "tilly",
      env: { PORTLESS_STATE_DIR: await stateDir(1355) },
      commands: {
        web: { run: "bun run dev", route: true },
        api: { run: "bun run api", route: true, env: { PORTLESS_STATE_DIR: await stateDir(8443) } },
        worker: { run: "bun run worker" },
      },
    }, { PORTLESS_PORT: "9" })

    assert.deepEqual(ports, { web: 1355, api: 8443 })
  })

  test("hands the proxy check the same ports URLs use, with each command's effective env", async () => {
    const dir = await tempDir("portless-state-")
    await fs.writeFile(path.join(dir, "proxy.port"), "8443\n")
    const endpoints = await portlessEndpoints({ PORTLESS_STATE_DIR: dir, HOME: "/home/me" }, { web: undefined, api: { PORTLESS_STATE_DIR: dir, PORTLESS_PORT: "9" } })

    assert.deepEqual(endpoints, [
      { id: "web", port: 8443, environment: { PORTLESS_STATE_DIR: dir, HOME: "/home/me" } },
      { id: "api", port: 8443, environment: { PORTLESS_STATE_DIR: dir, HOME: "/home/me", PORTLESS_PORT: "9" } },
    ])
  })

  test("refreshes recorded localhost URLs and leaves external ones alone", () => {
    assert.equal(refreshRouteUrl("https://web-main-demo.localhost", 1355), "https://web-main-demo.localhost:1355")
    assert.equal(refreshRouteUrl("https://web-main-demo.localhost:1355", 443), "https://web-main-demo.localhost")
    assert.equal(refreshRouteUrl("https://preview-ruler-fix-tabs-size-strip-instead-of-touch-t-syntwin-mono.localhost", 1355), "https://preview-ruler-fix-tabs-size-strip-instead-of-touch-t-syn-154ac3.localhost:1355")
    assert.equal(refreshRouteUrl("https://web-main-demo.dev.example.com", 1355), "https://web-main-demo.dev.example.com")
    assert.equal(refreshRouteUrl("https://cbook-web-main-demo.example.com", 1355), "https://cbook-web-main-demo.example.com")
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
    }, "feature-x", { web: 1355, sync: 1355 }, {
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
