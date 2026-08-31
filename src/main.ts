#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import readline from "node:readline/promises"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { stdin as input, stdout as output } from "node:process"
import { cloudflareExposure } from "./cloudflare.js"
import { commandNames } from "./commands.js"
import { complete, completionScript, shellInitScript } from "./completions.js"
import { createConfig, loadConfig } from "./config.js"
import { createWorktree, describeBranchSource, gitBranch, gitMainWorktree, gitRoot, resolveBranchSource, workspaceFromGit } from "./git.js"
import { slugify, validateSlug } from "./names.js"
import { commandRuntimeStatus } from "./processes.js"
import { commandLogFile, listWorkspaceStates, readWorkspaceState } from "./state.js"
import { docsText, docsTopics } from "./docs.js"
import { commandHelp, helpSection, rootHelp } from "./help.js"
import { booleanFlag, parseArgs, valueFlag } from "./parse.js"
import { ensurePortless, routeEnvironmentForConfig, usesPortless } from "./portless.js"
import { childEnvironment, loadWorkspaceEnvironment } from "./environment.js"
import { commandExists, existsAt } from "./shell.js"
import { callDaemon, daemonStatus, ensureDaemon, stopDaemon } from "./daemon-client.js"
import { debugLog, errResult, formatError, ok, tryAsync } from "./result.js"
import type { Result } from "./result.js"
import type { CommandName } from "./commands.js"
import type { DevConfig, Exposure, StartResult, WorkspaceRecord, WorkspaceState } from "./types.js"

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
    console.log(`work ${version}`)
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
    doctor: runDoctor,
    prune: runPrune,
    daemon: runDaemon,
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
    flags: { create: booleanFlag(), "no-create": booleanFlag(), remote: valueFlag(), cloudflare: booleanFlag() },
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
  let exposure = await resolveExposure(parsed.value.flags.cloudflare, environment.value, ctx.value.config.project, workspace.value.workspace)
  if (!exposure.ok) return exposure

  if (workspace.value.created) {
    console.log(`created ${workspace.value.workspace} from ${workspace.value.createdFrom}`)
    const setup = await runWorkspaceSetup(ctx.value.config, ctx.value.root, workspace.value, exposure.value, environment.value)
    if (!setup.ok) return setup
    environment = await loadWorkspaceEnvironment(ctx.value.root, workspace.value.root)
    if (!environment.ok) return environment
    exposure = await resolveExposure(parsed.value.flags.cloudflare, environment.value, ctx.value.config.project, workspace.value.workspace)
    if (!exposure.ok) return exposure
  }

  if (commands.length === 0) {
    console.log(`no autoStart commands in work.config.js for ${ctx.value.config.project}`)
    return ok(undefined)
  }

  return startConfigured(ctx.value, workspace.value, commands, "run", exposure.value)
}

async function runSetup(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: { cloudflare: booleanFlag() } })
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
  const exposure = await resolveExposure(parsed.value.flags.cloudflare, environment.value, ctx.value.config.project, workspace.value.workspace)
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
  const parsed = parseArgs(args, { flags: { workspace: valueFlag("w"), cloudflare: booleanFlag() } })
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

  const workspace = await resolveWorkspace(ctx.value, parsedTarget.value.workspace, { create: false, noCreate: true })
  if (!workspace.ok) return workspace

  const environment = await loadWorkspaceEnvironment(ctx.value.root, workspace.value.root)
  if (!environment.ok) return environment
  const exposure = await resolveExposure(parsed.value.flags.cloudflare, environment.value, ctx.value.config.project, workspace.value.workspace)
  if (!exposure.ok) return exposure

  return startConfigured(ctx.value, workspace.value, [[command, commandConfig]], "run", exposure.value)
}

async function runRestart(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, {
    flags: { all: booleanFlag("a"), project: valueFlag("p"), workspace: valueFlag("w"), cloudflare: booleanFlag() },
  })
  if (!parsed.ok) return parsed

  const all = parsed.value.flags.all
  const projectArg = parsed.value.flags.project
  const positional = workspaceCommandArgs(parsed.value.positional, parsed.value.flags.workspace)
  if (!positional.ok) return positional
  const workspaceArg = positional.value.workspace
  const target = positional.value.command

  if (all && target) {
    return errResult("CLIError", "work restart --all accepts no command argument")
  }

  const ctx = await loadProjectContext()
  if (!ctx.ok || projectArg) {
    if (all) {
      const states = await findWorkspaceStates({ project: projectArg, workspace: workspaceArg })
      if (!states.ok) return states
      return restartTrackedStates(states.value)
    }

    if (!target) {
      return errResult("CLIError", "missing command. Usage: work restart [workspace] <command> | work restart -w workspace <command> | work restart --all")
    }

    const resolved = await resolveTrackedCommand(target, { project: projectArg, workspace: workspaceArg })
    if (!resolved.ok) return resolved
    return restartTracked(resolved.value)
  }

  const workspace = await resolveWorkspace(ctx.value, workspaceArg, { create: false, noCreate: true })
  if (!workspace.ok) return workspace
  const environment = await loadWorkspaceEnvironment(ctx.value.root, workspace.value.root)
  if (!environment.ok) return environment
  const exposure = await resolveExposure(parsed.value.flags.cloudflare, environment.value, ctx.value.config.project, workspace.value.workspace)
  if (!exposure.ok) return exposure

  if (all) {
    const autoStart = Object.entries(ctx.value.config.commands).filter(([, command]) => command.autoStart)

    if (autoStart.length === 0) {
      console.log(`no autoStart commands in work.config.js for ${ctx.value.config.project}`)
      return ok(undefined)
    }

    return startConfigured(ctx.value, workspace.value, autoStart, "restart", exposure.value)
  }

  if (!target) {
    return errResult("CLIError", "missing command. Usage: work restart [workspace] <command> | work restart -w workspace <command> | work restart --all")
  }

  const commandConfig = ctx.value.config.commands[target]

  if (!commandConfig) {
    return errResult("CLIError", await unknownTrackedCommandMessage(ctx.value.config.project, workspace.value.workspace, target, Object.keys(ctx.value.config.commands)))
  }

  return startConfigured(ctx.value, workspace.value, [[target, commandConfig]], "restart", exposure.value)
}

async function startConfigured(
  ctx: ProjectContext,
  workspace: WorkspaceRecord,
  entries: Array<[string, DevConfig["commands"][string]]>,
  type: "run" | "restart",
  exposure: Exposure = { mode: "local" },
): Promise<Result<void>> {
  const portless = await ensurePortless(Object.fromEntries(entries))
  if (!portless.ok) return portless
  for (const [id] of entries) {
    const response = await callDaemon({
      type,
      config: ctx.config,
      workspace,
      command: id,
      exposure,
      environment: childEnvironment(),
    })
    if (!response.ok) return response
    printProcessStart(id, response.value.data, type === "restart" ? "restarted" : undefined)
  }

  return ok(undefined)
}

async function restartTrackedStates(states: Array<WorkspaceState>): Promise<Result<void>> {
  const targets = states.flatMap((state) =>
    Object.keys(state.commands).map((command) => ({ project: state.project, workspace: state.workspace, command })),
  )

  if (targets.length === 0) {
    console.log("no tracked commands")
    return ok(undefined)
  }

  for (const target of targets) {
    const result = await restartTracked(target)
    if (!result.ok) return result
  }

  return ok(undefined)
}

async function restartTracked(target: { project: string; workspace: string; command: string }): Promise<Result<void>> {
  const response = await callDaemon({
    type: "restartTracked",
    ...target,
    environment: childEnvironment(),
  })
  if (!response.ok) return response

  printProcessStart(`${target.project}/${target.workspace}/${target.command}`, response.value.data, "restarted")
  return ok(undefined)
}

async function runPs(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: { all: booleanFlag("a") } })
  if (!parsed.ok) return parsed
  if (parsed.value.positional.length > 0) {
    return errResult("CLIError", `unexpected argument: ${parsed.value.positional[0]}`)
  }

  const table = await trackedCommandTable(parsed.value.flags.all)
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

async function trackedCommandTable(all: boolean): Promise<Result<string>> {
  const statesResult = all ? ok(await listWorkspaceStates()) : await currentWorkspaceStates()
  if (!statesResult.ok) return statesResult

  const rows: Array<Array<string>> = []

  for (const state of statesResult.value) {
    for (const command of Object.values(state.commands)) {
      const status = await commandRuntimeStatus(command)
      rows.push([status, `${state.project}/${state.workspace}`, command.id, String(command.pid), command.url ?? ""])
    }
  }

  if (rows.length === 0) {
    return ok("no tracked commands")
  }

  return ok(formatTable([["status", "workspace", "command", "pid", "url"], ...rows]))
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

async function currentWorkspaceStates(): Promise<Result<Array<WorkspaceState>>> {
  const ctx = await loadProjectContext()
  if (!ctx.ok) return ok(await listWorkspaceStates())

  const workspace = await defaultWorkspace(ctx.value.cwdRoot)
  const state = await readWorkspaceState(ctx.value.config.project, workspace)
  if (!state.ok) return state

  return ok(state.value ? [state.value] : [])
}

function formatTable(rows: Array<Array<string>>): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))

  return rows
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd())
    .join("\n")
}

async function runLogs(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, {
    flags: { follow: booleanFlag("f"), project: valueFlag("p"), workspace: valueFlag("w") },
  })
  if (!parsed.ok) return parsed

  const parsedTarget = workspaceCommandArgs(parsed.value.positional, parsed.value.flags.workspace)
  if (!parsedTarget.ok) return parsedTarget
  const command = parsedTarget.value.command
  if (!command) {
    return errResult("CLIError", "missing command. Usage: work logs [-f] [workspace] <command> | work logs [-f] -w workspace <command>")
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
    if (!target.ok) return target
    resolved = target.value
  }

  const stateResult = await readWorkspaceState(resolved.project, resolved.workspace)
  if (!stateResult.ok) return stateResult

  const record = stateResult.value?.commands[resolved.command]
  if (!record) {
    return errResult("CLIError", withSuggestion(`no log for ${resolved.workspace}/${resolved.command}`, resolved.command, await commandCandidates(resolved.project, resolved.workspace, ctx.ok ? Object.keys(ctx.value.config.commands) : [])))
  }

  const logFile = record?.log ?? commandLogFile(resolved.project, resolved.workspace, resolved.command)

  if (!await existsAt(logFile)) {
    return errResult("CLIError", `no log for ${resolved.workspace}/${resolved.command}`)
  }

  if (!parsed.value.flags.follow) {
    const read = await tryAsync("IOError", `failed to read log ${logFile}`, async () =>
      await fs.readFile(logFile, "utf8"),
    )
    if (!read.ok) return read
    process.stdout.write(read.value)
    return ok(undefined)
  }

  return followLog(logFile)
}

async function runUrls(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: { project: valueFlag("p") } })
  if (!parsed.ok) return parsed

  const workspaceArg = parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra
  const ctx = await loadProjectContext()
  if (!ctx.ok || parsed.value.flags.project) {
    const states = await findWorkspaceStates({ project: parsed.value.flags.project, workspace: workspaceArg })
    if (!states.ok) return states

    const rows = states.value.flatMap((state) =>
      Object.values(state.commands)
        .filter((command) => command.url)
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
  const rows: Array<Array<string>> = []

  for (const command of Object.values(stateResult.value?.commands ?? {})) {
    if (command.url) {
      rows.push([workspace, command.id, command.url])
    }
  }

  if (rows.length === 0) {
    console.log(`no routed commands for ${workspace}`)
  } else {
    console.log(formatTable([["workspace", "command", "url"], ...rows]))
  }

  return ok(undefined)
}

async function runStop(args: ReadonlyArray<string>): Promise<Result<void>> {
  const wsCmd = await parseWorkspaceAndCommand(args, "stop")
  if (!wsCmd.ok) return wsCmd

  const response = await callDaemon({ type: "stop", project: wsCmd.value.project, workspace: wsCmd.value.workspace, command: wsCmd.value.command, environment: childEnvironment() })
  if (!response.ok) return response

  if (!response.value.data) {
    return errResult("CLIError", withSuggestion(`no tracked command: ${wsCmd.value.workspace}/${wsCmd.value.command}`, wsCmd.value.command, await commandCandidates(wsCmd.value.project, wsCmd.value.workspace)))
  }

  console.log(`stopped ${wsCmd.value.project}/${wsCmd.value.workspace}/${wsCmd.value.command}`)
  return ok(undefined)
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
  console.log(`portless\t${needsPortless ? await commandExists("portless") ? "ok" : "missing" : "not needed"}`)

  const environment = root.ok
    ? await loadWorkspaceEnvironment(root.value, root.value)
    : ok(childEnvironment())
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

  const status = await daemonStatus()
  console.log(`workd\t${status.running ? `ok\tpid=${status.pid}` : "stopped"}`)

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
      console.log(status.running ? `workd running pid=${status.pid}` : "workd stopped")
      return ok(undefined)
    }

    default:
      return errResult("CLIError", "usage: work daemon <start|stop|status>")
  }
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

async function parseWorkspaceAndCommand(args: ReadonlyArray<string>, commandName: "stop"): Promise<Result<{ project: string; workspace: string; command: string }>> {
  const parsed = parseArgs(args, { flags: { project: valueFlag("p"), workspace: valueFlag("w") } })
  if (!parsed.ok) return parsed

  const target = workspaceCommandArgs(parsed.value.positional, parsed.value.flags.workspace)
  if (!target.ok) return target
  const command = target.value.command
  if (!command) {
    return errResult("CLIError", `missing command. Usage: work ${commandName} [workspace] <id> | work ${commandName} -w workspace <id>`)
  }

  const ctx = await loadProjectContext()
  if (!ctx.ok || parsed.value.flags.project) {
    return resolveTrackedCommand(command, {
      project: parsed.value.flags.project,
      workspace: target.value.workspace,
    })
  }

  const workspace = parsed.value.flags.workspace
    ? slugify(parsed.value.flags.workspace)
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

async function followLog(file: string): Promise<Result<void>> {
  const prep = await tryAsync("IOError", `failed to prepare log ${file}`, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, "")
  })
  if (!prep.ok) return prep

  return new Promise((resolve) => {
    const tail = spawn("tail", ["-n", "+1", "-f", file], {
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

  return new Promise((resolve) => {
    const child = spawn(setup, {
      cwd: workspace.root,
      shell: true,
      stdio: "inherit",
      env: {
        ...childEnvironment({ ...config.env, ...environment }),
        ...workspaceSetupEnv(config, sourceRoot, workspace, exposure),
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

function workspaceSetupEnv(config: DevConfig, sourceRoot: string, workspace: WorkspaceRecord, exposure: Exposure) {
  return {
    WORK_PROJECT: config.project,
    WORK_WORKSPACE: workspace.workspace,
    WORK_ROOT: workspace.root,
    WORK_SOURCE_ROOT: sourceRoot,
    WORK_BRANCH: workspace.branch ?? "",
    ...routeEnvironmentForConfig(config, workspace.workspace, exposure),
  }
}

async function resolveExposure(
  cloudflare: boolean | undefined,
  environment: Record<string, string>,
  project: string,
  workspace: string,
): Promise<Result<Exposure>> {
  if (cloudflare) return cloudflareExposure(environment)
  const state = await readWorkspaceState(project, workspace)
  if (!state.ok) return state
  return state.value?.exposure?.mode === "cloudflare" ? cloudflareExposure(environment) : ok({ mode: "local" })
}

function printProcessStart(command: string, result: StartResult, verb = result.started ? "started" : "already up") {
  console.log(`${verb} ${command} pid=${result.record.pid}${result.record.url ? ` ${result.record.url}` : ""}`)
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
  flags: { create: boolean; noCreate: boolean; remote?: string | undefined },
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

  const worktreeRoot = path.resolve(root, config.worktrees?.dir ?? `../${config.project}.worktrees`, workspace)
  const exists = await existsAt(worktreeRoot)

  if (!exists) {
    if (flags.noCreate) {
      return errResult("WorkspaceError", `workspace ${workspace} does not exist`)
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

async function confirm(question: string) {
  if (!process.stdin.isTTY) {
    return false
  }

  const rl = readline.createInterface({ input, output })
  const answer = await rl.question(`${question} [Y/n] `)
  rl.close()

  return !answer || answer.toLowerCase().startsWith("y")
}
