import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawnCommand, usesPortless } from "./portless.js"
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

  test("leaves unrouted commands as shell commands", () => {
    assert.deepEqual(spawnCommand(config, "feature-x", "web", { run: "bun run test" }), {
      executable: "bun run test",
      args: [],
      shell: true,
      display: "bun run test",
    })
  })
})
