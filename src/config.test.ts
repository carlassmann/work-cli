import path from "node:path"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { createConfig, loadConfig, resolveMaxTtlSeconds } from "./config.js"
import { tempDir, writeFile } from "./test-helpers.js"

describe("config", () => {
  test("resolves TTL with env precedence, global fallback, and explicit opt-out", async () => {
    const config = { project: "tilly", commands: {} }
    const environment = { XDG_CONFIG_HOME: await tempDir() }
    assert.deepEqual(await resolveMaxTtlSeconds(config, environment), { ok: true, value: 0 })
    await writeFile(path.join(environment.XDG_CONFIG_HOME, "work", "config.json"), '{"maxTtlSeconds": 3600}')
    assert.deepEqual(await resolveMaxTtlSeconds(config, environment), { ok: true, value: 3600 })
    assert.deepEqual(await resolveMaxTtlSeconds({ maxTtlSeconds: 60 }, environment), { ok: true, value: 60 })
    assert.deepEqual(await resolveMaxTtlSeconds({ maxTtlSeconds: 0 }, environment), { ok: true, value: 0 })
    assert.deepEqual(await resolveMaxTtlSeconds({ maxTtlSeconds: 60 }, { ...environment, WORK_MAX_TTL_SECONDS: "120" }), { ok: true, value: 120 })
    assert.deepEqual(await resolveMaxTtlSeconds(config, { ...environment, WORK_MAX_TTL_SECONDS: "0" }), { ok: true, value: 0 })
    for (const value of ["", " ", "invalid", "-1", "Infinity", "NaN"]) {
      const result = await resolveMaxTtlSeconds({ maxTtlSeconds: 60 }, { ...environment, WORK_MAX_TTL_SECONDS: value })
      assert.equal(result.ok, false, value)
    }
  })

  test("validates global config without letting lower precedence files block overrides", async () => {
    const environment = { XDG_CONFIG_HOME: await tempDir() }
    const file = path.join(environment.XDG_CONFIG_HOME, "work", "config.json")
    for (const contents of ["{", "null", "[]", '{"maxTtlSeconds": "60"}', '{"maxTtlSeconds": -1}', '{"maxTtlSeconds": null}', '{"maxTtlSeconds": 1e400}']) {
      await writeFile(file, contents)
      const invalid = await resolveMaxTtlSeconds({}, environment)
      assert.equal(invalid.ok, false, contents)
      if (!invalid.ok) assert.match(invalid.error.message, /config\.json/)
      assert.deepEqual(await resolveMaxTtlSeconds({ maxTtlSeconds: 0 }, environment), { ok: true, value: 0 })
      assert.deepEqual(await resolveMaxTtlSeconds({}, { ...environment, WORK_MAX_TTL_SECONDS: "60" }), { ok: true, value: 60 })
    }
    await writeFile(file, "{}")
    assert.deepEqual(await resolveMaxTtlSeconds({}, environment), { ok: true, value: 0 })
    await writeFile(file, '{"maxTtlSeconds": 0}')
    assert.deepEqual(await resolveMaxTtlSeconds({}, environment), { ok: true, value: 0 })
  })

  test("rejects invalid configured TTLs", async () => {
    for (const value of ['"60"', "null", "-1", "NaN", "Infinity"]) {
      const root = await tempDir()
      await writeConfig(root, `export default { project: "tilly", maxTtlSeconds: ${value}, commands: {} }`)
      const loaded = await loadConfig(root)
      assert.equal(loaded.ok, false, value)
      if (!loaded.ok) assert.match(loaded.error.message, /maxTtlSeconds/)
    }
  })

  test("creates a readable default config", async () => {
    const root = await tempDir()

    const created = await createConfig(root, "tilly")
    assert.equal(created.ok, true)

    const loaded = await loadConfig(root)
    assert.equal(loaded.ok, true)
    if (loaded.ok) {
      assert.deepEqual(loaded.value, {
        project: "tilly",
        worktrees: {
          dir: "../tilly.worktrees",
        },
        commands: {
          web: {
            run: "npm run dev",
            autoStart: true,
            route: true,
          },
        },
      })
    }
  })

  test("rejects malformed command config", async () => {
    const root = await tempDir()
    await writeConfig(root, `export default {
      project: "tilly",
      commands: {
        web: {
          run: "",
        },
      },
    }`)

    const loaded = await loadConfig(root)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.equal(loaded.error.tag, "ConfigError")
      assert.match(loaded.error.message, /command web\.run must be a non-empty string/)
    }
  })

  test("accepts explicit local route opt-out", async () => {
    const root = await tempDir()
    await writeConfig(root, `export default {
      project: "tilly",
      commands: {
        web: {
          run: "bun run dev",
          route: false,
        },
      },
    }`)

    const loaded = await loadConfig(root)
    assert.equal(loaded.ok, true)
    if (loaded.ok) assert.equal(loaded.value.commands.web?.route, false)
  })

  test("rejects non-string workspace env", async () => {
    const root = await tempDir()
    await writeConfig(root, `export default {
      project: "tilly",
      env: { PORT: 3000 },
      commands: { web: { run: "bun run dev" } },
    }`)

    const loaded = await loadConfig(root)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) assert.match(loaded.error.message, /env\.PORT must be a string/)
  })

  test("missing config returns ConfigError", async () => {
    const root = await tempDir()
    const loaded = await loadConfig(root)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) assert.equal(loaded.error.tag, "ConfigError")
  })
})

async function writeConfig(root: string, source: string) {
  await writeFile(path.join(root, "work.config.js"), source)
}
