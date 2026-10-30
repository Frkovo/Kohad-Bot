// /opt 自动探测的轻量状态，供面板展示；不依赖 Discord，也不引入循环依赖。
export type WatcherState = {
  /** 0 = 关闭 */
  intervalMs: number
  running: boolean
  lastPollAt?: number
  lastPollOk?: boolean
  lastError?: string
  packages?: number
  added?: number
}

let state: WatcherState = { intervalMs: 0, running: false }

export function setWatcherInterval(intervalMs: number) {
  state = { ...state, intervalMs }
}

export function beginPoll() {
  state = { ...state, running: true }
}

export function endPoll(result: { packages: number; added: number }) {
  state = { ...state, running: false, lastPollAt: Date.now(), lastPollOk: true, lastError: undefined, ...result }
}

export function failPoll(error: unknown) {
  state = { ...state, running: false, lastPollAt: Date.now(), lastPollOk: false, lastError: error instanceof Error ? error.message : String(error) }
}

export function watcherState(): WatcherState {
  return { ...state }
}

export function resetWatcherStateForTests() {
  state = { intervalMs: 0, running: false }
}
