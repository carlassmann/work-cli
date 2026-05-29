import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { validateSlug } from "./names.js"
import { errResult, ok, tryAsync } from "./result.js"
import { existsAt } from "./shell.js"
import type { Result } from "./result.js"
import type { DevConfig } from "./types.js"

const configFileName = "work.config.js"

export async function loadConfig(root: string): Promise<Result<DevConfig>> {
  const file = path.join(root, configFileName)
  const exists = await existsAt(file)

  if (!exists) {
    return errResult("ConfigError", `missing ${configFileName} in ${root}`)
  }

  const imported = await tryAsync("ConfigError", `failed to load ${configFileName}`, async () =>
    await import(`${pathToFileURL(file).href}?t=${Date.now()}`),
  )

  if (!imported.ok) return imported

  const config = imported.value.default as DevConfig
  const validated = validateConfig(config)

  if (!validated.ok) return validated

  return ok(config)
}

export async function createConfig(root: string, project: string): Promise<Result<void>> {
  const slug = validateSlug(project, "project")
  if (!slug.ok) return slug

  const file = path.join(root, configFileName)

  if (await existsAt(file)) {
    return errResult("ConfigError", `${configFileName} already exists`)
  }

  return tryAsync("IOError", `failed to write ${configFileName}`, async () => {
    await fs.writeFile(
      file,
      `export default {
  project: "${slug.value}",
  worktrees: {
    dir: "../${slug.value}.worktrees",
  },
  commands: {
    web: {
      run: "npm run dev",
      autoStart: true,
      route: true,
    },
  },
}
`,
    )
  })
}

function validateConfig(config: DevConfig): Result<void> {
  if (!config || typeof config !== "object") {
    return errResult("ConfigError", "config must export an object")
  }

  const project = validateSlug(config.project, "project")
  if (!project.ok) return project

  const worktrees = validateWorktrees(config)
  if (!worktrees.ok) return worktrees

  const routing = validateRouting(config)
  if (!routing.ok) return routing

  if (!config.commands || typeof config.commands !== "object" || Array.isArray(config.commands)) {
    return errResult("ConfigError", "commands must be an object")
  }

  for (const [id, command] of Object.entries(config.commands)) {
    const result = validateCommand(id, command)
    if (!result.ok) return result
  }

  return ok(undefined)
}

function validateWorktrees(config: DevConfig): Result<void> {
  if (!config.worktrees) {
    return ok(undefined)
  }

  if (typeof config.worktrees !== "object" || Array.isArray(config.worktrees)) {
    return errResult("ConfigError", "worktrees must be an object")
  }

  if (config.worktrees.dir && typeof config.worktrees.dir !== "string") {
    return errResult("ConfigError", "worktrees.dir must be a string")
  }

  if (config.worktrees.setup && typeof config.worktrees.setup !== "string") {
    return errResult("ConfigError", "worktrees.setup must be a string")
  }

  return ok(undefined)
}

function validateRouting(config: DevConfig): Result<void> {
  if (!config.routing) {
    return ok(undefined)
  }

  if (typeof config.routing !== "object" || Array.isArray(config.routing)) {
    return errResult("ConfigError", "routing must be an object")
  }

  if (config.routing.target !== undefined && config.routing.target !== "local" && config.routing.target !== "lan") {
    return errResult("ConfigError", `routing.target must be "local" or "lan"`)
  }

  if (config.routing.protocol !== undefined && config.routing.protocol !== "https" && config.routing.protocol !== "http") {
    return errResult("ConfigError", `routing.protocol must be "https" or "http"`)
  }

  if (config.routing.ip !== undefined && typeof config.routing.ip !== "string") {
    return errResult("ConfigError", "routing.ip must be a string")
  }

  if (config.routing.ip && config.routing.target !== "lan") {
    return errResult("ConfigError", `routing.ip requires routing.target: "lan"`)
  }

  return ok(undefined)
}

function validateCommand(id: string, command: DevConfig["commands"][string]): Result<void> {
  const idResult = validateSlug(id, `command ${id}`)
  if (!idResult.ok) return idResult

  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return errResult("ConfigError", `command ${id} must be an object`)
  }

  if (typeof command.run !== "string" || command.run.length === 0) {
    return errResult("ConfigError", `command ${id}.run must be a non-empty string`)
  }

  if (command.cwd && typeof command.cwd !== "string") {
    return errResult("ConfigError", `command ${id}.cwd must be a string`)
  }

  if (command.env && (typeof command.env !== "object" || Array.isArray(command.env))) {
    return errResult("ConfigError", `command ${id}.env must be an object`)
  }

  for (const [key, value] of Object.entries(command.env ?? {})) {
    if (typeof value !== "string") {
      return errResult("ConfigError", `command ${id}.env.${key} must be a string`)
    }
  }

  if (command.autoStart !== undefined && typeof command.autoStart !== "boolean") {
    return errResult("ConfigError", `command ${id}.autoStart must be a boolean`)
  }

  if (command.restart !== undefined && command.restart !== "manual" && command.restart !== "on-exit") {
    return errResult("ConfigError", `command ${id}.restart must be "manual" or "on-exit"`)
  }

  if (command.restartWhenChanged && !Array.isArray(command.restartWhenChanged)) {
    return errResult("ConfigError", `command ${id}.restartWhenChanged must be an array`)
  }

  if (command.restartWhenChanged?.some((pattern) => typeof pattern !== "string")) {
    return errResult("ConfigError", `command ${id}.restartWhenChanged entries must be strings`)
  }

  if (command.route !== undefined && typeof command.route !== "boolean") {
    return errResult("ConfigError", `command ${id}.route must be a boolean`)
  }

  if (command.routeName !== undefined) {
    if (typeof command.routeName !== "string") {
      return errResult("ConfigError", `command ${id}.routeName must be a string`)
    }

    const slug = validateSlug(command.routeName, `command ${id}.routeName`)
    if (!slug.ok) return slug
  }

  if (command.portless !== undefined && typeof command.portless !== "boolean") {
    return errResult("ConfigError", `command ${id}.portless must be a boolean`)
  }

  return ok(undefined)
}
