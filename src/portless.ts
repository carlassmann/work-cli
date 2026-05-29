import { commandExists } from "./shell.js"
import { routeName } from "./names.js"
import { errResult, ok } from "./result.js"
import type { Result } from "./result.js"
import type { CommandConfig, DevConfig, RoutingConfig } from "./types.js"

export function usesPortless(command: CommandConfig) {
  return command.portless !== false && command.route === true
}

export function portlessUrl(config: DevConfig, workspace: string, id: string, command: CommandConfig) {
  if (command.route !== true) {
    return null
  }

  const route = routeName(config.project, workspace, id, command.routeName)
  const routing = resolveRouting(config)
  return `${routing.protocol}://${route}.${routeTld(routing.target)}`
}

function routeUrls(config: DevConfig, workspace: string) {
  return Object.fromEntries(
    Object.entries(config.commands)
      .map(([id, command]) => [id, portlessUrl(config, workspace, id, command)])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
}

export function routeEnvironment(urls: Record<string, string>, routing: RoutingConfig = {}) {
  const websocketUrls = Object.fromEntries(
    Object.entries(urls).map(([id, url]) => [id, websocketUrl(url)]),
  )
  const resolved = resolveRouting({ project: "", routing: inferRouting(urls, routing), commands: {} })
  const env: Record<string, string> = {
    WORK_ROUTE_TARGET: resolved.target,
    WORK_ROUTE_PROTOCOL: resolved.protocol,
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

function inferRouting(urls: Record<string, string>, routing: RoutingConfig): RoutingConfig {
  const firstUrl = Object.values(urls)[0]
  if (!firstUrl) return routing

  const url = new URL(firstUrl)

  const inferred: RoutingConfig = {
    target: routing.target ?? (url.hostname.endsWith(".local") ? "lan" : "local"),
    protocol: routing.protocol ?? (url.protocol === "http:" ? "http" : "https"),
  }

  if (routing.ip) {
    inferred.ip = routing.ip
  }

  return inferred
}

export function routeEnvironmentForConfig(config: DevConfig, workspace: string) {
  return routeEnvironment(routeUrls(config, workspace), config.routing)
}

export function websocketUrl(url: string) {
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`
  return url
}

function envName(id: string) {
  return id.replace(/-/g, "_").toUpperCase()
}

export function withRouting(config: DevConfig, routing: RoutingConfig) {
  return {
    ...config,
    routing: {
      ...config.routing,
      ...routing,
    },
  }
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
  const routing = resolveRouting(config)
  const routingArgs = portlessRoutingArgs(routing)

  return {
    executable: "portless",
    args: [route, ...routingArgs, "sh", "-lc", command.run],
    shell: false,
    display: `portless ${[route, ...routingArgs].join(" ")} sh -lc ${JSON.stringify(command.run)}`,
  }
}

function resolveRouting(config: DevConfig): Required<RoutingConfig> {
  return {
    target: config.routing?.target ?? "local",
    protocol: config.routing?.protocol ?? "https",
    ip: config.routing?.ip ?? "",
  }
}

function routeTld(target: RoutingConfig["target"]) {
  if (target === "lan") return "local"
  return "localhost"
}

function portlessRoutingArgs(routing: Required<RoutingConfig>) {
  const args: Array<string> = []

  if (routing.target === "lan") {
    args.push("--lan")
  }

  if (routing.protocol === "http") {
    args.push("--no-tls")
  }

  if (routing.ip) {
    args.push("--ip", routing.ip)
  }

  return args
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
