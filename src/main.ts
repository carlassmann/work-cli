#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import readline from "node:readline/promises"
import { spawn } from "node:child_process"
import { stdin as input, stdout as output } from "node:process"
import { complete, completionScript, shellInitScript } from "./completions.js"
import { createConfig, loadConfig } from "./config.js"
import { createWorktree, gitBranch, gitMainWorktree, gitRoot, workspaceFromGit } from "./git.js"
import { slugify, validateSlug } from "./names.js"
import { attachCommand, commandDisplayStatus, stopCommand as stopTrackedCommand } from "./processes.js"
import { commandLogFile, listWorkspaceStates, readWorkspaceState } from "./state.js"
import { docsText } from "./docs.js"
import { commandHelp, helpSection, rootHelp } from "./help.js"
import { booleanFlag, parseArgs, valueFlag } from "./parse.js"
import { ensurePortless, portlessUrl, routeEnvironmentForConfig, usesPortless, withRouting } from "./portless.js"
import { commandExists, existsAt } from "./shell.js"
import { daemonStatus, ensureDaemon, sendDaemon, stopDaemon } from "./daemon-client.js"
import { debugLog, errResult, formatError, ok, tryAsync } from "./result.js"
import type { Result } from "./result.js"
import type { DevConfig, RoutingConfig, StartResult, WorkspaceRecord, WorkspaceState } from "./types.js"

const VERSION = "0.1.0"

type WorkspaceResolution = WorkspaceRecord & {
  created: boolean
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

function routingFlags() {
  return {
    lan: booleanFlag(),
    "no-tls": booleanFlag(),
    ip: valueFlag(),
  }
}

function routingFromFlags(flags: { lan?: boolean; "no-tls"?: boolean; ip?: string | undefined }): RoutingConfig {
  const routing: RoutingConfig = {}

  if (flags.lan) {
    routing.target = "lan"
  }

  if (flags["no-tls"]) {
    routing.protocol = "http"
  }

  if (flags.ip) {
    routing.target = "lan"
    routing.ip = flags.ip
  }

  return routing
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
    console.log(`work ${VERSION}`)
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

      return errResult("CLIError", `${withSuggestion(`unknown help topic: ${topic}`, topic, [...commandNames(), ...docsTopics()])} Run 'work --help'.`)
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
      return errResult("CLIError", `${withSuggestion(`unknown command: ${name}`, name, commandNames())} Run 'work --help'.`)
    }

    console.log(commandHelp(name))
    return ok(undefined)
  }

  return dispatch(name, rest)
}

async function dispatch(name: string, args: ReadonlyArray<string>): Promise<Result<void>> {
  switch (name) {
    case "init":         return runInit(args)
    case "create":       return runCreate(args)
    case "up":           return runUp(args)
    case "setup":        return runSetup(args)
    case "down":         return runDown(args)
    case "run":          return runRun(args)
    case "restart":      return runRestart(args)
    case "ps":           return runPs(args)
    case "status":       return runPs(args)
    case "watch":        return runWatch(args)
    case "logs":         return runLogs(args)
    case "urls":         return runUrls(args)
    case "start":        return runStart(args, name)
    case "exec":         return runStart(args, name)
    case "tmux":         return runStart(args, name)
    case "attach":       return runAttach(args)
    case "stop":         return runStop(args)
    case "doctor":       return runDoctor(args)
    case "prune":        return runPrune(args)
    case "daemon":       return runDaemon(args)
    case "docs":         return runDocs(args)
    case "completions":  return runCompletions(args)
    case "shell-init":   return runShellInit(args)
    case "cd":           return runCd(args)
    case "_complete":    return runComplete(args)
    default:
      return errResult("CLIError", `${withSuggestion(`unknown command: ${name}`, name, commandNames())} Run 'work --help'.`)
  }
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
  const parsed = parseArgs(args)
  if (!parsed.ok) return parsed

  const workspaceName = parsed.value.positional[0]
  if (!workspaceName) {
    return errResult("CLIError", "missing workspace. Usage: work create <workspace>")
  }
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra

  const ctx = await loadProjectContext()
  if (!ctx.ok) return ctx

  const workspace = await resolveWorkspace(ctx.value, workspaceName, { create: true, noCreate: false })
  if (!workspace.ok) return workspace

  if (workspace.value.root === ctx.value.cwdRoot) {
    return errResult("WorkspaceError", `workspace ${workspace.value.workspace} is the current worktree`)
  }

  console.log(`${workspace.value.created ? "created" : "exists"} ${workspace.value.workspace}\t${workspace.value.root}`)
  return ok(undefined)
}

async function runUp(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, {
    flags: { create: booleanFlag(), "no-create": booleanFlag(), ...routingFlags() },
  })
  if (!parsed.ok) return parsed

  const workspaceName = parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra
  const create = parsed.value.flags.create
  const noCreate = parsed.value.flags["no-create"]
  if (create && noCreate) {
    return errResult("CLIError", "work up accepts only one of --create or --no-create")
  }

  const ctx = await loadProjectContext()
  if (!ctx.ok) return ctx
  const config = withRouting(ctx.value.config, routingFromFlags(parsed.value.flags))

  const workspace = await resolveWorkspace(ctx.value, workspaceName, { create, noCreate })
  if (!workspace.ok) return workspace

  const commands = Object.entries(config.commands).filter(([, command]) => command.autoStart)

  if (workspace.value.created) {
    const setup = await runWorkspaceSetup(config, ctx.value.root, workspace.value)
    if (!setup.ok) return setup
  }

  if (commands.length === 0) {
    console.log(`no autoStart commands in work.config.js for ${config.project}`)
    return ok(undefined)
  }

  const portless = await ensurePortless(Object.fromEntries(commands))
  if (!portless.ok) return portless

  const daemon = await ensureDaemon()
  if (!daemon.ok) return daemon

  for (const [id] of commands) {
    const response = await sendDaemon({ type: "run", config, workspace: workspace.value, command: id })
    if (!response.ok) return response
    printProcessStart(id, response.value.data)
  }

  return ok(undefined)
}

async function runSetup(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: routingFlags() })
  if (!parsed.ok) return parsed

  const workspaceName = parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra
  const ctx = await loadProjectContext()
  if (!ctx.ok) return ctx
  const config = withRouting(ctx.value.config, routingFromFlags(parsed.value.flags))

  const workspace = await resolveWorkspace(ctx.value, workspaceName, { create: false, noCreate: true })
  if (!workspace.ok) return workspace

  return runWorkspaceSetup(config, ctx.value.root, workspace.value)
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

  const daemon = await ensureDaemon()
  if (!daemon.ok) return daemon

  let count = 0

  for (const state of states) {
    const response = await sendDaemon({ type: "down", project: state.project, workspace: state.workspace })
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
  const parsed = parseArgs(args, { flags: { workspace: valueFlag("w"), ...routingFlags() } })
  if (!parsed.ok) return parsed

  const parsedTarget = workspaceCommandArgs(parsed.value.positional, parsed.value.flags.workspace)
  if (!parsedTarget.ok) return parsedTarget
  const command = parsedTarget.value.command
  if (!command) {
    return errResult("CLIError", "missing command. Usage: work run [workspace] <command> | work run -w workspace <command>")
  }

  const ctx = await loadProjectContext()
  if (!ctx.ok) return ctx
  const config = withRouting(ctx.value.config, routingFromFlags(parsed.value.flags))

  const commandConfig = config.commands[command]
  if (!commandConfig) {
    return errResult("CLIError", withSuggestion(`unknown command: ${command}`, command, Object.keys(config.commands)))
  }

  const workspace = await resolveWorkspace(ctx.value, parsedTarget.value.workspace, { create: false, noCreate: true })
  if (!workspace.ok) return workspace

  const portless = await ensurePortless({ [command]: commandConfig })
  if (!portless.ok) return portless

  const daemon = await ensureDaemon()
  if (!daemon.ok) return daemon

  const response = await sendDaemon({ type: "run", config, workspace: workspace.value, command })
  if (!response.ok) return response

  printProcessStart(command, response.value.data)
  return ok(undefined)
}

async function runRestart(args: ReadonlyArray<string>): Promise<Result<void>> {
  const parsed = parseArgs(args, {
    flags: { all: booleanFlag("a"), project: valueFlag("p"), workspace: valueFlag("w"), ...routingFlags() },
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
    const routing = routingFromFlags(parsed.value.flags)
    if (Object.keys(routing).length > 0) {
      return errResult("CLIError", "routing flags require a work project")
    }

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
  const config = withRouting(ctx.value.config, routingFromFlags(parsed.value.flags))

  const workspace = await resolveWorkspace(ctx.value, workspaceArg, { create: false, noCreate: true })
  if (!workspace.ok) return workspace

  if (all) {
    return restartAll({ ...ctx.value, config }, workspace.value)
  }

  if (!target) {
    return errResult("CLIError", "missing command. Usage: work restart [workspace] <command> | work restart -w workspace <command> | work restart --all")
  }

  const commandConfig = config.commands[target]

  if (commandConfig) {
    return restartConfigured({ ...ctx.value, config }, workspace.value, target, commandConfig)
  }

  if (Object.keys(routingFromFlags(parsed.value.flags)).length > 0) {
    return errResult("CLIError", "routing flags only apply to configured commands")
  }

  return restartAdhoc(ctx.value, workspace.value, target)
}

async function restartAll(ctx: ProjectContext, workspace: WorkspaceResolution): Promise<Result<void>> {
  const autoStart = Object.entries(ctx.config.commands).filter(([, command]) => command.autoStart)

  if (autoStart.length === 0) {
    console.log(`no autoStart commands in work.config.js for ${ctx.config.project}`)
    return ok(undefined)
  }

  const portless = await ensurePortless(Object.fromEntries(autoStart))
  if (!portless.ok) return portless

  const daemon = await ensureDaemon()
  if (!daemon.ok) return daemon

  for (const [id] of autoStart) {
    const response = await sendDaemon({ type: "restart", config: ctx.config, workspace, command: id })
    if (!response.ok) return response
    printProcessStart(id, response.value.data, "restarted")
  }

  return ok(undefined)
}

async function restartConfigured(ctx: ProjectContext, workspace: WorkspaceResolution, id: string, commandConfig: DevConfig["commands"][string]): Promise<Result<void>> {
  const portless = await ensurePortless({ [id]: commandConfig })
  if (!portless.ok) return portless

  const daemon = await ensureDaemon()
  if (!daemon.ok) return daemon

  const response = await sendDaemon({ type: "restart", config: ctx.config, workspace, command: id })
  if (!response.ok) return response

  printProcessStart(id, response.value.data, "restarted")
  return ok(undefined)
}

async function restartAdhoc(ctx: ProjectContext, workspace: WorkspaceResolution, id: string): Promise<Result<void>> {
  const stateResult = await readWorkspaceState(ctx.config.project, workspace.workspace)
  if (!stateResult.ok) return stateResult

  const record = stateResult.value?.commands[id]
  if (record?.runner !== "tmux") {
    return errResult("CLIError", await unknownTrackedCommandMessage(ctx.config.project, workspace.workspace, id, Object.keys(ctx.config.commands)))
  }

  const daemon = await ensureDaemon()
  if (!daemon.ok) return daemon

  const stop = await sendDaemon({ type: "stop", project: ctx.config.project, workspace: workspace.workspace, command: record.id })
  if (!stop.ok) return stop

  const response = await sendDaemon({ type: "adhoc", config: ctx.config, workspace, id: record.id, argv: record.argv })
  if (!response.ok) return response

  if (response.value.data.record.runner !== "tmux") {
    return errResult("ProcessError", `expected tmux runner for adhoc ${record.id}`)
  }

  printTmuxStart("restarted", record.id, response.value.data.record.tmuxSession)
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
  const daemon = await ensureDaemon()
  if (!daemon.ok) return daemon

  const response = await sendDaemon({ type: "restartTracked", ...target })
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
      const status = await commandDisplayStatus(command)
      const handle = command.runner === "tmux" ? command.tmuxSession : command.pid
      rows.push([status, `${state.project}/${state.workspace}`, command.id, command.runner, String(handle), command.url ?? ""])
    }
  }

  if (rows.length === 0) {
    return ok("no tracked commands")
  }

  return ok(formatTable([["status", "workspace", "command", "runner", "handle", "url"], ...rows]))
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
  const parsed = parseArgs(args, { flags: { project: valueFlag("p"), ...routingFlags() } })
  if (!parsed.ok) return parsed

  const workspaceArg = parsed.value.positional[0]
  const extra = unexpectedPositional(parsed.value.positional, 1)
  if (extra) return extra
  const routing = routingFromFlags(parsed.value.flags)
  const ctx = await loadProjectContext()
  if (!ctx.ok || parsed.value.flags.project) {
    if (Object.keys(routing).length > 0) {
      return errResult("CLIError", "routing flags require a work project")
    }

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

  const config = withRouting(ctx.value.config, routing)
  const workspace = workspaceArg ? slugify(workspaceArg) : await defaultWorkspace(ctx.value.cwdRoot)
  const stateResult = await readWorkspaceState(ctx.value.config.project, workspace)
  if (!stateResult.ok) return stateResult
  const rows: Array<Array<string>> = Object.keys(routing).length > 0 ? configuredUrlRows(config, workspace) : []

  if (rows.length === 0) {
    for (const command of Object.values(stateResult.value?.commands ?? {})) {
      if (command.url) {
        rows.push([workspace, command.id, command.url])
      }
    }
  }

  if (rows.length === 0) rows.push(...configuredUrlRows(config, workspace))

  if (rows.length === 0) {
    console.log(`no routed commands for ${workspace}`)
  } else {
    console.log(formatTable([["workspace", "command", "url"], ...rows]))
  }

  return ok(undefined)
}

function configuredUrlRows(config: DevConfig, workspace: string) {
  return Object.entries(config.commands).flatMap(([id, command]) => {
    const url = portlessUrl(config, workspace, id, command)
    return url ? [[workspace, id, url]] : []
  })
}

async function runStart(args: ReadonlyArray<string>, commandName = "start"): Promise<Result<void>> {
  const parsed = parseArgs(args, { flags: { workspace: valueFlag("w"), attach: booleanFlag("a") }, acceptRest: true })
  if (!parsed.ok) return parsed

  const target = workspaceCommandArgs(parsed.value.positional, parsed.value.flags.workspace)
  if (!target.ok) return target
  const id = target.value.command

  if (!id || !parsed.value.rest || parsed.value.rest.length === 0) {
    return errResult("CLIError", `usage: work ${commandName} [workspace] <id> -- <command> | work ${commandName} -w workspace <id> -- <command>`)
  }

  const slug = validateSlug(id, "command")
  if (!slug.ok) return slug

  const ctx = await loadProjectContext()
  if (!ctx.ok) return ctx

  const workspace = await resolveWorkspace(ctx.value, target.value.workspace, { create: false, noCreate: true })
  if (!workspace.ok) return workspace

  const daemon = await ensureDaemon()
  if (!daemon.ok) return daemon

  const response = await sendDaemon({ type: "adhoc", config: ctx.value.config, workspace: workspace.value, id, argv: [...parsed.value.rest] })
  if (!response.ok) return response

  const record = response.value.data.record
  if (record.runner !== "tmux") {
    return errResult("ProcessError", `expected tmux runner for adhoc ${id}`)
  }

  printTmuxStart(response.value.data.started ? "started" : "already up", id, record.tmuxSession)

  if (!parsed.value.flags.attach) {
    return ok(undefined)
  }

  return attachCommand(ctx.value.config.project, workspace.value.workspace, id)
}

async function runAttach(args: ReadonlyArray<string>): Promise<Result<void>> {
  const wsCmd = await parseWorkspaceAndCommand(args, "attach")
  if (!wsCmd.ok) return wsCmd

  return attachCommand(wsCmd.value.project, wsCmd.value.workspace, wsCmd.value.command)
}

async function runStop(args: ReadonlyArray<string>): Promise<Result<void>> {
  const wsCmd = await parseWorkspaceAndCommand(args, "stop")
  if (!wsCmd.ok) return wsCmd

  const daemon = await ensureDaemon()
  if (!daemon.ok) return daemon

  const response = await sendDaemon({ type: "stop", project: wsCmd.value.project, workspace: wsCmd.value.workspace, command: wsCmd.value.command })
  if (!response.ok) return response

  if (response.value.data) {
    console.log(`stopped ${wsCmd.value.project}/${wsCmd.value.workspace}/${wsCmd.value.command}`)
    return ok(undefined)
  }

  const localStop = await stopTrackedCommand(wsCmd.value.project, wsCmd.value.workspace, wsCmd.value.command)
  if (!localStop.ok) return localStop

  if (!localStop.value) {
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
  console.log(`tmux\t${await commandExists("tmux") ? "ok" : "missing"}`)

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

  const daemon = await ensureDaemon()
  if (!daemon.ok) return daemon

  const response = await sendDaemon({ type: "prune" })
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

async function parseWorkspaceAndCommand(args: ReadonlyArray<string>, commandName: "attach" | "stop"): Promise<Result<{ project: string; workspace: string; command: string }>> {
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

  const config = await loadConfig(cwdRoot.value)
  if (config.ok) {
    return ok({ root: root.value, cwdRoot: cwdRoot.value, config: config.value })
  }

  const mainConfig = await loadConfig(root.value)
  if (!mainConfig.ok) return mainConfig

  return ok({ root: root.value, cwdRoot: cwdRoot.value, config: mainConfig.value })
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

async function runWorkspaceSetup(config: DevConfig, sourceRoot: string, workspace: WorkspaceResolution): Promise<Result<void>> {
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
        ...process.env,
        ...workspaceSetupEnv(config, sourceRoot, workspace),
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

function workspaceSetupEnv(config: DevConfig, sourceRoot: string, workspace: WorkspaceRecord) {
  return {
    WORK_PROJECT: config.project,
    WORK_WORKSPACE: workspace.workspace,
    WORK_ROOT: workspace.root,
    WORK_SOURCE_ROOT: sourceRoot,
    WORK_BRANCH: workspace.branch ?? "",
    ...routeEnvironmentForConfig(config, workspace.workspace),
  }
}

function printProcessStart(command: string, result: StartResult, verb = result.started ? "started" : "already up") {
  const handle = result.record.runner === "process" ? ` pid=${result.record.pid}` : ""
  console.log(`${verb} ${command}${handle}${result.record.url ? ` ${result.record.url}` : ""}`)
}

function printTmuxStart(verb: string, command: string, tmuxSession: string | undefined) {
  console.log(`${verb} ${command} tmux=${tmuxSession ?? "unknown"}`)
}

function commandNames() {
  return [
    "init",
    "create",
    "up",
    "setup",
    "down",
    "run",
    "restart",
    "ps",
    "status",
    "watch",
    "logs",
    "urls",
    "start",
    "exec",
    "tmux",
    "attach",
    "stop",
    "doctor",
    "prune",
    "daemon",
    "help",
    "docs",
    "completions",
    "shell-init",
    "cd",
  ]
}

function docsTopics() {
  return ["overview", "config", "setup", "git", "daemon", "tmux", "workspaces", "urls", "portless", "commands"]
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
  flags: { create: boolean; noCreate: boolean },
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
      created: false,
    })
  }

  const worktreeRoot = path.resolve(root, config.worktrees?.dir ?? `../${config.project}.worktrees`, workspace)
  const exists = await existsAt(worktreeRoot)

  if (!exists) {
    if (flags.noCreate) {
      return errResult("WorkspaceError", `workspace ${workspace} does not exist`)
    }

    if (!flags.create && !await confirm(`Workspace ${workspace} does not exist. Create worktree from HEAD?`)) {
      return errResult("WorkspaceError", `workspace ${workspace} does not exist`)
    }

    const created = await createWorktree(root, worktreeRoot, workspace)
    if (!created.ok) return created
  }

  return ok({
    project: config.project,
    workspace,
    branch: workspace,
    root: worktreeRoot,
    created: !exists,
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
