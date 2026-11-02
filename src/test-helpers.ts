import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve()
const cliStateRoots = new Set<string>()

// runCli auto-starts a workd per state root and the tests never stop it.
// Stop them when the test process exits so test runs don't leave daemons behind.
process.on("exit", () => {
  for (const stateRoot of cliStateRoots) {
    try {
      process.kill(Number.parseInt(readFileSync(path.join(stateRoot, "workd.pid"), "utf8"), 10))
    } catch {
      // no workd started for this state root, or it already exited
    }
  }
})

export async function tempDir(prefix = "work-cli-test-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function writeFile(file: string, source: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, source)
}

export async function git(args: Array<string>, cwd: string) {
  return await execFileAsync("git", args, { cwd })
}

export async function initGitRepo(root: string) {
  await git(["init"], root)
  await git(["config", "user.email", "test@example.com"], root)
  await git(["config", "user.name", "Test User"], root)
  await writeFile(path.join(root, "README.md"), "# test\n")
  await git(["add", "README.md"], root)
  await git(["commit", "-m", "init"], root)
  await git(["branch", "-M", "main"], root)
}

export async function runCli(args: Array<string>, options: { cwd: string; stateRoot?: string; env?: NodeJS.ProcessEnv }) {
  const env = {
    ...process.env,
    WORK_STATE_ROOT: options.stateRoot ?? await tempDir("work-cli-state-"),
    XDG_CONFIG_HOME: await tempDir("work-cli-config-"),
    // Keep workd out of a systemd scope so it can't outlive the test process.
    WORK_DAEMON_SYSTEMD: "0",
    ...options.env,
  }
  cliStateRoots.add(env.WORK_STATE_ROOT)

  try {
    const result = await execFileAsync("bun", [path.join(repoRoot, "src/main.ts"), ...args], {
      cwd: options.cwd,
      env,
    })

    return { ...result, exitCode: 0 }
  } catch (error) {
    const failure = error as { stdout: string; stderr: string; code: number }
    return {
      stdout: failure.stdout,
      stderr: failure.stderr,
      exitCode: failure.code,
    }
  }
}
