// Deploy this checkout to a Docker host over SSH (no registry required).
//
// Required env (Discord tokens etc. stay on the server in .env):
//   DEPLOY_HOST     ssh host, e.g. lon-02.frkovo.uk
// Optional:
//   DEPLOY_USER     default root
//   DEPLOY_DIR      remote project directory, default /opt/kohad-bot
//   DEPLOY_KEY      private key path, default ~/.ssh/id_ed25519
//   DEPLOY_PASSWORD server password; used via SSH_ASKPASS when no key is set
//   DEPLOY_ASSETS   "1" (default) uploads the big artwork only when the remote copy is incomplete
//   DEPLOY_FULL_ASSETS "1" always uploads assets/maimaiDX (400+ MB)//   DEPLOY_SKIP=1   skip (e.g. local-only builds)
//   DEPLOY_RESTART  override the remote compose command
//
// The checkout must contain assets/ (artwork and fonts are not in the repository).
// compose.baota.yaml is left untouched on the server and used automatically when present.
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const env = { ...process.env }
if (env.DEPLOY_SKIP === "1") { console.log("[deploy] DEPLOY_SKIP=1, skipped"); process.exit(0) }

// npm does not load .env for scripts; read DEPLOY_* without printing anything.
const dotenv = join(ROOT, ".env")
if (existsSync(dotenv)) {
  for (const line of readFileSync(dotenv, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(DEPLOY_[A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^["']|["']$/g, "")
  }
}

const host = env.DEPLOY_HOST?.trim()
if (!host) { console.error("[deploy] DEPLOY_HOST is required (e.g. DEPLOY_HOST=lon-02.frkovo.uk)"); process.exit(1) }
const user = env.DEPLOY_USER || "root"
const dir = env.DEPLOY_DIR || "/opt/kohad-bot"
const password = env.DEPLOY_PASSWORD || ""
const key = env.DEPLOY_KEY || join(homedir(), ".ssh", "id_ed25519")
const target = `${user}@${host}`

let askpassFile
if (password) {
  askpassFile = join(tmpdir(), `deploy-askpass-${process.pid}.cmd`)
  writeFileSync(askpassFile, "@echo off\r\necho %DEPLOY_PASSWORD%\r\n")
  env.SSH_ASKPASS = askpassFile
  env.SSH_ASKPASS_REQUIRE = "force"
  env.DISPLAY ??= "deploy"
  env.DEPLOY_PASSWORD = password
} else if (!existsSync(key)) {
  console.error(`[deploy] no DEPLOY_PASSWORD and private key not found: ${key}`)
  process.exit(1)
}

const sshBase = [
  ...(password ? [] : ["-i", key, "-o", "BatchMode=yes"]),
  "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new", target,
]

function run(command, args, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: [input ? "pipe" : "inherit", "inherit", "inherit"] })
    child.on("error", rejectRun)
    if (input) input(child.stdin)
    child.on("close", code => (code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited with ${code}`))))
  })
}

function ssh(remote) { return run("ssh", [...sshBase, remote]) }
function sshOutput(remote) {
  return new Promise(resolveOutput => {
    const child = spawn("ssh", [...sshBase, remote], { cwd: ROOT, env, stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    child.stdout.on("data", chunk => (out += chunk))
    child.on("close", () => resolveOutput(out.trim()))
    child.on("error", () => resolveOutput(""))
  })
}

// Asset inventory: the count is what makes a "missing songs" deploy visible before players notice.
const ASSET_DIRS = ["assets/maimaiDX/cover", "assets/maimaiDX/pic", "assets/fonts", "assets/data"]
function localCounts() {
  const counts = {}
  for (const relative of ASSET_DIRS) {
    const absolute = join(ROOT, relative)
    counts[relative] = existsSync(absolute) ? walk(absolute) : 0
  }
  return counts
}
function walk(directory) {
  let count = 0
  for (const entry of readdirSafe(directory)) {
    if (entry.isDirectory()) count += walk(join(directory, entry.name))
    else count++
  }
  return count
}
function readdirSafe(directory) {
  try { return readdirSync(directory, { withFileTypes: true }) } catch { return [] }
}

async function remoteCounts() {
  const script = ASSET_DIRS.map(d => `printf '%s ' '${d}'; find '${dir}/${d}' -type f 2>/dev/null | wc -l`).join("; ")
  const out = await sshOutput(script)
  const counts = {}
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^(\S+) (\d+)$/)
    if (match) counts[match[1]] = Number(match[2])
  }
  return counts
}

function reportAssets(label, local, remote) {
  console.log(`[deploy] ${label}`)
  let missing = 0
  for (const relative of ASSET_DIRS) {
    const have = remote[relative] ?? 0, want = local[relative] ?? 0
    if (have < want) missing += want - have
    const mark = have === want ? "ok" : have < want ? `缺少 ${want - have}` : `多出 ${have - want}`
    console.log(`[deploy]   ${relative.padEnd(26)} local ${String(want).padStart(5)}  remote ${String(have).padStart(5)}  ${mark}`)
  }
  return missing
}

async function main() {
  if (!existsSync(join(ROOT, "assets/maimaiDX/cover"))) {
    console.error("[deploy] assets/maimaiDX/cover is missing in this checkout; artwork cannot be deployed")
    process.exitCode = 1
    return
  }
  const local = localCounts()
  const remote = await remoteCounts()
  const missing = reportAssets("asset inventory before deploy", local, remote)
  const includeArt = env.DEPLOY_FULL_ASSETS === "1" || (env.DEPLOY_ASSETS !== "0" && missing > 0)
  if (includeArt && missing > 0) console.log(`[deploy] remote assets are incomplete (${missing} files); uploading assets/maimaiDX`)
  if (!includeArt) console.log("[deploy] remote artwork is complete; skipping the 400 MB upload")

  const parts = ["Dockerfile", ".dockerignore", "compose.yaml", "package.json", "package-lock.json", "tsconfig.json",
    "keys.json", "src", "scripts", "assets/data", "assets/certs", "assets/fonts"]
  if (includeArt) parts.push("assets/maimaiDX")
  console.log(`[deploy] ${target}:${dir} <- ${parts.join(", ")}`)

  await ssh(`mkdir -p '${dir}'`)
  const tar = spawn("tar", ["-cf", "-", ...parts], { cwd: ROOT, env, stdio: ["ignore", "pipe", "inherit"] })
  const tarDone = new Promise((resolveTar, rejectTar) => {
    tar.on("error", rejectTar)
    tar.on("close", code => (code === 0 ? resolveTar() : rejectTar(new Error(`tar exited with ${code}`))))
  })
  await run("ssh", [...sshBase, `tar -xf - -C '${dir}'`], stdin => tar.stdout.pipe(stdin))
  await tarDone

  const compose = `args='-f compose.yaml'; [ -f compose.baota.yaml ] && args="$args -f compose.baota.yaml"; docker compose $args up -d --build`
  console.log("[deploy] docker compose up -d --build")
  await ssh(env.DEPLOY_RESTART || `cd '${dir}' && ${compose} && docker compose $args ps`)
  reportAssets("asset inventory after deploy", local, await remoteCounts())
  console.log("[deploy] done")
}

main()
  .catch(error => { console.error(`[deploy] failed: ${error.message}`); process.exitCode = 1 })
  .finally(() => { if (askpassFile && existsSync(askpassFile)) unlinkSync(askpassFile) })
