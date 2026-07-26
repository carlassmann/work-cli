export type CommandSpec = {
  name: string
  summary: string
  flags: ReadonlyArray<string>
}

export const commandSpecs = [
  { name: "init", summary: "Create work.config.js.", flags: [] },
  { name: "create", summary: "Create a git worktree.", flags: ["--remote"] },
  { name: "up", summary: "Start workspace commands.", flags: ["--create", "--no-create", "--remote"] },
  { name: "setup", summary: "Run the workspace setup hook.", flags: [] },
  { name: "down", summary: "Stop workspace commands.", flags: ["-a", "--all", "-p", "--project"] },
  { name: "run", summary: "Start one configured command.", flags: ["-w", "--workspace"] },
  { name: "restart", summary: "Restart commands.", flags: ["-a", "--all", "-p", "--project", "-w", "--workspace"] },
  { name: "ps", summary: "List tracked commands.", flags: ["-a", "--all"] },
  { name: "status", summary: "Alias for ps.", flags: ["-a", "--all"] },
  { name: "watch", summary: "Live-refresh the ps table.", flags: ["-a", "--all", "-n", "--interval"] },
  { name: "logs", summary: "Print or follow command logs.", flags: ["-f", "--follow", "-p", "--project", "-w", "--workspace"] },
  { name: "urls", summary: "List workspace URLs.", flags: ["-p", "--project"] },
  { name: "stop", summary: "Stop a tracked command.", flags: ["-p", "--project", "-w", "--workspace"] },
  { name: "doctor", summary: "Check project setup.", flags: [] },
  { name: "prune", summary: "Remove dead process records.", flags: [] },
  { name: "daemon", summary: "Manage workd.", flags: [] },
  { name: "help", summary: "Show command help.", flags: [] },
  { name: "docs", summary: "Show built-in reference docs.", flags: [] },
  { name: "completions", summary: "Print shell completion script.", flags: [] },
  { name: "shell-init", summary: "Print shell init (completion + cd wrapper).", flags: [] },
  { name: "cd", summary: "Print workspace root for shell cd.", flags: [] },
] as const satisfies ReadonlyArray<CommandSpec>

export type CommandName = (typeof commandSpecs)[number]["name"]

export const commandNames: ReadonlyArray<string> = commandSpecs.map((spec) => spec.name)
