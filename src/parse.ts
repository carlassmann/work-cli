import { errResult, ok } from "./result.js"
import type { Result } from "./result.js"

type BooleanFlag = { readonly type: "boolean"; readonly alias?: string }
type ValueFlag = { readonly type: "value"; readonly alias?: string }
type FlagSpec = BooleanFlag | ValueFlag

export type FlagDef = Readonly<Record<string, FlagSpec>>

type FlagValues<D extends FlagDef> = {
  [K in keyof D]: D[K] extends BooleanFlag ? boolean : string | undefined
}

export type ParseOptions<D extends FlagDef> = {
  readonly flags?: D
  readonly acceptRest?: boolean
}

export type ParseResult<D extends FlagDef> = {
  readonly positional: ReadonlyArray<string>
  readonly flags: FlagValues<D>
  readonly rest: ReadonlyArray<string> | null
}

export function parseArgs<D extends FlagDef>(
  args: ReadonlyArray<string>,
  options: ParseOptions<D> = {},
): Result<ParseResult<D>> {
  const flagsDef = options.flags ?? ({} as D)
  const acceptRest = options.acceptRest ?? false

  const aliases: Record<string, string> = {}
  for (const [name, spec] of Object.entries(flagsDef)) {
    if (spec.alias) {
      aliases[spec.alias] = name
    }
  }

  const positional: Array<string> = []
  const flags: Record<string, string | boolean> = {}
  for (const [name, spec] of Object.entries(flagsDef)) {
    if (spec.type === "boolean") {
      flags[name] = false
    }
  }

  let rest: Array<string> | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string

    if (arg === "--") {
      if (acceptRest) {
        rest = args.slice(i + 1) as Array<string>
      } else {
        for (let j = i + 1; j < args.length; j++) {
          positional.push(args[j] as string)
        }
      }
      break
    }

    if (arg.startsWith("--")) {
      const long = arg.slice(2)
      const equals = long.indexOf("=")
      const key = equals === -1 ? long : long.slice(0, equals)
      const inlineValue = equals === -1 ? undefined : long.slice(equals + 1)
      const spec = flagsDef[key]

      if (!spec) {
        return errResult("CLIError", withSuggestion(`unknown flag: ${arg}`, key, Object.keys(flagsDef).map((name) => `--${name}`)))
      }

      if (spec.type === "boolean") {
        if (inlineValue !== undefined) {
          return errResult("CLIError", `flag --${key} does not take a value`)
        }

        flags[key] = true
        continue
      }

      const next = inlineValue ?? args[++i]

      if (next === undefined || next === "") {
        return errResult("CLIError", `missing value for --${key}`)
      }

      if (inlineValue === undefined && next.startsWith("-")) {
        return errResult("CLIError", `missing value for --${key}`)
      }

      flags[key] = next
      continue
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg.slice(1)
      if (short.length > 1) {
        const combined = parseCombinedShortFlags(short, aliases, flagsDef)
        if (!combined.ok) return combined

        if (combined.value) {
          for (const full of combined.value) flags[full] = true
          continue
        }
      }

      const full = aliases[short]

      if (!full) {
        return errResult("CLIError", withSuggestion(`unknown flag: ${arg}`, short, Object.keys(aliases).map((alias) => `-${alias}`)))
      }

      const spec = flagsDef[full] as FlagSpec

      if (spec.type === "boolean") {
        flags[full] = true
        continue
      }

      const next = args[++i]

      if (next === undefined || next === "") {
        return errResult("CLIError", `missing value for -${short}`)
      }

      if (next.startsWith("-")) {
        return errResult("CLIError", `missing value for -${short}`)
      }

      flags[full] = next
      continue
    }

    positional.push(arg)
  }

  return ok({
    positional,
    flags: flags as FlagValues<D>,
    rest,
  })
}

export const booleanFlag = (alias?: string): BooleanFlag => alias ? { type: "boolean", alias } : { type: "boolean" }
export const valueFlag = (alias?: string): ValueFlag => alias ? { type: "value", alias } : { type: "value" }

function parseCombinedShortFlags(short: string, aliases: Record<string, string>, flagsDef: FlagDef): Result<Array<string> | null> {
  const names: Array<string> = []

  for (const char of short) {
    const full = aliases[char]
    if (!full) return ok(null)

    const spec = flagsDef[full]
    if (spec?.type !== "boolean") return ok(null)

    names.push(full)
  }

  return ok(names)
}

function withSuggestion(message: string, input: string, candidates: Array<string>) {
  const suggestion = closest(input, candidates)
  return suggestion ? `${message}. Did you mean ${suggestion}?` : message
}

function closest(input: string, candidates: Array<string>) {
  let best: { value: string; distance: number } | null = null

  for (const candidate of candidates) {
    const distance = levenshtein(input, candidate.replace(/^-+/, ""))
    if (!best || distance < best.distance) best = { value: candidate, distance }
  }

  return best && best.distance <= 2 ? best.value : null
}

function levenshtein(a: string, b: string) {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)

  for (let i = 1; i <= a.length; i++) {
    const current = [i]

    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }

    previous.splice(0, previous.length, ...current)
  }

  return previous[b.length] as number
}
