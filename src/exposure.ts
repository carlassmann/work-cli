import { syncCloudflareTunnel } from "./cloudflare.js"
import { ok } from "./result.js"
import { syncTailnetProxy } from "./tailscale.js"
import type { Result } from "./result.js"

// Brings the machine-wide connectors in line with the tracked commands.
// Each one stops itself when no command uses its mode.
export async function syncExposures(environment: NodeJS.ProcessEnv = process.env): Promise<Result<void>> {
  const cloudflare = await syncCloudflareTunnel(environment)
  const tailscale = await syncTailnetProxy(environment)
  if (!cloudflare.ok) return cloudflare
  return tailscale.ok ? ok(undefined) : tailscale
}
