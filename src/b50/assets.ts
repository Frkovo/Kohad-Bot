// 渲染素材：字体（assets/fonts/*.otf）与封面磁盘缓存（.data/jacket-cache/{musicId}.png）。
// 字体：默认 NotoSansCJKsc-Regular/Bold（开源 OFL），可自行替换（保持文件名或改这里）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url)) // src/b50 或 dist/b50
const ROOT = path.resolve(HERE, "..", "..")               // discord-bot/
const FONT_DIR = path.join(ROOT, "assets", "fonts")
const CACHE_DIR = path.join(ROOT, ".data", "jacket-cache")
const COVER_DIR = path.join(ROOT, "assets", "maimaiDX", "cover")

export type LoadedFont = { name: string; data: Buffer; weight: 400 | 700; style: "normal" }

let fontsCache: LoadedFont[] | null = null

export function loadFonts(): LoadedFont[] {
  if (fontsCache) return fontsCache
  const out: LoadedFont[] = []
  const regular = path.join(FONT_DIR, "NotoSansCJKsc-Regular.otf")
  const bold = path.join(FONT_DIR, "NotoSansCJKsc-Bold.otf")
  if (existsSync(regular)) out.push({ name: "NotoSansSC", data: readFileSync(regular), weight: 400, style: "normal" })
  if (existsSync(bold)) out.push({ name: "NotoSansSC", data: readFileSync(bold), weight: 700, style: "normal" })
  if (!out.length) {
    throw new Error(`缺少字体文件：请把 OTF/TTF 字体放入 ${FONT_DIR}（默认期望 NotoSansCJKsc-Regular.otf / -Bold.otf）`)
  }
  fontsCache = out
  return out
}

const jacketCache = new Map<number, string | null>() // musicId -> data URI | null（null = 不可用）

async function downloadJacket(musicId: number): Promise<Buffer | null> {
  const local = path.join(COVER_DIR, `${musicId % 10000}.png`)
  try { if (existsSync(local)) return readFileSync(local) } catch { /* continue to network/cache */ }
  const file = path.join(CACHE_DIR, `${musicId}.png`)
  try { if (existsSync(file)) return readFileSync(file) } catch { /* fallthrough */ }
  try {
    const res = await fetch(`https://assets2.lxns.net/maimai/jacket/${musicId}.png`, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return null
    try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(file, buf) } catch { /* 缓存写失败不阻断 */ }
    return buf
  } catch { return null }
}

/** 批量取封面（限并发 6），返回 musicId → data URI（失败为 null，渲染侧显示占位块） */
export async function getJackets(musicIds: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>()
  const todo = [...new Set(musicIds)].filter(id => !jacketCache.has(id))
  let idx = 0
  const workers = Array.from({ length: Math.min(6, todo.length) }, async () => {
    while (idx < todo.length) {
      const id = todo[idx++]
      const buf = await downloadJacket(id)
      if (buf) jacketCache.set(id, `data:image/png;base64,${buf.toString("base64")}`)
    }
  })
  await Promise.all(workers)
  for (const id of musicIds) out.set(id, jacketCache.get(id) ?? null)
  return out
}

const netJacketCache = new Map<string, string>()
/** DXRating's explicit SHA256 cover reference; never derive remote art from CN song IDs. */
export async function getNetJackets(hashes: string[]): Promise<Map<string, string>> {
  const todo = [...new Set(hashes)].filter(hash => /^[a-f0-9]{64}$/.test(hash) && !netJacketCache.has(hash))
  const deadline = AbortSignal.timeout(20000)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, async () => {
    while (next < todo.length && !deadline.aborted) {
      const hash = todo[next++], file = path.join(ROOT, ".data", "net-jacket-cache", `${hash}.jpg`)
      try {
        let bytes: Buffer
        if (existsSync(file)) bytes = readFileSync(file)
        else {
          const response = await fetch(`https://shama.dxrating.net/images/cover/v2/${hash}.jpg`, { redirect: "error", signal: deadline })
          if (!response.ok) continue
          bytes = Buffer.from(await response.arrayBuffer())
        }
        if (bytes.length > 4_000_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) continue
        netJacketCache.set(hash, `data:image/jpeg;base64,${bytes.toString("base64")}`)
        if (!existsSync(file)) {
          try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes) } catch { /* optional public-art cache */ }
        }
      } catch { /* Missing art does not prevent a score image; retry on a future query. */ }
    }
  }))
  return new Map(hashes.flatMap(hash => netJacketCache.has(hash) ? [[hash, netJacketCache.get(hash)!]] : []))
}

const collectionCache = new Map<string, string>()
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** Public collection art only; the path is constructed from a validated numeric ID. */
export async function getCollectionArt(kind: "icon" | "plate", id?: number): Promise<string | null> {
  if (!Number.isSafeInteger(id) || Number(id) <= 0) return null
  const key = `${kind}/${id}`
  if (collectionCache.has(key)) return collectionCache.get(key)!
  const local = path.join(ROOT, "assets", "maimaiDX", kind, `UI_${kind === "icon" ? "Icon" : "Plate"}_${String(id).padStart(6, "0")}.png`)
  const file = path.join(ROOT, ".data", "collection-cache", kind, `${id}.png`)
  const remember = (buf: Buffer) => {
    if (!buf.subarray(0, 8).equals(pngSignature)) return null
    const uri = `data:image/png;base64,${buf.toString("base64")}`
    collectionCache.set(key, uri)
    return uri
  }
  for (const candidate of [local, file]) {
    try { if (existsSync(candidate)) { const art = remember(readFileSync(candidate)); if (art) return art } } catch { /* fetch below */ }
  }
  const urls = [`https://assets2.lxns.net/maimai/${kind}/${id}.png`,
    `https://www.yuzuchan.moe/assets/maimaidx/${kind}/UI_${kind === "icon" ? "Icon" : "Plate"}_${String(id).padStart(6,"0")}.png`]
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) continue
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > 8_000_000) continue
      const art = remember(bytes)
      if (!art) continue
      try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes) } catch { /* optional cache */ }
      return art
    } catch { /* try next source */ }
  }
  return null
}
