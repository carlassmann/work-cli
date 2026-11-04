import { commandExists } from "./shell.js"
import { cloudflareHostname } from "./cloudflare.js"
import { tailscaleHost } from "./tailscale.js"
import { portlessLabel, routeName, routeUrl } from "./names.js"
import { portlessPort } from "./portless-proxy.js"
import type { RoutedCommand } from "./portless-proxy.js"
import { errResult, ok } from "./result.js"
import type { Result } from "./result.js"
import type { CommandConfig, DevConfig, Exposure } from "./types.js"

export function usesPortless(command: CommandConfig) {
  return command.portless !== false && command.route === true
}

// port is the Portless proxy port, which the URL carries unless it is 443.
export function portlessUrl(config: DevConfig, workspace: string, id: string, command: CommandConfig, port: number) {
  if (command.route !== true) {
    return null
  }

  return routeUrl(routeName(config.project, workspace, id, command.routeName), port)
}

export function publicUrl(config: DevConfig, workspace: string, id: string, command: CommandConfig, exposure: Exposure, port: number) {
  if (command.route !== true) return null
  if (exposure.mode === "local") return portlessUrl(config, workspace, id, command, port)

  const route = routeName(config.project, workspace, id, command.routeName)
  return `https://${exposure.mode === "tailscale" ? tailscaleHost(route, exposure) : cloudflareHostname(route, exposure)}`
}

export function routeUrlsForConfig(config: DevConfig, workspace: string, ports: Record<string, number>, exposure: Exposure = { mode: "local" }) {
  return Object.fromEntries(
    Object.entries(config.commands)
      .map(([id, command]) => [id, publicUrl(config, workspace, id, command, exposure, ports[id] ?? 443)])
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

export function routeEnvironmentForConfig(config: DevConfig, workspace: string, ports: Record<string, number>, exposure: Exposure = { mode: "local" }) {
  return routeEnvironment(routeUrlsForConfig(config, workspace, ports, exposure))
}

// Each routed command runs portless with its own env on top of the workspace env, and a
// PORTLESS_* override there can point it at another proxy. URLs and the proxy check both
// resolve endpoints here, so they always agree on the port.
export async function portlessEndpoints(environment: NodeJS.ProcessEnv, commandEnvironments: Record<string, Record<string, string> | undefined>) {
  const lookups = new Map<string, Promise<number>>()
  const endpoints: Array<RoutedCommand> = []
  for (const [id, commandEnvironment] of Object.entries(commandEnvironments)) {
    const effective = { ...environment, ...commandEnvironment }
    const key = ["PORTLESS_STATE_DIR", "PORTLESS_PORT", "HOME"].map((name) => effective[name] ?? "").join("\0")
    if (!lookups.has(key)) lookups.set(key, portlessPort(effective))
    endpoints.push({ id, port: await lookups.get(key)!, environment: effective })
  }
  return endpoints
}

export async function portlessPorts(environment: NodeJS.ProcessEnv, commandEnvironments: Record<string, Record<string, string> | undefined>) {
  return Object.fromEntries((await portlessEndpoints(environment, commandEnvironments)).map((endpoint) => [endpoint.id, endpoint.port]))
}

export function portlessPortsForConfig(config: DevConfig, environment: NodeJS.ProcessEnv) {
  const routed = Object.entries(config.commands).filter(([, command]) => command.route === true)
  return portlessPorts({ ...config.env, ...environment }, Object.fromEntries(routed.map(([id, command]) => [id, command.env])))
}

// Rebuilds a recorded *.localhost URL for the proxy port, so records from older work versions
// or from before a Portless port change get the URL Portless serves now. Other URLs stay.
export function refreshRouteUrl(url: string, port: number) {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return url
  }
  const label = hostname.endsWith(".localhost") ? hostname.slice(0, -".localhost".length) : ""
  return label && !label.includes(".") ? routeUrl(label, port) : url
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
  return usesPortless(command) ? portlessLabel(routeName(config.project, workspace, id, command.routeName)) : null
}

export function commandProcess(run: string, route: string | null, backendPort?: number) {
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
    args: [route, ...(backendPort ? ["--app-port", String(backendPort)] : []), "sh", "-lc", run],
    shell: false,
    display: `portless ${route}${backendPort ? ` --app-port ${backendPort}` : ""} sh -lc ${JSON.stringify(run)}`,
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
