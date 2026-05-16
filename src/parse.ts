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
      const key = arg.slice(2)
      const spec = flagsDef[key]

      if (!spec) {
        return errResult("CLIError", `unknown flag: ${arg}`)
      }

      if (spec.type === "boolean") {
        flags[key] = true
        continue
      }

      const next = args[++i]

      if (next === undefined) {
        return errResult("CLIError", `missing value for --${key}`)
      }

      flags[key] = next
      continue
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg.slice(1)
      const full = aliases[short]

      if (!full) {
        return errResult("CLIError", `unknown flag: ${arg}`)
      }

      const spec = flagsDef[full] as FlagSpec

      if (spec.type === "boolean") {
        flags[full] = true
        continue
      }

      const next = args[++i]

      if (next === undefined) {
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
