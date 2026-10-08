import type { MigrateSuccess } from "../migrate-client.js"
import type { LxnsPlayer } from "../lxns/client.js"
import { t } from "../messages.js"

export type PlayerProfile = { name: string; iconId?: number; nameplateId?: number; rating?: number }

function positiveId(...values: unknown[]) {
  for (const value of values) {
    const n = Number(value)
    if (Number.isSafeInteger(n) && n > 0) return n
  }
  return undefined
}

/** GetUserData is returned either as an object or as a one-element userData array. */
export function extractPlayerProfile(result: MigrateSuccess): PlayerProfile {
  const raw = result.data.pull.userData
  const inner = raw && typeof raw === "object" && "userData" in raw ? raw.userData : raw
  const first = Array.isArray(inner) ? inner[0] : inner
  const data = first && typeof first === "object" ? first as Record<string, unknown> : {}
  return {
    name: typeof data.userName === "string" && data.userName.trim() ? data.userName : result.source.userName ?? t("value.unknownPlayer"),
    iconId: positiveId(data.iconId, result.source.iconId),
    // GetUserData.UserDetail uses plateId; GetUserPreview uses nameplateId.
    nameplateId: positiveId(data.plateId, data.nameplateId, result.source.nameplateId),
    rating: positiveId(data.playerRating, result.source.playerRating),
  }
}

export function lxPlayerProfile(player: LxnsPlayer, local?: PlayerProfile): PlayerProfile {
  return { name: local?.name ?? player.name, iconId: local?.iconId ?? positiveId(player.icon?.id),
    nameplateId: local?.nameplateId ?? positiveId(player.name_plate?.id), rating: local?.rating ?? player.rating }
}
