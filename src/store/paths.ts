// Container-friendly paths: the project root is read-only in the image, so caches and logs live under B50_DATA_DIR.
import path from "node:path"
import { fileURLToPath } from "node:url"

/** src/ or dist/ parent: the project root inside the image (/app) or the checkout. */
export const ROOT = fileURLToPath(new URL("../../", import.meta.url))

/** Writable directory for caches and logs. Mount it as a volume; it holds no player data. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.B50_DATA_DIR?.trim()
  return path.resolve(configured || path.join(ROOT, ".data"))
}
