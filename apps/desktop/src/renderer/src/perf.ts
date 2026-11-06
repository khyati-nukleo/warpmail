// Warpmail perf log (temporary): renderer timings sent to the main process's perf.log.
// Only durations and flags are reported, never message content or identifiers.
import { useEffect, useRef } from 'react'

type Report = (entry: Record<string, string | number | boolean>) => void
const send: Report = (entry) => {
  try {
    ;(window as unknown as { warpmailPerf?: Report }).warpmailPerf?.(entry)
  } catch {
    // Diagnostics must never disturb the app.
  }
}
const round = (ms: number) => Math.round(ms * 10) / 10

/** Main-thread tasks over 100 ms in the renderer. */
export function observeLongTasks() {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.duration > 100) send({ op: 'renderer:longtask', ms: round(entry.duration) })
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    // Not supported here.
  }
}

/**
 * From the render that opens a thread until its messages (not the list placeholder) are on
 * screen (`renderMs`), and until its fetch has settled (`settledMs`).
 */
export function useOpenTiming(
  key: string | undefined,
  ready: boolean,
  fetching: boolean,
  failed: boolean,
) {
  const state = useRef<
    { key: string; at: number; cached: boolean; renderMs?: number; done?: boolean } | undefined
  >(undefined)
  // Measured from render, so a slow render of the opening itself is included.
  if (key && state.current?.key !== key)
    state.current = { key, at: performance.now(), cached: ready }
  if (!key) state.current = undefined
  useEffect(() => {
    const s = state.current
    if (!s || s.key !== key || s.done) return
    if (ready && s.renderMs === undefined) {
      s.renderMs = -1
      requestAnimationFrame(() => (s.renderMs = round(performance.now() - s.at)))
    }
    if ((ready || failed) && !fetching) {
      s.done = true
      requestAnimationFrame(() =>
        send({
          op: 'renderer:open',
          renderMs: s.renderMs ?? -1,
          settledMs: round(performance.now() - s.at),
          cached: s.cached,
          failed,
        }),
      )
    }
  }, [key, ready, fetching, failed])
}
