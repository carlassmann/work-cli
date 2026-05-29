import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { portlessUrl, routeEnvironmentForConfig, spawnCommand, usesPortless, websocketUrl } from "./portless.js"
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
    assert.deepEqual(spawnCommand(config, "feature-x", "web", { run: "bun run dev", route: true, routeName: "app" }), {
      executable: "portless",
      args: ["app-feature-x-tilly", "sh", "-lc", "bun run dev"],
      shell: false,
      display: 'portless app-feature-x-tilly sh -lc "bun run dev"',
    })
  })

  test("wraps routed commands without depending on portless internals", () => {
    assert.deepEqual(spawnCommand(config, "feature-x", "web", { run: "bun run dev", route: true }), {
      executable: "portless",
      args: ["web-feature-x-tilly", "sh", "-lc", "bun run dev"],
      shell: false,
      display: 'portless web-feature-x-tilly sh -lc "bun run dev"',
    })
  })

  test("passes LAN routing flags to portless", () => {
    assert.deepEqual(spawnCommand({
      project: "tilly",
      routing: {
        target: "lan",
        protocol: "http",
        ip: "192.168.1.42",
      },
      commands: {},
    }, "feature-x", "web", { run: "bun run dev", route: true }), {
      executable: "portless",
      args: ["web-feature-x-tilly", "--lan", "--no-tls", "--ip", "192.168.1.42", "sh", "-lc", "bun run dev"],
      shell: false,
      display: 'portless web-feature-x-tilly --lan --no-tls --ip 192.168.1.42 sh -lc "bun run dev"',
    })
  })

  test("leaves unrouted commands as shell commands", () => {
    assert.deepEqual(spawnCommand(config, "feature-x", "web", { run: "bun run test" }), {
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
    }, "feature-x")

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

  test("exports LAN URLs for LAN routing", () => {
    const config: DevConfig = {
      project: "tilly",
      routing: { target: "lan" },
      commands: {
        web: { run: "bun run dev", route: true },
        sync: { run: "bun run sync", route: true },
      },
    }
    const env = routeEnvironmentForConfig(config, "feature-x")

    assert.equal(portlessUrl(config, "feature-x", "web", config.commands.web!), "https://web-feature-x-tilly.local")
    assert.equal(env.WORK_ROUTE_TARGET, "lan")
    assert.equal(env.WORK_WEB_URL, "https://web-feature-x-tilly.local")
    assert.equal(env.WORK_SYNC_WS_URL, "wss://sync-feature-x-tilly.local")
  })

  test("exports HTTP LAN URLs when TLS is disabled", () => {
    const env = routeEnvironmentForConfig({
      project: "tilly",
      routing: { target: "lan", protocol: "http" },
      commands: {
        web: { run: "bun run dev", route: true },
      },
    }, "feature-x")

    assert.equal(env.WORK_WEB_URL, "http://web-feature-x-tilly.local")
    assert.equal(env.WORK_WEB_WS_URL, "ws://web-feature-x-tilly.local")
  })

  test("converts http URLs to websocket URLs", () => {
    assert.equal(websocketUrl("http://web.local"), "ws://web.local")
    assert.equal(websocketUrl("https://web.local"), "wss://web.local")
  })
})
