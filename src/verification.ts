import type { DfUploadRecord } from "./df/upload.js"
import type { DfPlayerRecords } from "./df/client.js"
import type { LxnsScore, LxnsUploadScore } from "./lxns/client.js"

const combo = ["", "fc", "fcp", "ap", "app"]
const sync = ["", "sync", "fs", "fsp", "fsd", "fsdp"]
function preserved(expected: { achievements: number; dx: number; fc?: string | null; fs?: string | null },
  actual: { achievements?: number; dx?: number; fc?: string | null; fs?: string | null }) {
  return Number(actual.achievements) + 0.000001 >= expected.achievements && Number(actual.dx) >= expected.dx &&
    combo.indexOf(actual.fc ?? "") >= combo.indexOf(expected.fc ?? "") && sync.indexOf(actual.fs ?? "") >= sync.indexOf(expected.fs ?? "")
}
export function verifyDfRecords(expected: DfUploadRecord[], response: DfPlayerRecords) {
  if (!Array.isArray(response.records)) throw new Error("水鱼未返回完整成绩数组")
  const records = new Map(response.records.map(r => [`${r.title}:${r.type}:${r.level_index}`, r]))
  const verified = expected.filter(e => {
    const actual = records.get(`${e.title}:${e.type}:${e.level_index}`)
    return actual && preserved({ ...e, dx: e.dxScore }, { ...actual, dx: actual.dxScore })
  }).length
  return { verified, total: expected.length }
}
export function verifyLxRecords(expected: LxnsUploadScore[], response: LxnsScore[]) {
  const records = new Map(response.map(r => [`${r.id}:${r.type}:${r.level_index}`, r]))
  const verified = expected.filter(e => {
    const actual = records.get(`${e.id}:${e.type}:${e.level_index}`)
    return actual && preserved({ ...e, dx: e.dx_score }, { ...actual, dx: actual.dx_score })
  }).length
  return { verified, total: expected.length }
}
