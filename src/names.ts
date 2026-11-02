import crypto from "node:crypto"
import { errResult, ok } from "./result.js"
import type { Result } from "./result.js"

const slugPattern = /^[a-z0-9][a-z0-9-]*$/

export function validateSlug(value: string, field: string): Result<string> {
  if (!slugPattern.test(value)) {
    return errResult("ConfigError", `${field} must match ${slugPattern}`)
  }

  return ok(value)
}

export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function routeName(project: string, workspace: string, command: string, override?: string) {
  return [override ?? command, workspace, project].join("-")
}

export function routeUrl(route: string, port: number) {
  return `https://${portlessLabel(route)}.localhost${port === 443 ? "" : `:${port}`}`
}

// Portless shortens a name longer than one DNS label the same way, so the URL names the host it serves.
export function portlessLabel(value: string) {
  if (value.length <= 63) return value

  const hash = crypto.createHash("sha256").update(value).digest("hex").slice(0, 6)
  return `${value.slice(0, 56).replace(/-+$/, "")}-${hash}`
}

export function exposureLabel(machine: string, route: string) {
  return dnsLabel(`${machine}-${route}`)
}

export function dnsLabel(value: string) {
  const label = slugify(value)
  if (label.length <= 63) return label

  const hash = crypto.createHash("sha256").update(label).digest("hex").slice(0, 8)
  return `${label.slice(0, 54).replace(/-+$/, "")}-${hash}`
}
