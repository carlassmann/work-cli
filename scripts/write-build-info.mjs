import { execFileSync } from "node:child_process"
import { realpathSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
let commit = null
let dirty = false

try {
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  if (realpathSync(git(["rev-parse", "--show-toplevel"])) === realpathSync(root)) {
    commit = git(["rev-parse", "HEAD"])
    dirty = git(["status", "--porcelain"]).length > 0
  }
} catch {}

writeFileSync(new URL("../dist/build-info.js", import.meta.url),
  `export const buildCommit = ${JSON.stringify(commit)};\nexport const buildDirty = ${dirty};\n`)
