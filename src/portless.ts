import { commandExists } from "./shell.js"
import { routeName, routeUrl } from "./names.js"
import { errResult, ok } from "./result.js"
import type { Result } from "./result.js"
import type { CommandConfig, DevConfig } from "./types.js"

export function usesPortless(command: CommandConfig) {
  return command.portless !== false && command.route === true
}

export function portlessUrl(config: DevConfig, workspace: string, id: string, command: CommandConfig) {
  if (command.route !== true) {
    return null
  }

  return routeUrl(config.project, workspace, id, command.routeName)
}

export function spawnCommand(config: DevConfig, workspace: string, id: string, command: CommandConfig) {
  if (!usesPortless(command)) {
    return {
      executable: command.run,
      args: [],
      shell: true,
      display: command.run,
    }
  }

  const route = routeName(config.project, workspace, id, command.routeName)

  return {
    executable: "portless",
    args: [route, "sh", "-lc", command.run],
    shell: false,
    display: `portless ${route} sh -lc ${JSON.stringify(command.run)}`,
  }
}

export async function ensurePortless(commands: Record<string, CommandConfig>): Promise<Result<void>> {
  if (!Object.values(commands).some(usesPortless)) {
    return ok(undefined)
  }

  if (await commandExists("portless")) {
    return ok(undefined)
  }

  return errResult("PortlessError", "portless is required for routed commands. Install it and make sure `portless` is on PATH.")
}
