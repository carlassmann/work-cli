import fs from "node:fs/promises"
import path from "node:path"
import { parseEnv } from "node:util"
import { errResult, ok } from "./result.js"
import type { Result } from "./result.js"

export function childEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] =>
      entry[1] !== undefined
      && !entry[0].startsWith("WORK_CLOUDFLARE_")
    ),
  )
}

export async function loadWorkspaceEnvironment(
  projectRoot: string,
  workspaceRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<Result<Record<string, string>>> {
  const environment: Record<string, string> = {}
  const files = [...new Set([projectRoot, workspaceRoot])].map((root) => path.join(root, ".env.local"))

  for (const file of files) {
    let contents: string
    try {
      contents = await fs.readFile(file, "utf8")
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue
      return errResult("IOError", `failed to read ${file}`, cause)
    }

    try {
      Object.assign(environment, parseEnv(contents))
    } catch (cause) {
      return errResult("ConfigError", `failed to parse ${file}`, cause)
    }
  }

  return ok({ ...environment, ...definedEnvironment(source) })
}

function definedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}
