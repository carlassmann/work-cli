export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export type ErrorTag =
  | "ConfigError"
  | "GitError"
  | "WorkspaceError"
  | "PortlessError"
  | "TmuxError"
  | "DaemonError"
  | "IOError"
  | "ProcessError"
  | "CLIError"
  | "ShellError"

export type AppError = {
  readonly tag: ErrorTag
  readonly message: string
  readonly cause?: unknown
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export function appError(tag: ErrorTag, message: string, cause?: unknown): AppError {
  return cause === undefined ? { tag, message } : { tag, message, cause }
}

export function errResult(tag: ErrorTag, message: string, cause?: unknown): Result<never, AppError> {
  return err(appError(tag, message, cause))
}

export function formatError(error: AppError, options: { debug?: boolean } = {}): string {
  const lines = [error.message]
  appendCause(lines, error.cause, options)
  return dedupe(lines).join("\n")
}

export async function tryAsync<T>(
  tag: ErrorTag,
  message: string,
  fn: () => Promise<T>,
): Promise<Result<T, AppError>> {
  try {
    return ok(await fn())
  } catch (cause) {
    return err(appError(tag, `${message}: ${describe(cause)}`, cause))
  }
}

export function trySync<T>(
  tag: ErrorTag,
  message: string,
  fn: () => T,
): Result<T, AppError> {
  try {
    return ok(fn())
  } catch (cause) {
    return err(appError(tag, `${message}: ${describe(cause)}`, cause))
  }
}

export function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.message
  }

  if (typeof value === "string") {
    return value
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function appendCause(lines: Array<string>, cause: unknown, options: { debug?: boolean }) {
  if (cause === undefined) return

  if (isAppError(cause)) {
    lines.push(`caused by: ${cause.message}`)
    appendCause(lines, cause.cause, options)
    return
  }

  if (cause instanceof Error) {
    lines.push(options.debug ? cause.stack ?? cause.message : `caused by: ${cause.message}`)
    appendProcessDetails(lines, cause)
    return
  }

  lines.push(`caused by: ${describe(cause)}`)
}

function appendProcessDetails(lines: Array<string>, error: Error) {
  const details = error as Error & {
    code?: unknown
    signal?: unknown
    syscall?: unknown
    path?: unknown
    stderr?: unknown
    stdout?: unknown
  }

  const context = [
    typeof details.code === "string" ? `code=${details.code}` : null,
    typeof details.signal === "string" ? `signal=${details.signal}` : null,
    typeof details.syscall === "string" ? `syscall=${details.syscall}` : null,
    typeof details.path === "string" ? `path=${details.path}` : null,
  ].filter(Boolean)

  if (context.length > 0) {
    lines.push(`details: ${context.join(" ")}`)
  }

  for (const [name, value] of [["stderr", details.stderr], ["stdout", details.stdout]] as const) {
    if (typeof value === "string" && value.trim()) {
      lines.push(`${name}: ${value.trim()}`)
    }
  }
}

function isAppError(value: unknown): value is AppError {
  return Boolean(value && typeof value === "object" && "tag" in value && "message" in value)
}

function dedupe(lines: Array<string>) {
  const result: Array<string> = []

  for (const line of lines) {
    if (!result.includes(line)) result.push(line)
  }

  return result
}

export function debugLog(scope: string, message: string) {
  if (process.env["WORK_DEBUG"]) {
    console.error(`[work:${scope}] ${message}`)
  }
}
