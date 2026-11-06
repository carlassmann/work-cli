#!/usr/bin/env node
import path from "node:path"
import readline from "node:readline/promises"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { Writable } from "node:stream"
import { stdin as input, stdout as output } from "node:process"
import { cloudflareExposure } from "./cloudflare.js"
import { tailscaleExposure } from "./tailscale.js"
import { runTailscaleSetup, tailscaleDoctorLine } from "./tailscale-setup.js"
import { buildCommit, buildDirty } from "./build-info.js"
import { commandNames } from "./commands.js"
import { complete, completionScript, shellInitScript } from "./completions.js"
import { createConfig, loadConfig } from "./config.js"
import { createWorktree, describeBranchSource, gitBranch, gitMainWorktree, gitRoot, resolveBranchSource, workspaceFromGit } from "./git.js"
import { slugify, validateSlug } from "./names.js"
import { commandRuntimeStatus, startupExits } from "./processes.js"
import type { StartupExit } from "./processes.js"
import { waitForLog, waitForUrl } from "./readiness.js"
import { MAX_TAIL_BYTES, currentRunOffset, forEachLogChunk, readLastLines } from "./logs.js"
import { commandLogFile, listWorkspaceStates, readWorkspaceState } from "./state.js"
import { docsText, docsTopics } from "./docs.js"
import { commandHelp, helpSection, rootHelp } from "./help.js"
import { booleanFlag, parseArgs, splitWorkspaceCommands, valueFlag } from "./parse.js"
import type { WorkspaceCommands } from "./parse.js"
import { ensurePortless, portlessEndpoints, portlessPortsForConfig, routeEnvironmentForConfig, usesPortless } from "./portless.js"
import { ensurePortlessProxy, portlessProxyRemedy, probePortless, proxyRemedyHint } from "./portless-proxy.js"
import type { RoutedCommand } from "./portless-proxy.js"
import { childEnvironment, loadWorkspaceEnvironment } from "./environment.js"
import { commandExists, existsAt } from "./shell.js"
import { callDaemon, daemonStatus, ensureDaemon, stopDaemon } from "./daemon-client.js"
import type { DaemonStatus } from "./daemon-client.js"
import { processUnit, sessionScope } from "./systemd.js"
import { debugLog, errResult, formatError, ok } from "./result.js"
import { formatUpdateStatus, readUpdateStatus } from "./updates.js"
import type { Result } from "./result.js"
import type { CommandName } from "./commands.js"
import type { CommandRecord, DevConfig, Exposure, StartResult, WorkspaceRecord, WorkspaceState } from "./types.js"

type WorkspaceResolution = WorkspaceRecord & {
  created: boolean
  createdFrom?: string
}

type ProjectContext = {
  root: string
  cwdRoot: string
  config: DevConfig
}

type StateFilters = {
  project?: string | undefined
  workspace?: string | undefined
}

const result = await main(process.argv.slice(2))

if (!result.ok) {
  console.error(formatError(result.error, { debug: Boolean(process.env["WORK_DEBUG"]) }))

  if (process.env["WORK_DEBUG"]) {
    console.error(`[tag: ${result.error.tag}]`)
  }

  process.exitCode = 1
}

async function main(args: ReadonlyArray<string>): Promise<Result<void>> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(rootHelp())
    return ok(undefined)
  }

  if (args[0] === "--version" || args[0] === "-v") {
    const { version } = createRequire(import.meta.url)("../package.json") as { version: string }
    console.log(`work ${version}${buildCommit ? ` (${buildCommit.slice(0, 7)}${buildDirty ? "-dirty" : ""})` : " (commit unknown)"}`)
    return ok(undefined)
  }

  if (args[0] === "help") {
    const topic = args[1] ?? ""
    if (topic === "--help" || topic === "-h") {
      console.log(commandHelp("help"))
      return ok(undefined)
    }

    if (args[2]) {
      return errResult("CLIError", `unexpected argument: ${args[2]}`)
    }

    const help = commandHelp(topic)
    if (topic && help === rootHelp()) {
      const docs = docsText(topic)
      if (docs.ok) {
        console.log(docs.value)
        return ok(undefined)
      }

      return errResult("CLIError", `${withSuggestion(`unknown help topic: ${topic}`, topic, [...commandNames, ...docsTopics])} Run 'work --help'.`)
    }

    console.log(help)
    return ok(undefined)
  }

  const name = args[0]
  if (!name) {
    console.log(rootHelp())
    return ok(undefined)
  }

  const rest = args.slice(1)

  if (hasHelpFlag(rest)) {
    if (!helpSection(name)) {
      return errResult("CLIError", `${withSuggestion(`unknown command: ${name}`, name, [...commandNames])} Run 'work --help'.`)
    }

    console.log(commandHelp(name))
    return ok(undefined)
  }

  return dispatch(name, rest)
}

type CommandHandler = (args: ReadonlyArray<string>) => Promise<Result<void>>

function commandHandlers(): Record<Exclude<CommandName, "help">, CommandHandler> {
  return {
    init: runInit,
    create: runCreate,
    up: runUp,
    setup: runSetup,
    down: runDown,
    run: runRun,
    restart: runRestart,
    ps: runPs,
    status: runPs,
    watch: runWatch,
    logs: runLogs,
    urls: runUrls,
    stop: runStop,
    wait: runWait,
    tailscale: runTailscale,
    doctor: runDoctor,
    prune: runPrune,
    daemon: runDaemon,
    updates: runUpdates,
    docs: runDocs,
    completions: runCompletions,
    "shell-init": runShellInit,
    cd: runCd,
  }
}

async function dispatch(name: string, args: ReadonlyArray<string>): Promise<Result<void>> {
  if (name === "_complete") {
    return runComplete(args)
  }

  const handler = (commandHandlers() as Record<string, CommandHandler>)[name]

  if (!handler) {
    return errResult("CLIError", `${withSuggestion(`unknown command: ${name}`, name, [...commandNames])} Run 'work --help'.`)
  }

  return handler(args)
}

function hasHelpFlag(args: ReadonlyArray<string>) {
  const restIndex = args.indexOf("--")
  const parsedArgs = restIndex === -1 ? args : args.slice(0, restIndex)
  return parsedArgs.includes("--help") || parsedArgs.includes("-h")
}

async function runInit(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args)
  if (!parsed.ok) return parsed

  const projectArg = parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra
  const rootResult = await gitRoot(process.cwd())
  const root = rootResult.ok ? rootResult.value : process.cwd()
  const slug = projectArg ? slugify(projectArg) : slugify(path.basename(root))

  const created = await createConfig(root, slug)
  if (!created.ok) return created

  console.log(`created work.config.js for ${slug}`)

  if (!rootResult.ok) {
    console.error("warning: not in a git repository. work commands beyond `init` require git.")
  }

  return ok(undefined)
}

async function runCreate(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, {
    flags: { remote: valueFlag() },
  })
  if (!parsed.ok) return parsed

  const workspaceName = parsed.value.positional[0]
  if (!workspaceName) {
    return errResult("CLIError", "missing workspace. Usage: work create <workspace> [--remote <name>]")
  }
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra

  const ctx = await loadProjectContext()
  if (!ctx.ok) return ctx

  const workspace = await resolveWorkspace(ctx.value, workspaceName, { create: true, noCreate: false, remote: parsed.value.flags.remote })
  if (!workspace.ok) return workspace

  if (workspace.value.root === ctx.value.cwdRoot) {
    return errResult("WorkspaceError", `workspace ${workspace.value.workspace} is the current worktree`)
  }

  const suffix = workspace.value.created ? ` from ${workspace.value.createdFrom}` : ""
  console.log(`${workspace.value.created ? "created" : "exists"} ${workspace.value.workspace}${suffix}\t${workspace.value.root}`)
  return ok(undefined)
}

async function runUp(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, {
    flags: { create: booleanFlag(), "no-create": booleanFlag(), remote: valueFlag(), cloudflare: booleanFlag(), tailscale: booleanFlag() },
  })
  if (!parsed.ok) return parsed

  const workspaceName = parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra
  const create = parsed.value.flags.create
  const noCreate = parsed.value.flags["no-create"]
  const remote = parsed.value.flags.remote
  if (create && noCreate) {
    return errResult("CLIError", "work up accepts only one of --create or --no-create")
  }
  if (remote && noCreate) {
    return errResult("CLIError", "work up --remote conflicts with --no-create")
  }

  const ctx = await loadProjectContext()
  if (!ctx.ok) return ctx

  const workspace = await resolveWorkspace(ctx.value, workspaceName, { create, noCreate, remote })
  if (!workspace.ok) return workspace

  let environment = await loadWorkspaceEnvironment(ctx.value.root, workspace.value.root)
  if (!environment.ok) return environment

  const commands = Object.entries(ctx.value.config.commands).filter(([, command]) => command.autoStart)
  let exposure = await resolveExposure(parsed.value.flags, environment.value, ctx.value.config.project, workspace.value.workspace)
  if (!exposure.ok) return exposure

  if (workspace.value.created) {
    console.log(`created ${workspace.value.workspace} from ${workspace.value.createdFrom}`)
    const setup = await runWorkspaceSetup(ctx.value.config, ctx.value.root, workspace.value, exposure.value, environment.value)
    if (!setup.ok) return setup
    environment = await loadWorkspaceEnvironment(ctx.value.root, workspace.value.root)
    if (!environment.ok) return environment
    exposure = await resolveExposure(parsed.value.flags, environment.value, ctx.value.config.project, workspace.value.workspace)
    if (!exposure.ok) return exposure
  }

  if (commands.length === 0) {
    console.log(`no autoStart commands in work.config.js for ${ctx.value.config.project}`)
    return ok(undefined)
  }

  return startConfigured(ctx.value, workspace.value, commands, "run", exposure.value, environment.value)
}

async function runSetup(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: { cloudflare: booleanFlag(), tailscale: booleanFlag() } })
  if (!parsed.ok) return parsed

  const workspaceName = parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra
  const ctx = await loadProjectContext()
  if (!ctx.ok) return ctx

  const workspace = await resolveWorkspace(ctx.value, workspaceName, { create: false, noCreate: true })
  if (!workspace.ok) return workspace

  const environment = await loadWorkspaceEnvironment(ctx.value.root, workspace.value.root)
  if (!environment.ok) return environment
  const exposure = await resolveExposure(parsed.value.flags, environment.value, ctx.value.config.project, workspace.value.workspace)
  if (!exposure.ok) return exposure

  return runWorkspaceSetup(ctx.value.config, ctx.value.root, workspace.value, exposure.value, environment.value)
}

async function runDown(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, {
    flags: { all: booleanFlag("a"), project: valueFlag("p") },
  })
  if (!parsed.ok) return parsed

  const workspaceArg = parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra
  if (parsed.value.flags.all && workspaceArg) {
    return errResult("CLIError", "work down --all accepts no workspace argument")
  }
  const ctx = await loadProjectContext()
  if (!ctx.ok || parsed.value.flags.all || parsed.value.flags.project) {
    if (!workspaceArg && !parsed.value.flags.all) {
      return errResult("CLIError", "missing workspace outside a work project. Usage: work down [workspace] | work down --all")
    }

    const states = await findWorkspaceStates({
      project: parsed.value.flags.project ?? (ctx.ok ? ctx.value.config.project : undefined),
      workspace: workspaceArg,
    })
    if (!states.ok) return states

    return downStates(states.value)
  }

  const workspace = workspaceArg ? slugify(workspaceArg) : await defaultWorkspace(ctx.value.cwdRoot)
  return downStates([{ project: ctx.value.config.project, workspace }])
}

async function downStates(states: Array<Pick<WorkspaceState, "project" | "workspace">>): Promise<Result<void>> {
  if (states.length === 0) {
    console.log("no tracked commands")
    return ok(undefined)
  }

  let count = 0

  for (const state of states) {
    const response = await callDaemon({ type: "down", project: state.project, workspace: state.workspace, environment: childEnvironment() })
    if (!response.ok) return response

    for (const id of response.value.data) {
      count++
      console.log(`stopped ${state.project}/${state.workspace}/${id}`)
    }
  }

  if (count === 0) {
    console.log("no tracked commands")
  }

  return ok(undefined)
}

async function runRun(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: { workspace: valueFlag("w"), cloudflare: booleanFlag(), tailscale: booleanFlag() } })
  if (!parsed.ok) return parsed

  const parsedTarget = workspaceCommandArgs(parsed.value.positional, parsed.value.flags.workspace)
  if (!parsedTarget.ok) return parsedTarget
  const command = parsedTarget.value.command
  if (!command) {
    return errResult("CLIError", "missing command. Usage: work run [workspace] <command> | work run -w workspace <command>")
  }

  const ctx = await loadProjectContext()
  if (!ctx.ok) return ctx

  const commandConfig = ctx.value.config.commands[command]
  if (!commandConfig) {
    return errResult("CLIError", withSuggestion(`unknown command: ${command}`, command, Object.keys(ctx.value.config.commands)))
  }

  const workspace = await resolveWorkspace(ctx.value, parsedTarget.value.workspace, { create: false, noCreate: true, usage: "work run [-w workspace] <command>" })
  if (!workspace.ok) return workspace

  const environment = await loadWorkspaceEnvironment(ctx.value.root, workspace.value.root)
  if (!environment.ok) return environment
  const exposure = await resolveExposure(parsed.value.flags, environment.value, ctx.value.config.project, workspace.value.workspace)
  if (!exposure.ok) return exposure

  return startConfigured(ctx.value, workspace.value, [[command, commandConfig]], "run", exposure.value, environment.value)
}

const restartUsage = "work restart [workspace] <command>... | work restart -w workspace <command>... | work restart --all"

async function runRestart(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, {
    flags: { all: booleanFlag("a"), project: valueFlag("p"), workspace: valueFlag("w"), cloudflare: booleanFlag(), tailscale: booleanFlag() },
  })
  if (!parsed.ok) return parsed

  const all = parsed.value.flags.all
  const projectArg = parsed.value.flags.project
  const positional = parsed.value.positional
  const ctx = await loadProjectContext()
  if (!ctx.ok || projectArg) {
    if (parsed.value.flags.tailscale) {
      return errResult("CLIError", "--tailscale needs the project config; tracked restarts keep their routing mode")
    }

    const target = await trackedWorkspaceCommands(positional, parsed.value.flags)
    if (!target.ok) return target
    if (all) {
      if (target.value.commands.length > 0) {
        return errResult("CLIError", "work restart --all accepts no command argument")
      }
      const states = await findWorkspaceStates({ project: projectArg, workspace: target.value.workspace })
      if (!states.ok) return states
      return restartTrackedStates(states.value)
    }

    if (target.value.commands.length === 0) {
      return errResult("CLIError", `missing command. Usage: ${restartUsage}`)
    }

    const resolved = await resolveTrackedCommands(target.value, projectArg)
    if (!resolved.ok) return resolved
    return restartTrackedTargets(resolved.value)
  }

  const target = await projectWorkspaceCommands(ctx.value, positional, parsed.value.flags.workspace, Object.keys(ctx.value.config.commands))
  if (all && target.commands.length > 0) {
    return errResult("CLIError", "work restart --all accepts no command argument")
  }

  const workspace = await resolveWorkspace(ctx.value, target.workspace, { create: false, noCreate: true, usage: "work restart [-w workspace] <command>..." })
  if (!workspace.ok) return workspace
  const environment = await loadWorkspaceEnvironment(ctx.value.root, workspace.value.root)
  if (!environment.ok) return environment
  const exposure = await resolveExposure(parsed.value.flags, environment.value, ctx.value.config.project, workspace.value.workspace)
  if (!exposure.ok) return exposure

  if (all) {
    const autoStart = Object.entries(ctx.value.config.commands).filter(([, command]) => command.autoStart)

    if (autoStart.length === 0) {
      console.log(`no autoStart commands in work.config.js for ${ctx.value.config.project}`)
      return ok(undefined)
    }

    return startConfigured(ctx.value, workspace.value, autoStart, "restart", exposure.value, environment.value)
  }

  if (target.commands.length === 0) {
    return errResult("CLIError", `missing command. Usage: ${restartUsage}`)
  }

  const entries: Array<[string, DevConfig["commands"][string]]> = []
  for (const command of target.commands) {
    const commandConfig = ctx.value.config.commands[command]
    if (!commandConfig) {
      return errResult("CLIError", await unknownTrackedCommandMessage(ctx.value.config.project, workspace.value.workspace, command, Object.keys(ctx.value.config.commands)))
    }
    entries.push([command, commandConfig])
  }

  return startConfigured(ctx.value, workspace.value, entries, "restart", exposure.value, environment.value)
}

async function startConfigured(
  ctx: ProjectContext,
  workspace: WorkspaceRecord,
  entries: Array<[string, DevConfig["commands"][string]]>,
  type: "run" | "restart",
  exposure: Exposure,
  environment: NodeJS.ProcessEnv,
): Promise<Result<void>> {
  const portless = await ensurePortless(Object.fromEntries(entries))
  if (!portless.ok) return portless
  const routed = entries.filter(([, command]) => usesPortless(command))
  const proxy = await ensurePortlessProxy(await portlessEndpoints({ ...ctx.config.env, ...environment }, Object.fromEntries(routed.map(([id, command]) => [id, command.env]))))
  if (!proxy.ok) return proxy

  const starts: Array<ProcessStart> = []
  for (const [id] of entries) {
    const response = await callDaemon({
      type,
      config: ctx.config,
      workspace,
      command: id,
      exposure,
      environment: childEnvironment(),
    })
    if (!response.ok) return reportStarts(starts, response)
    starts.push({
      label: id,
      target: { project: ctx.config.project, workspace: workspace.workspace, command: id },
      result: response.value.data,
      verb: type === "restart" ? "restarted" : undefined,
    })
  }

  return reportStarts(starts)
}

type TrackedTarget = { project: string; workspace: string; command: string }

async function restartTrackedStates(states: Array<WorkspaceState>): Promise<Result<void>> {
  const targets = states.flatMap((state) =>
    Object.keys(state.commands).map((command) => ({ project: state.project, workspace: state.workspace, command })),
  )

  if (targets.length === 0) {
    console.log("no tracked commands")
    return ok(undefined)
  }

  return restartTrackedTargets(targets)
}

// Checks the proxy for the whole batch before restarting anything, so a stopped proxy
// leaves every command as it was. Early exits are then watched once for the whole batch.
async function restartTrackedTargets(targets: Array<TrackedTarget>): Promise<Result<void>> {
  const proxy = await ensureTrackedPortlessProxy(targets)
  if (!proxy.ok) return proxy

  const starts: Array<ProcessStart> = []
  for (const target of targets) {
    const response = await callDaemon({
      type: "restartTracked",
      ...target,
      environment: childEnvironment(),
    })
    if (!response.ok) return reportStarts(starts, response)
    starts.push({ label: `${target.project}/${target.workspace}/${target.command}`, target, result: response.value.data, verb: "restarted" })
  }

  return reportStarts(starts)
}

async function ensureTrackedPortlessProxy(targets: Array<TrackedTarget>): Promise<Result<void>> {
  const workspaces = new Map<string, Array<TrackedTarget>>()
  for (const target of targets) {
    const key = `${target.project}/${target.workspace}`
    workspaces.set(key, [...workspaces.get(key) ?? [], target])
  }

  const routed: Array<RoutedCommand> = []
  for (const group of workspaces.values()) {
    const { project, workspace } = group[0]!
    const state = await readWorkspaceState(project, workspace)
    if (!state.ok) return state
    const current = state.value
    if (!current) continue
    const records = group.map((target) => current.commands[target.command]).filter((record): record is CommandRecord => Boolean(record?.route))
    if (records.length === 0) continue
    const environment = await loadWorkspaceEnvironment(current.sourceRoot ?? current.root, current.root)
    if (!environment.ok) return environment
    const endpoints = await portlessEndpoints({ ...current.env, ...environment.value }, Object.fromEntries(records.map((record) => [record.id, record.env])))
    routed.push(...endpoints.map((endpoint) => ({ ...endpoint, id: `${project}/${workspace}/${endpoint.id}` })))
  }

  return ensurePortlessProxy(routed)
}

type ProcessStart = { label: string; target: TrackedTarget; result: StartResult; verb?: string | undefined }

async function reportStarts(starts: Array<ProcessStart>, failure: Result<unknown> = ok(undefined)): Promise<Result<void>> {
  const exits = await startupExits(starts.map((start) => start.result))
  const failed: Array<ProcessStart> = []

  for (const start of starts) {
    const exit = exits.get(start.result.record.pid)
    if (!exit) {
      printProcessStart(start.label, start.result, start.verb)
      continue
    }
    printStartupExit(start.label, start.result.record.pid, exit)
    if (exit.code !== 0) failed.push(start)
  }

  if (!failure.ok) return failure
  if (failed.length === 0) return ok(undefined)
  return errResult("ProcessError", failed.map(({ label, target }) =>
    `${label} exited right after starting. Logs: work logs -p ${target.project} -w ${target.workspace} ${target.command}`).join("\n"))
}

async function runPs(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: { all: booleanFlag("a"), workspace: valueFlag("w"), json: booleanFlag() } })
  if (!parsed.ok) return parsed

  const workspace = parsed.value.flags.workspace ?? parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, parsed.value.flags.workspace ? 0 : 1)
  if (extra) return extra
  if (parsed.value.flags.all && workspace) {
    return errResult("CLIError", "work ps --all accepts no workspace argument")
  }

  const table = await trackedCommandTable(parsed.value.flags.all, parsed.value.flags.json, workspace)
  if (!table.ok) return table

  console.log(table.value)
  return ok(undefined)
}

async function runWatch(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: { all: booleanFlag("a"), interval: valueFlag("n") } })
  if (!parsed.ok) return parsed
  if (parsed.value.positional.length > 0) {
    return errResult("CLIError", `unexpected argument: ${parsed.value.positional[0]}`)
  }

  const intervalRaw = parsed.value.flags.interval
  const intervalSec = intervalRaw === undefined ? 2 : Number(intervalRaw)
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    return errResult("CLIError", `invalid interval: ${intervalRaw}`)
  }

  const all = parsed.value.flags.all
  let stopped = false
  const stop = () => { stopped = true }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  process.on("SIGHUP", stop)

  try {
    while (!stopped) {
      const table = await trackedCommandTable(all)
      if (!table.ok) return table

      const header = `work watch${all ? " -a" : ""}  every ${intervalSec}s  (ctrl-c to exit)`
      process.stdout.write(`\x1b[H\x1b[2J\x1b[3J${header}\n\n${table.value}\n`)

      await interruptibleSleep(intervalSec * 1000, () => stopped)
    }
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    process.off("SIGHUP", stop)
  }

  return ok(undefined)
}

async function trackedCommandTable(all: boolean, json = false, workspace?: string): Promise<Result<string>> {
  const scope = all ? ok({ states: await listWorkspaceStates(), empty: "no tracked commands" }) : await workspaceScope(workspace)
  if (!scope.ok) return scope

  const records = []
  for (const state of scope.value.states) {
    for (const command of Object.values(state.commands)) {
      records.push({
        project: state.project,
        workspace: state.workspace,
        command: command.id,
        status: await commandRuntimeStatus(command),
        pid: command.pid,
        url: command.url ?? null,
        exitCode: command.exitCode ?? null,
        exitSignal: command.exitSignal ?? null,
        exitedAt: command.exitedAt ?? null,
        ...(command.idleStoppedAt ? { idleStoppedAt: command.idleStoppedAt, idleStoppedSeconds: command.idleStoppedSeconds } : {}),
      })
    }
  }

  if (json) return ok(JSON.stringify(records))
  if (records.length === 0) {
    return ok(scope.value.empty)
  }

  const rows = records.map((record) => [statusLabel(record), `${record.project}/${record.workspace}`, record.command, String(record.pid), record.url ?? ""])
  return ok(formatTable([["status", "workspace", "command", "pid", "url"], ...rows]))
}

function statusLabel(record: { status: string; exitCode: number | null; exitSignal: string | null; exitedAt: string | null; idleStoppedAt?: string; idleStoppedSeconds?: number }) {
  if (record.idleStoppedAt && record.exitedAt === record.idleStoppedAt) {
    const seconds = record.idleStoppedSeconds ?? 0
    const duration = seconds >= 3600 ? `${Math.floor(seconds / 3600)}h` : seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`
    return `stopped (idle ${duration}, ${formatExitTime(new Date(record.idleStoppedAt))})`
  }
  if (!record.exitedAt) return record.status
  const exit = record.exitSignal ?? (record.exitCode === null ? null : `exit ${record.exitCode}`)
  return `${record.status} (${exit ? `${exit}, ` : ""}${formatExitTime(new Date(record.exitedAt))})`
}

function formatExitTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0")
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  if (date.toDateString() === new Date().toDateString()) return time
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

function interruptibleSleep(ms: number, stopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      const remaining = ms - (Date.now() - start)
      if (stopped() || remaining <= 0) {
        resolve()
        return
      }
      setTimeout(tick, Math.min(100, remaining))
    }
    tick()
  })
}

async function workspaceScope(workspaceArg: string | undefined): Promise<Result<{ states: Array<WorkspaceState>; empty: string }>> {
  const ctx = await loadProjectContext()
  if (!ctx.ok) {
    const states = await findWorkspaceStates({ workspace: workspaceArg })
    if (!states.ok) return states
    const empty = workspaceArg ? `no tracked commands for workspace ${slugify(workspaceArg)} (work ps -a lists every workspace)` : "no tracked commands"
    return ok({ states: states.value, empty })
  }

  const project = ctx.value.config.project
  const workspace = workspaceArg ? slugify(workspaceArg) : await defaultWorkspace(ctx.value.cwdRoot)
  const state = await readWorkspaceState(project, workspace)
  if (!state.ok) return state

  const up = workspaceArg ? `work up ${workspace}` : "work up"
  return ok({
    states: state.value ? [state.value] : [],
    empty: `no tracked commands for ${project}/${workspace} (${up} starts them; work ps -a lists every workspace)`,
  })
}

function formatTable(rows: Array<Array<string>>): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))

  return rows
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd())
    .join("\n")
}

async function runLogs(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, {
    flags: {
      follow: booleanFlag("f"),
      all: booleanFlag("a"),
      tail: valueFlag("n"),
      lines: valueFlag(),
      project: valueFlag("p"),
      workspace: valueFlag("w"),
    },
  })
  if (!parsed.ok) return parsed

  const tailRaw = parsed.value.flags.tail ?? parsed.value.flags.lines
  const tail = tailRaw === undefined ? undefined : Number(tailRaw)
  if (tail !== undefined && (!Number.isInteger(tail) || tail < 0)) {
    return errResult("CLIError", `invalid line count: ${tailRaw}`)
  }

  const parsedTarget = workspaceCommandArgs(parsed.value.positional, parsed.value.flags.workspace)
  if (!parsedTarget.ok) return parsedTarget
  const command = parsedTarget.value.command
  if (!command) {
    return errResult("CLIError", "missing command. Usage: work logs [-f] [-n lines] [--all] [workspace] <command> | work logs [-f] -w workspace <command>")
  }

  const ctx = await loadProjectContext()
  let resolved: { project: string; workspace: string; command: string }

  if (ctx.ok && !parsed.value.flags.project) {
    resolved = {
      project: ctx.value.config.project,
      workspace: parsedTarget.value.workspace ? slugify(parsedTarget.value.workspace) : await defaultWorkspace(ctx.value.cwdRoot),
      command,
    }
  } else {
    const target = await resolveTrackedCommand(command, {
      project: parsed.value.flags.project,
      workspace: parsedTarget.value.workspace,
    })
    const untracked = parsed.value.flags.project && parsedTarget.value.workspace
      ? { project: slugify(parsed.value.flags.project), workspace: slugify(parsedTarget.value.workspace), command }
      : null
    if (target.ok) resolved = target.value
    else if (untracked && await existsAt(commandLogFile(untracked.project, untracked.workspace, command))) resolved = untracked
    else return target
  }

  const stateResult = await readWorkspaceState(resolved.project, resolved.workspace)
  if (!stateResult.ok) return stateResult

  // Pruned or never-tracked commands still have their log file.
  const record = stateResult.value?.commands[resolved.command]
  const logFile = record?.log ?? commandLogFile(resolved.project, resolved.workspace, resolved.command)

  if (!await existsAt(logFile)) {
    return errResult("CLIError", withSuggestion(`no log for ${resolved.workspace}/${resolved.command}`, resolved.command, await commandCandidates(resolved.project, resolved.workspace, ctx.ok ? Object.keys(ctx.value.config.commands) : [])))
  }

  const offset = parsed.value.flags.all ? ok(0) : await currentRunOffset(logFile, record?.logOffset)
  if (!offset.ok) return offset

  if (tail === undefined) {
    if (parsed.value.flags.follow) return followLog(logFile, offset.value)
    // Waiting for each write keeps memory bounded when stdout is a slow pipe.
    // A closed pipe (work logs web | head) stops the read instead of crashing on EPIPE.
    const closed = () => undefined
    process.stdout.on("error", closed)
    const printed = await forEachLogChunk(logFile, offset.value, (chunk) =>
      new Promise<boolean>((resolve) => process.stdout.write(chunk, (error) => resolve(Boolean(error)))))
    process.stdout.off("error", closed)
    return printed.ok ? ok(undefined) : printed
  }

  const read = await readLastLines(logFile, offset.value, tail)
  if (!read.ok) return read
  if (read.value.truncated) console.error(`work logs: showing only the last ${MAX_TAIL_BYTES / 1024 / 1024} MiB of the requested lines`)
  process.stdout.write(read.value.data)
  return parsed.value.flags.follow ? followLog(logFile, read.value.end) : ok(undefined)
}

async function runUrls(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: { project: valueFlag("p"), json: booleanFlag() } })
  if (!parsed.ok) return parsed

  const workspaceArg = parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra
  const ctx = await loadProjectContext()
  if (!ctx.ok || parsed.value.flags.project) {
    const states = await findWorkspaceStates({ project: parsed.value.flags.project, workspace: workspaceArg })
    if (!states.ok) return states
    if (parsed.value.flags.json) {
      console.log(urlsJson(states.value))
      return ok(undefined)
    }

    const rows = states.value.flatMap((state) =>
      Object.values(state.commands)
        .filter((command) => command.url && !command.exitedAt)
        .map((command) => [`${state.project}/${state.workspace}`, command.id, command.url ?? ""]),
    )

    if (rows.length === 0) {
      console.log(workspaceArg ? `no routed commands for ${workspaceArg}` : "no routed commands")
    } else {
      console.log(formatTable([["workspace", "command", "url"], ...rows]))
    }

    return ok(undefined)
  }

  const workspace = workspaceArg ? slugify(workspaceArg) : await defaultWorkspace(ctx.value.cwdRoot)
  const stateResult = await readWorkspaceState(ctx.value.config.project, workspace)
  if (!stateResult.ok) return stateResult
  if (parsed.value.flags.json) {
    console.log(urlsJson(stateResult.value ? [stateResult.value] : []))
    return ok(undefined)
  }
  const rows: Array<Array<string>> = []

  for (const command of Object.values(stateResult.value?.commands ?? {})) {
    if (command.url && !command.exitedAt) {
      rows.push([workspace, command.id, command.url])
    }
  }

  if (rows.length === 0) {
    console.log(`no routed commands for ${ctx.value.config.project}/${workspace}`)
  } else {
    console.log(formatTable([["workspace", "command", "url"], ...rows]))
  }

  return ok(undefined)
}

function urlsJson(states: Array<WorkspaceState>): string {
  return JSON.stringify(states.flatMap((state) => Object.values(state.commands)
    .filter((command) => command.url && !command.exitedAt)
    .map((command) => ({ project: state.project, workspace: state.workspace, command: command.id, url: command.url }))))
}

async function runStop(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: { project: valueFlag("p"), workspace: valueFlag("w") } })
  if (!parsed.ok) return parsed
  if (parsed.value.positional.length === 0) {
    return errResult("CLIError", "missing command. Usage: work stop [workspace] <id>... | work stop -w workspace <id>...")
  }

  const resolved = await stopTargets(parsed.value.positional, parsed.value.flags)
  if (!resolved.ok) return resolved

  const missing = [...resolved.value.missing]
  for (const target of resolved.value.targets) {
    const response = await callDaemon({ type: "stop", ...target, environment: childEnvironment() })
    if (!response.ok) return response

    if (response.value.data) {
      console.log(`stopped ${target.project}/${target.workspace}/${target.command}`)
    } else {
      missing.push(withSuggestion(`no tracked command: ${target.workspace}/${target.command}`, target.command, await commandCandidates(target.project, target.workspace)))
    }
  }

  return missing.length > 0 ? errResult("CLIError", missing.join("\n")) : ok(undefined)
}

async function stopTargets(
  positional: ReadonlyArray<string>,
  flags: { project: string | undefined; workspace: string | undefined },
): Promise<Result<{ targets: Array<{ project: string; workspace: string; command: string }>; missing: Array<string> }>> {
  const ctx = await loadProjectContext()
  if (!ctx.ok || flags.project) {
    const target = await trackedWorkspaceCommands(positional, flags)
    if (!target.ok) return target

    const targets = []
    const missing = []
    for (const command of target.value.commands) {
      const match = await resolveTrackedCommand(command, { project: flags.project, workspace: target.value.workspace })
      if (match.ok) targets.push(match.value)
      else if (match.error.tag === "CLIError") missing.push(match.error.message)
      else return match
    }
    return ok({ targets, missing })
  }

  const project = ctx.value.config.project
  const current = await defaultWorkspace(ctx.value.cwdRoot)
  const commandIds = await commandCandidates(project, current, Object.keys(ctx.value.config.commands))
  const target = await projectWorkspaceCommands(ctx.value, positional, flags.workspace, commandIds)
  const workspace = target.workspace ? slugify(target.workspace) : current
  return ok({ targets: target.commands.map((command) => ({ project, workspace, command })), missing: [] })
}

async function runWait(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, {
    flags: { project: valueFlag("p"), workspace: valueFlag("w"), timeout: valueFlag(), log: valueFlag() },
  })
  if (!parsed.ok) return parsed

  const timeout = parsed.value.flags.timeout === undefined ? 60 : Number(parsed.value.flags.timeout)
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return errResult("CLIError", `invalid timeout: ${parsed.value.flags.timeout}`)
  }
  const logFlag = parsed.value.flags.log === undefined ? ok(undefined) : logPattern(parsed.value.flags.log, "--log")
  if (!logFlag.ok) return logFlag

  const target = await resolveWorkspaceAndCommand(parsed.value.positional, parsed.value.flags, "wait")
  if (!target.ok) return target
  const { project, workspace, command } = target.value
  const state = await readWorkspaceState(project, workspace)
  if (!state.ok) return state
  const record = state.value?.commands[command]
  if (!record) return errResult("CLIError", `no tracked command: ${workspace}/${command}`)
  const configured = !logFlag.value && record.ready ? logPattern(record.ready.log, "ready.log") : ok(undefined)
  if (!configured.ok) return configured
  const pattern = logFlag.value ?? configured.value
  if (!record.url && !pattern) {
    return errResult("CLIError", `no URL or ready.log for ${workspace}/${command}; enable routing, set ready: { log: "<regex>" }, or pass --log <regex>`)
  }

  const trackedRecord = async () => {
    const current = await readWorkspaceState(project, workspace)
    return current.ok ? current.value?.commands[command] : undefined
  }
  const isAlive = async () => {
    const tracked = await trackedRecord()
    if (!tracked) return false
    // workd restarts on-exit commands itself, so a dead pid may be replaced shortly.
    return tracked.restart === "on-exit" || await commandRuntimeStatus(tracked) === "up"
  }
  const logsHint = `Logs: work logs -p ${project} -w ${workspace} ${command}`
  const deadline = performance.now() + timeout * 1_000

  if (pattern) {
    let run: { id: string; offset: number } | undefined
    const currentRun = async (): Promise<Result<{ id: string; offset: number }>> => {
      const tracked = await trackedRecord() ?? record
      if (run?.id === tracked.startedAt) return ok(run)
      const offset = await currentRunOffset(tracked.log, tracked.logOffset)
      if (!offset.ok) return offset
      run = { id: tracked.startedAt, offset: offset.value }
      return ok(run)
    }
    const matched = await waitForLog(record.log, pattern, timeout * 1_000, currentRun, isAlive)
    if (!matched.ok) return errResult("ProcessError", `${workspace}/${command} ${matched.error.message}. ${logsHint}`)
    if (!record.url) {
      console.log(matched.value)
      return ok(undefined)
    }
  }

  if (!record.url) return ok(undefined)
  // A tailnet URL resolves to this machine's tailnet address, which only other devices reach.
  const probeUrl = record.exposure?.mode === "tailscale" ? record.localUrl ?? record.url : record.url
  const ready = await waitForUrl(probeUrl, Math.max(1, deadline - performance.now()), isAlive)
  if (!ready.ok) return errResult("ProcessError", `${ready.error.message}. ${logsHint}`)
  console.log(record.url)
  return ok(undefined)
}

function logPattern(source: string, field: string): Result<RegExp> {
  try {
    return ok(new RegExp(source))
  } catch (cause) {
    return errResult("CLIError", `invalid ${field} regular expression: ${source}`, cause)
  }
}

async function runTailscale(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: { domain: valueFlag(), yes: booleanFlag("y") } })
  if (!parsed.ok) return parsed
  const [subcommand, ...rest] = parsed.value.positional
  if (subcommand !== "setup") return errResult("CLIError", "usage: work tailscale setup [--domain <domain>] [--yes]")
  const extra = unexpectedPositional(rest, 0)
  if (extra) return extra

  const interactive = Boolean(process.stdin.isTTY)
  const yes = parsed.value.flags.yes
  const root = await gitRoot(process.cwd())
  const environment = root.ok ? await loadWorkspaceEnvironment(root.value, root.value) : ok(childEnvironment())
  if (!environment.ok) return environment

  return runTailscaleSetup({
    domain: parsed.value.flags.domain,
    environment: { ...process.env, ...environment.value },
    log: (line) => console.log(line),
    prompts: {
      ask: async (question) => interactive ? ask(question) : "",
      askSecret: async (question) => interactive ? askSecret(question) : "",
      confirm: async (question) => yes || (interactive && await confirm(question)),
      waitForEnter: async (question) => { if (interactive) await ask(question) },
    },
  })
}

async function ask(question: string) {
  const rl = readline.createInterface({ input, output })
  const answer = await rl.question(question)
  rl.close()
  return answer
}

async function askSecret(question: string) {
  output.write(question)
  const muted = new Writable({ write: (_chunk, _encoding, callback) => callback() })
  const rl = readline.createInterface({ input, output: muted, terminal: true })
  const answer = await rl.question("")
  rl.close()
  output.write("\n")
  return answer
}

async function runDoctor(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args)
  if (!parsed.ok) return parsed
  if (parsed.value.positional.length > 0) {
    return errResult("CLIError", `unexpected argument: ${parsed.value.positional[0]}`)
  }

  const root = await gitRoot(process.cwd())
  if (root.ok) {
    console.log(`git\tok\t${root.value}`)
  } else {
    console.log(`git\tmissing\t${root.error.message}`)
  }

  const config = root.ok ? await loadConfig(root.value) : null

  if (config?.ok) {
    console.log(`config\tok\t${config.value.project}`)
    console.log(`setup\t${config.value.worktrees?.setup ? config.value.worktrees.setup : "none"}`)
  } else {
    console.log(`config\tmissing\t${config?.error.message ?? "not in a project"}`)
  }

  const needsPortless = config?.ok ? Object.values(config.value.commands).some(usesPortless) : false
  const environment = root.ok
    ? await loadWorkspaceEnvironment(root.value, root.value)
    : ok(childEnvironment())
  console.log(await portlessDoctorLine(needsPortless, environment.ok ? environment.value : process.env))

  const cloudflareConfigured = environment.ok && Boolean(environment.value["WORK_CLOUDFLARE_DOMAIN"] || environment.value["WORK_CLOUDFLARE_TUNNEL_ID"])
  if (!cloudflareConfigured) {
    console.log("cloudflare\tnot configured")
  } else {
    const exposure = cloudflareExposure(environment.ok ? environment.value : process.env)
    if (!exposure.ok) {
      console.log(`cloudflare\tinvalid\t${exposure.error.message}`)
    } else if (!await commandExists("cloudflared")) {
      console.log("cloudflare\tmissing\tcloudflared is not installed")
    } else if (exposure.value.mode === "cloudflare" && !await existsAt(exposure.value.credentialsFile)) {
      console.log(`cloudflare\tmissing\t${exposure.value.credentialsFile}`)
    } else {
      console.log(`cloudflare\tok\t${exposure.value.mode === "cloudflare" ? exposure.value.domain : ""}`)
    }
  }

  console.log(await tailscaleDoctorLine(environment.ok ? environment.value : process.env))

  const daemon = await daemonStatus()
  const unit = await daemonUnit(daemon)
  console.log(["workd", ...daemonStatusFields(daemon, "ok", unit)].join("\t"))
  if (sessionScope(unit)) console.log(`workd\twarning\t${sessionScopeWarning(unit)}`)

  if (config?.ok) {
    for (const [id, command] of Object.entries(config.value.commands)) {
      const route = command.route ? "routed" : "local"
      const start = command.autoStart ? "auto" : "manual"
      console.log(`command\t${id}\t${start}\t${route}`)
    }
  }

  return ok(undefined)
}

async function runPrune(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args)
  if (!parsed.ok) return parsed
  if (parsed.value.positional.length > 0) {
    return errResult("CLIError", `unexpected argument: ${parsed.value.positional[0]}`)
  }

  const response = await callDaemon({ type: "prune", environment: childEnvironment() })
  if (!response.ok) return response

  const count = response.value.data
  console.log(`pruned ${count} dead command${count === 1 ? "" : "s"}`)
  return ok(undefined)
}

async function runUpdates(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args)
  if (!parsed.ok) return parsed
  const extra = unexpectedPositional(parsed.value.positional, 0)
  if (extra) return extra
  if (buildCommit) console.log(`installed build: ${buildCommit.slice(0, 7)}${buildDirty ? "-dirty" : ""}`)
  console.log(formatUpdateStatus(await readUpdateStatus()))
  return ok(undefined)
}

async function runDaemon(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args)
  if (!parsed.ok) return parsed

  const action = parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra

  switch (action) {
    case "start": {
      const pid = await ensureDaemon()
      if (!pid.ok) return pid
      console.log(`workd running pid=${pid.value}`)
      return ok(undefined)
    }

    case "stop": {
      const stop = await stopDaemon()
      if (!stop.ok) return stop
      console.log("workd stopped")
      return ok(undefined)
    }

    case "status": {
      const status = await daemonStatus()
      const unit = await daemonUnit(status)
      console.log(["workd", ...daemonStatusFields(status, "running", unit)].join(" "))
      if (sessionScope(unit)) console.log(`warning: ${sessionScopeWarning(unit)}`)
      return ok(undefined)
    }

    default:
      return errResult("CLIError", "usage: work daemon <start|stop|status>")
  }
}

async function portlessDoctorLine(needed: boolean, environment: NodeJS.ProcessEnv) {
  if (!needed) return "portless\tnot needed"
  if (!await commandExists("portless", environment)) return "portless\tmissing"
  const proxy = await probePortless(environment)
  if (proxy.state === "ok") return `portless\tok\tproxy on :${proxy.port}`
  if (proxy.state === "stopped") return `portless\tstopped\tno proxy on :${proxy.port}; ${proxyRemedyHint(await portlessProxyRemedy(environment, proxy.port))}`
  return `portless\tblocked\t:${proxy.port} answers without X-Portless; another proxy owns the port`
}

function daemonStatusFields(status: DaemonStatus, runningLabel: string, unit: string | null) {
  if (status.running) return [runningLabel, `pid=${status.pid}`, ...(unit ? [`unit=${unit}`] : [])]
  if (status.outdated) return ["outdated", `pid=${status.pid} runs an older build; the next work command replaces it`]
  return ["stopped"]
}

async function daemonUnit(status: DaemonStatus) {
  return status.running && status.pid !== null && process.platform === "linux" ? processUnit(status.pid) : null
}

function sessionScopeWarning(unit: string | null) {
  return `workd runs inside ${unit} and dies with it, taking its commands along; move it with: work daemon stop && work daemon start, then work restart --all in each worktree`
}

async function runDocs(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args)
  if (!parsed.ok) return parsed

  const text = docsText(parsed.value.positional[0])
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra
  if (!text.ok) return text

  console.log(text.value)
  return ok(undefined)
}

async function runCompletions(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args)
  if (!parsed.ok) return parsed

  const shell = parsed.value.positional[0]
  if (!shell) {
    return errResult("CLIError", "usage: work completions <bash|zsh>")
  }
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra

  const script = completionScript(shell)
  if (!script.ok) return script

  console.log(script.value)
  return ok(undefined)
}

async function runShellInit(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args)
  if (!parsed.ok) return parsed

  const shell = parsed.value.positional[0]
  if (!shell) {
    return errResult("CLIError", "usage: work shell-init <bash|zsh>")
  }
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra

  const script = shellInitScript(shell)
  if (!script.ok) return script

  console.log(script.value)
  return ok(undefined)
}

async function runCd(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args)
  if (!parsed.ok) return parsed

  const workspaceName = parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra
  const ctx = await loadProjectContext()
  if (!ctx.ok) return ctx

  const workspace = await resolveWorkspace(ctx.value, workspaceName, { create: false, noCreate: true })
  if (!workspace.ok) return workspace

  process.stdout.write(`${workspace.value.root}\n`)
  return ok(undefined)
}

async function runComplete(args: ReadonlyArray<string>): Promise<Result<void>> {
  try {
    const items = await complete([...args])
    for (const item of items) {
      console.log(item)
    }
  } catch (cause) {
    debugLog("complete", cause instanceof Error ? cause.message : String(cause))
  }

  return ok(undefined)
}

async function resolveWorkspaceAndCommand(
  positional: ReadonlyArray<string>,
  flags: { project: string | undefined; workspace: string | undefined },
  commandName: "wait",
): Promise<Result<{ project: string; workspace: string; command: string }>> {
  const target = workspaceCommandArgs(positional, flags.workspace)
  if (!target.ok) return target
  const command = target.value.command
  if (!command) {
    return errResult("CLIError", `missing command. Usage: work ${commandName} [workspace] <id> | work ${commandName} -w workspace <id>`)
  }

  const ctx = await loadProjectContext()
  if (!ctx.ok || flags.project) {
    return resolveTrackedCommand(command, {
      project: flags.project,
      workspace: target.value.workspace,
    })
  }

  const workspace = flags.workspace
    ? slugify(flags.workspace)
    : target.value.workspace
      ? slugify(target.value.workspace)
    : await defaultWorkspace(ctx.value.cwdRoot)

  return ok({ project: ctx.value.config.project, workspace, command })
}

function workspaceCommandArgs(positional: ReadonlyArray<string>, workspaceFlag: string | undefined): Result<{ workspace: string | undefined; command: string | undefined }> {
  if (workspaceFlag && positional.length > 1) {
    return errResult("CLIError", `unexpected argument: ${positional[1]}`)
  }

  if (!workspaceFlag && positional.length > 2) {
    return errResult("CLIError", `unexpected argument: ${positional[2]}`)
  }

  if (!workspaceFlag && positional.length === 2) {
    return ok({ workspace: positional[0], command: positional[1] })
  }

  return ok({ workspace: workspaceFlag, command: positional[0] })
}

async function projectWorkspaceCommands(
  ctx: ProjectContext,
  positional: ReadonlyArray<string>,
  workspaceFlag: string | undefined,
  commandIds: Array<string>,
): Promise<WorkspaceCommands> {
  const first = positional[0]
  const firstIsCommandOnly = first !== undefined && commandIds.includes(first) && !await workspaceExists(ctx, first)
  return splitWorkspaceCommands(positional, workspaceFlag, firstIsCommandOnly)
}

async function trackedWorkspaceCommands(
  positional: ReadonlyArray<string>,
  flags: { project: string | undefined; workspace: string | undefined },
): Promise<Result<WorkspaceCommands>> {
  const states = await findWorkspaceStates({ project: flags.project })
  if (!states.ok) return states

  const first = positional[0]
  const firstIsCommandOnly = first !== undefined
    && states.value.some((state) => state.commands[first])
    && !states.value.some((state) => state.workspace === slugify(first))
  return ok(splitWorkspaceCommands(positional, flags.workspace, firstIsCommandOnly))
}

async function resolveTrackedCommands(
  target: WorkspaceCommands,
  project: string | undefined,
): Promise<Result<Array<{ project: string; workspace: string; command: string }>>> {
  const resolved = []
  for (const command of target.commands) {
    const match = await resolveTrackedCommand(command, { project, workspace: target.workspace })
    if (!match.ok) return match
    resolved.push(match.value)
  }
  return ok(resolved)
}

async function resolveTrackedCommand(
  command: string,
  filters: StateFilters,
): Promise<Result<{ project: string; workspace: string; command: string }>> {
  const states = await findWorkspaceStates(filters)
  if (!states.ok) return states

  const matches = states.value.filter((state) => state.commands[command])

  if (matches.length === 0) {
    const commandNames = states.value.flatMap((state) => Object.keys(state.commands))
    return errResult("CLIError", withSuggestion(`no tracked command: ${command}`, command, commandNames))
  }

  if (matches.length > 1) {
    return errResult("CLIError", `ambiguous command: ${command}. Use -p project and/or -w workspace.`)
  }

  const [state] = matches
  return ok({ project: state.project, workspace: state.workspace, command })
}

async function unknownTrackedCommandMessage(project: string, workspace: string, command: string, candidates: Array<string> = []) {
  return withSuggestion(`unknown command: ${command}`, command, await commandCandidates(project, workspace, candidates))
}

async function commandCandidates(project: string, workspace: string, candidates: Array<string> = []) {
  const state = await readWorkspaceState(project, workspace)
  return state.ok ? [...candidates, ...Object.keys(state.value?.commands ?? {})] : candidates
}

async function findWorkspaceStates(filters: StateFilters): Promise<Result<Array<WorkspaceState>>> {
  const project = filters.project ? slugify(filters.project) : undefined
  const workspace = filters.workspace ? slugify(filters.workspace) : undefined
  const states = (await listWorkspaceStates())
    .filter((state) => !project || state.project === project)
    .filter((state) => !workspace || state.workspace === workspace)

  return ok(states)
}

async function loadProjectContext(): Promise<Result<ProjectContext>> {
  const cwdRoot = await gitRoot(process.cwd())
  if (!cwdRoot.ok) return cwdRoot

  const root = await gitMainWorktree(process.cwd())
  if (!root.ok) return root

  const config = await loadConfig(root.value)
  if (!config.ok) return config

  return ok({ root: root.value, cwdRoot: cwdRoot.value, config: config.value })
}

async function defaultWorkspace(root: string): Promise<string> {
  const workspace = await workspaceFromGit(root)
  return workspace.ok ? workspace.value : path.basename(root)
}

function worktreePath(ctx: ProjectContext, workspace: string) {
  return path.resolve(ctx.root, ctx.config.worktrees?.dir ?? `../${ctx.config.project}.worktrees`, workspace)
}

async function workspaceExists(ctx: ProjectContext, name: string) {
  const workspace = slugify(name)
  const current = await workspaceFromGit(ctx.cwdRoot)
  return (current.ok && current.value === workspace) || await existsAt(worktreePath(ctx, workspace))
}

async function followLog(file: string, offset: number): Promise<Result<void>> {
  return new Promise((resolve) => {
    // -F keeps following when a restart rotates the log to a new file.
    const tail = spawn("tail", ["-c", `+${offset + 1}`, "-F", file], {
      stdio: "inherit",
    })

    const removeForwarding = forwardSignals(tail)

    tail.on("error", (cause) => {
      removeForwarding()
      resolve(errResult("IOError", `failed to tail ${file}`, cause))
    })
    tail.on("close", () => {
      removeForwarding()
      resolve(ok(undefined))
    })
  })
}

function forwardSignals(child: import("node:child_process").ChildProcess): () => void {
  const handler = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal)
  }

  process.once("SIGINT", handler)
  process.once("SIGTERM", handler)
  process.once("SIGHUP", handler)

  return () => {
    process.off("SIGINT", handler)
    process.off("SIGTERM", handler)
    process.off("SIGHUP", handler)
  }
}

async function runWorkspaceSetup(
  config: DevConfig,
  sourceRoot: string,
  workspace: WorkspaceResolution,
  exposure: Exposure = { mode: "local" },
  environment: Record<string, string> = childEnvironment(),
): Promise<Result<void>> {
  const setup = config.worktrees?.setup

  if (!setup) {
    return ok(undefined)
  }

  console.log(`setup ${workspace.workspace}`)
  const ports = await portlessPortsForConfig(config, environment)

  return new Promise((resolve) => {
    const child = spawn(setup, {
      cwd: workspace.root,
      shell: true,
      stdio: "inherit",
      env: {
        ...childEnvironment({ ...config.env, ...environment }),
        ...workspaceSetupEnv(config, sourceRoot, workspace, exposure, ports),
      },
    })

    const removeForwarding = forwardSignals(child)

    child.on("error", (cause) => {
      removeForwarding()
      resolve(errResult("ProcessError", "setup failed to spawn", cause))
    })
    child.on("close", (code, signal) => {
      removeForwarding()
      if (code === 0) {
        resolve(ok(undefined))
        return
      }

      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`
      resolve(errResult("ProcessError", `setup failed with ${detail}`))
    })
  })
}

function workspaceSetupEnv(config: DevConfig, sourceRoot: string, workspace: WorkspaceRecord, exposure: Exposure, ports: Record<string, number>) {
  return {
    WORK_PROJECT: config.project,
    WORK_WORKSPACE: workspace.workspace,
    WORK_ROOT: workspace.root,
    WORK_SOURCE_ROOT: sourceRoot,
    WORK_BRANCH: workspace.branch ?? "",
    ...routeEnvironmentForConfig(config, workspace.workspace, ports, exposure),
  }
}

async function resolveExposure(
  flags: { cloudflare?: boolean | undefined; tailscale?: boolean | undefined },
  environment: Record<string, string>,
  project: string,
  workspace: string,
): Promise<Result<Exposure>> {
  if (flags.cloudflare && flags.tailscale) return errResult("CLIError", "choose --cloudflare or --tailscale, not both")
  if (flags.cloudflare) return cloudflareExposure(environment)
  if (flags.tailscale) return tailscaleExposure(environment)
  const state = await readWorkspaceState(project, workspace)
  if (!state.ok) return state
  const mode = state.value?.exposure?.mode
  if (mode === "cloudflare") return cloudflareExposure(environment)
  if (mode === "tailscale") return tailscaleExposure(environment)
  return ok({ mode: "local" })
}

function printProcessStart(command: string, result: StartResult, verb = result.started ? "started" : "already up") {
  console.log(`${verb} ${command} pid=${result.record.pid}${result.record.url ? ` ${result.record.url}` : ""}`)
}

function printStartupExit(command: string, pid: number, exit: StartupExit) {
  if (exit.code === 0) {
    console.log(`exited ${command} pid=${pid} with code 0`)
    return
  }

  const status = exit.signal ? ` on ${exit.signal}` : exit.code === null ? "" : ` with code ${exit.code}`
  console.log(`failed ${command} pid=${pid} exited${status}`)
  for (const line of exit.tail.length > 0 ? exit.tail : ["(no output)"]) console.log(`  ${line}`)
}

function unexpectedPositional(positional: ReadonlyArray<string>, count: number): Result<never> | null {
  const extra = positional[count]
  return extra ? errResult("CLIError", `unexpected argument: ${extra}`) : null
}

function withSuggestion(message: string, input: string, candidates: Array<string>) {
  const suggestion = closest(input, [...new Set(candidates)])
  return suggestion ? `${message}. Did you mean ${suggestion}?` : message
}

function closest(input: string, candidates: Array<string>) {
  let best: { value: string; distance: number } | null = null

  for (const candidate of candidates) {
    const distance = levenshtein(input, candidate)
    if (distance === 0) continue
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

async function resolveWorkspace(
  ctx: ProjectContext,
  name: string | undefined,
  flags: { create: boolean; noCreate: boolean; remote?: string | undefined; usage?: string },
): Promise<Result<WorkspaceResolution>> {
  const { config, root, cwdRoot } = ctx
  const currentResult = await workspaceFromGit(cwdRoot)
  if (!currentResult.ok) return currentResult
  const currentWorkspace = currentResult.value

  const workspace = name ? slugify(name) : currentWorkspace
  const validated = validateSlug(workspace, "workspace")
  if (!validated.ok) return validated

  if (!name || workspace === currentWorkspace) {
    const branch = await gitBranch(cwdRoot)
    return ok({
      project: config.project,
      workspace,
      branch: branch.ok ? branch.value : null,
      root: cwdRoot,
      sourceRoot: root,
      created: false,
    })
  }

  const worktreeRoot = worktreePath(ctx, workspace)
  const exists = await existsAt(worktreeRoot)

  if (!exists) {
    if (flags.noCreate) {
      return errResult("WorkspaceError", missingWorkspaceMessage(config, workspace, flags.usage))
    }

    const source = await resolveBranchSource(root, name, workspace, flags.remote)
    if (!source.ok) return source
    const sourceDescription = describeBranchSource(source.value)

    if (!flags.create && !await confirm(`Workspace ${workspace} does not exist. Create worktree from ${sourceDescription}?`)) {
      return errResult("WorkspaceError", `workspace ${workspace} does not exist`)
    }

    const created = await createWorktree(root, worktreeRoot, source.value)
    if (!created.ok) return created

    return ok({
      project: config.project,
      workspace,
      branch: source.value.branch,
      root: worktreeRoot,
      sourceRoot: root,
      created: true,
      createdFrom: sourceDescription,
    })
  }

  const worktreeBranch = await gitBranch(worktreeRoot)

  return ok({
    project: config.project,
    workspace,
    branch: worktreeBranch.ok && worktreeBranch.value ? worktreeBranch.value : workspace,
    root: worktreeRoot,
    sourceRoot: root,
    created: false,
  })
}

function missingWorkspaceMessage(config: DevConfig, workspace: string, usage: string | undefined) {
  const message = `workspace ${workspace} does not exist`
  return usage && config.commands[workspace] ? `${message}; ${workspace} is a command id. Usage: ${usage}` : message
}

async function confirm(question: string) {
  if (!process.stdin.isTTY) {
    return false
  }

  const rl = readline.createInterface({ input, output })
  const answer = await rl.question(`${question} [Y/n] `)
  rl.close()

  return !answer || answer.toLowerCase().startsWith("y")
}
