// Deploy the built bot to the HK dev machine after `npm run build`, then reload it with pm2.
// Uses the system OpenSSH client. Auth is either an SSH key (preferred) or a password you put in .env.
//
// Env (all optional unless noted):
//   DEPLOY_HOST          default 02.hkg.s.frkovo.cn
//   DEPLOY_USER          default root
//   DEPLOY_KEY           private key path, default ~/.ssh/hk-deploy (used when no password is set)
//   DEPLOY_PASSWORD      server password. Put it in discord-bot/.env (gitignored) as DEPLOY_PASSWORD=...
//                        Leave it empty to use the key instead.
//   DEPLOY_DIR           remote directory, default /sgaba
//   DEPLOY_PM2_NAME      pm2 process name, default index
//   DEPLOY_RESTART       overrides the default pm2 reload command if needed
//   DEPLOY_SKIP=1        skip deploy (e.g. local-only builds)
//   DEPLOY_SYNC_ASSETS=1 also upload assets/maimaiDX (455 MB; uploaded automatically on first deploy)
//
// Never uploads .env, .data/, test.zip, node_modules or reference/.
import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const env = { ...process.env }

if (env.DEPLOY_SKIP === "1") {
  console.log("[deploy] DEPLOY_SKIP=1, skipped")
  process.exit(0)
}

// Read DEPLOY_* from .env when they are not already in the environment (npm does not load .env for scripts).
const dotenv = join(ROOT, ".env")
if (existsSync(dotenv)) {
  for (const line of readFileSync(dotenv, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(DEPLOY_[A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^["']|["']$/g, "")
  }
}

const host = env.DEPLOY_HOST || "02.hkg.s.frkovo.cn"
const user = env.DEPLOY_USER || "root"
const dir = env.DEPLOY_DIR || "/sgaba"
const pm2Name = env.DEPLOY_PM2_NAME || "index"
const password = env.DEPLOY_PASSWORD || ""
const key = env.DEPLOY_KEY || join(homedir(), ".ssh", "hk-deploy")
const target = `${user}@${host}`

// Password mode: OpenSSH asks SSH_ASKPASS for the password. The helper only echoes the env var, so the
// password is never written to disk or placed on a command line.
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
  console.error("[deploy] set DEPLOY_PASSWORD in .env, set DEPLOY_KEY, or run DEPLOY_SKIP=1 npm run build")
  process.exit(1)
}

const sshBase = [
  ...(password ? [] : ["-i", key, "-o", "BatchMode=yes"]),
  "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new", target,
]

function run(cmd, args, input) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: [input ? "pipe" : "inherit", "inherit", "inherit"] })
    child.on("error", reject)
    if (input) input(child.stdin)
    child.on("close", (code) => (code === 0 ? resolveRun() : reject(new Error(`${cmd} exited with ${code}`))))
  })
}

// Remote check: does assets/maimaiDX already exist there?
function remoteHasArt() {
  return new Promise((resolveCheck) => {
    const child = spawn("ssh", [...sshBase, `test -d '${dir}/assets/maimaiDX' && echo yes || echo no`], { cwd: ROOT, env, stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.on("close", (code) => resolveCheck(code === 0 && out.trim() === "yes"))
    child.on("error", () => resolveCheck(false))
  })
}

async function main() {
  // Small runtime files are always sent: keys.json, assets/data (charts, versions), assets/certs, assets/fonts.
  // The large assets/maimaiDX art is sent only on first deploy or when DEPLOY_SYNC_ASSETS=1.
  const includeArt = env.DEPLOY_SYNC_ASSETS === "1" || !(await remoteHasArt())
  const parts = ["dist", "keys.json", "package.json", "package-lock.json", "assets/data", "assets/certs", "assets/fonts"]
  if (includeArt) parts.push("assets/maimaiDX")
  console.log(`[deploy] ${target}:${dir} <- ${parts.join(", ")} (auth: ${password ? "password" : "key"})`)

  await run("ssh", [...sshBase, `mkdir -p '${dir}'`])

  // Stream a tar archive through ssh; bsdtar ships with Windows 10+ and Git Bash.
  // Attach the tar listener before ssh starts. Previously the listener came after ssh had already finished,
  // so the promise never settled and Node exited with code 0 without uploading anything.
  const tar = spawn("tar", ["-cf", "-", ...parts], { cwd: ROOT, env, stdio: ["ignore", "pipe", "inherit"] })
  const tarDone = new Promise((resolveTar, rejectTar) => {
    tar.on("error", rejectTar)
    tar.on("close", (code) => (code === 0 ? resolveTar() : rejectTar(new Error(`tar exited with ${code}`))))
  })
  await run("ssh", [...sshBase, `tar -xf - -C '${dir}'`], (stdin) => tar.stdout.pipe(stdin))
  await tarDone

  // Install production dependencies on the remote only when the lockfile changed.
  await run("ssh", [...sshBase, `cd '${dir}' && (cmp -s package-lock.json .deployed-lock 2>/dev/null && [ -d node_modules ] || (npm ci --omit=dev && cp package-lock.json .deployed-lock))`])

  // pm2: reload the existing process, or start it the first time.
  const pm2Cmd = `cd '${dir}' && (pm2 describe '${pm2Name}' >/dev/null 2>&1 && pm2 restart '${pm2Name}' --update-env || pm2 start dist/index.js --name '${pm2Name}' --cwd '${dir}') && pm2 save`
  console.log(`[deploy] pm2 ${pm2Name}`)
  await run("ssh", [...sshBase, env.DEPLOY_RESTART || pm2Cmd])
  console.log("[deploy] done")
}

main()
  .catch((error) => {
    console.error(`[deploy] failed: ${error.message}`)
    process.exitCode = 1
  })
  .finally(() => {
    if (askpassFile && existsSync(askpassFile)) unlinkSync(askpassFile)
  })
