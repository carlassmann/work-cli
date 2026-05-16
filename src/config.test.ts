import path from "node:path"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { createConfig, loadConfig } from "./config.js"
import { tempDir, writeFile } from "./test-helpers.js"

describe("config", () => {
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
