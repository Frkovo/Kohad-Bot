// DXRating-compatible NET policy; the existing CN policy remains separate.
// Reference: gekichumai/dxrating (MIT), pinned in assets/data/dxdata-source.json.
const coefficients: [number, number][] = [[0,0],[100000,16],[200000,32],[300000,48],[400000,64],[500000,80],[600000,96],[700000,112],[750000,120],[799999,128],[800000,136],[900000,152],[940000,168],[969999,176],[970000,200],[980000,203],[989999,206],[990000,208],[995000,211],[999999,214],[1000000,216],[1004999,222],[1005000,224]]
export function netRating(ds: number, achievement: number, fc: string) {
  const units = Math.min(1005000, Math.max(0, Math.round(achievement)))
  const multiplier = [...coefficients].reverse().find(([boundary]) => units >= boundary)?.[1] ?? 0
  return Math.floor(Math.round(ds * 10) * units * multiplier / 100000000) + (["ap", "app"].includes(fc) ? 1 : 0)
}
