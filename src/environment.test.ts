import path from "node:path"
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { loadWorkspaceEnvironment } from "./environment.js"
import { tempDir, writeFile } from "./test-helpers.js"

describe("workspace environment", () => {
  test("layers project, workspace, and invoking shell values", async () => {
    const projectRoot = await tempDir()
    const workspaceRoot = await tempDir()

    await writeFile(path.join(projectRoot, ".env.local"), "PROJECT_ONLY=project\nFILE_SHARED=project\nSHARED=project\n")
    await writeFile(path.join(workspaceRoot, ".env.local"), "WORKSPACE_ONLY=workspace\nFILE_SHARED=workspace\nSHARED=workspace\n")

    const loaded = await loadWorkspaceEnvironment(projectRoot, workspaceRoot, {
      SHELL_ONLY: "shell",
      SHARED: "shell",
    })

    assert.deepEqual(loaded, {
      ok: true,
      value: {
        PROJECT_ONLY: "project",
        WORKSPACE_ONLY: "workspace",
        FILE_SHARED: "workspace",
        SHELL_ONLY: "shell",
        SHARED: "shell",
      },
    })
  })
})
