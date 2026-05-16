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

export function debugLog(scope: string, message: string) {
  if (process.env["WORK_DEBUG"]) {
    console.error(`[work:${scope}] ${message}`)
  }
}
