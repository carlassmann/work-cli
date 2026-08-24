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

export function routeUrl(project: string, workspace: string, command: string, override?: string) {
  return `https://${routeName(project, workspace, command, override)}.localhost`
}

export function exposureLabel(machine: string, route: string) {
  const label = slugify(`${machine}-${route}`)
  if (label.length <= 63) return label

  const hash = crypto.createHash("sha256").update(label).digest("hex").slice(0, 8)
  return `${label.slice(0, 54).replace(/-+$/, "")}-${hash}`
}
import crypto from "node:crypto"
