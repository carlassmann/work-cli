const SECRET_ENVIRONMENT_VARIABLES = new Set([
  "CLOUDFLARE_API_TOKEN",
  "TUNNEL_TOKEN",
  "WORK_CLOUDFLARE_CREDENTIALS",
])

export function childEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && !SECRET_ENVIRONMENT_VARIABLES.has(entry[0])
    ),
  )
}
