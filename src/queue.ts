// Bounded FIFO scheduler. Only the machine read occupies a slot; prober sync and
// image rendering continue independently. enqueue returns null when full.
export function createQueue(maxPending: number, concurrency = 1) {
  concurrency = Math.max(1, Math.min(maxPending, Math.floor(concurrency)))
  const waiting: (() => void)[] = []
  let pending = 0, active = 0
  function drain() { while (active < concurrency && waiting.length) waiting.shift()!() }
  return {
    get pending() { return pending },
    get active() { return active },
    get concurrency() { return concurrency },
    enqueue<T>(fn: () => Promise<T>): Promise<T> | null {
      if (pending >= maxPending) return null
      pending++
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          active++
          Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pending--; drain() })
        })
        drain()
      })
    },
  }
}
