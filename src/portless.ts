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

function routeUrls(config: DevConfig, workspace: string) {
  return Object.fromEntries(
    Object.entries(config.commands)
      .map(([id, command]) => [id, portlessUrl(config, workspace, id, command)])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
}

export function routeEnvironment(urls: Record<string, string>) {
  const websocketUrls = Object.fromEntries(
    Object.entries(urls).map(([id, url]) => [id, websocketUrl(url)]),
  )
  const env: Record<string, string> = {
    WORK_URL: urls.web ?? "",
    WORK_WEB_URL: urls.web ?? "",
    WORK_WEB_WS_URL: websocketUrls.web ?? "",
    WORK_URLS: JSON.stringify(urls),
    WORK_WS_URLS: JSON.stringify(websocketUrls),
  }

  for (const [id, url] of Object.entries(urls)) {
    const name = envName(id)
    env[`WORK_${name}_URL`] = url
    env[`WORK_${name}_WS_URL`] = websocketUrls[id] ?? ""
  }

  return env
}

export function routeEnvironmentForConfig(config: DevConfig, workspace: string) {
  return routeEnvironment(routeUrls(config, workspace))
}

export function websocketUrl(url: string) {
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`
  return url
}

function envName(id: string) {
  return id.replace(/-/g, "_").toUpperCase()
}

export function commandRoute(config: DevConfig, workspace: string, id: string, command: CommandConfig) {
  return usesPortless(command) ? routeName(config.project, workspace, id, command.routeName) : null
}

export function commandProcess(run: string, route: string | null) {
  if (!route) {
    return {
      executable: run,
      args: [],
      shell: true,
      display: run,
    }
  }

  return {
    executable: "portless",
    args: [route, "sh", "-lc", run],
    shell: false,
    display: `portless ${route} sh -lc ${JSON.stringify(run)}`,
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
