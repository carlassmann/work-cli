import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve()

export async function tempDir(prefix = "work-cli-test-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function writeFile(file: string, source: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, source)
}

async function git(args: Array<string>, cwd: string) {
  return await execFileAsync("git", args, { cwd })
}

export async function initGitRepo(root: string) {
  await git(["init"], root)
  await git(["config", "user.email", "test@example.com"], root)
  await git(["config", "user.name", "Test User"], root)
  await writeFile(path.join(root, "README.md"), "# test\n")
  await git(["add", "README.md"], root)
  await git(["commit", "-m", "init"], root)
}

export async function runCli(args: Array<string>, options: { cwd: string; stateRoot?: string }) {
  const env = {
    ...process.env,
    WORK_STATE_ROOT: options.stateRoot ?? await tempDir("work-cli-state-"),
  }

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
