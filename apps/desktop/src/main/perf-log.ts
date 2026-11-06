// Warpmail perf log (temporary): diagnostic timing, appended as JSON lines to
// <userData>/mail/perf.log (on Windows %APPDATA%\Inlark\mail\perf.log). Remove this file and
// every line marked "Warpmail perf log (temporary)" to take it out again.
// Never log message content, subjects, email addresses or passwords: only operation names,
// account IDs, folder paths, counts, codes and durations.
import { appendFileSync } from 'node:fs'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const round = (ms: number) => Math.round(ms * 10) / 10

export class PerfLog {
  private buffer: string[] = []
  private size: number | undefined
  private writing: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(
    readonly path: string,
    private readonly maxBytes = 5_000_000,
    private readonly flushMs = 1000,
  ) {}
  log(op: string, fields: Record<string, unknown> = {}) {
    try {
      this.buffer.push(JSON.stringify({ t: new Date().toISOString(), op, ...fields }) + '\n')
    } catch {
      return
    }
    if (this.buffer.length >= 500) void this.flush()
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushMs)
      this.timer.unref?.()
    }
  }
  /** Writes buffered lines in order; at the size cap the file moves to perf.log.1 first. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.buffer.length) return this.writing
    const chunk = this.buffer.join('')
    this.buffer = []
    this.writing = this.writing.then(async () => {
      try {
        const bytes = Buffer.byteLength(chunk)
        if (this.size === undefined) {
          await mkdir(dirname(this.path), { recursive: true })
          this.size = await stat(this.path).then(
            (s) => s.size,
            () => 0,
          )
        }
        if (this.size + bytes > this.maxBytes) {
          await rename(this.path, this.path + '.1').catch(() => {})
          this.size = 0
        }
        await appendFile(this.path, chunk)
        this.size += bytes
      } catch {
        // Diagnostics must never disturb the app.
      }
    })
    return this.writing
  }
  /** For process exit, when an async write would not finish. */
  flushSync() {
    if (!this.buffer.length) return
    try {
      appendFileSync(this.path, this.buffer.join(''))
    } catch {
      // Ignore.
    }
    this.buffer = []
  }
}

let current: PerfLog | undefined
export function perf(op: string, fields: Record<string, unknown> = {}) {
  current?.log(op, fields)
}
/** Times `fn` and logs `op` with its duration and whether it succeeded. */
export async function perfTimed<T>(
  op: string,
  fn: () => T | Promise<T>,
  fields: Record<string, unknown> = {},
): Promise<T> {
  const start = performance.now()
  let ok = false
  try {
    const result = await fn()
    ok = true
    return result
  } finally {
    perf(op, { ...fields, ms: round(performance.now() - start), ok })
  }
}
/** A multi-step operation: `mark(step)` records the time since the previous mark. */
export function perfSpan(op: string, fields: Record<string, unknown> = {}) {
  const start = performance.now()
  let last = start
  let ended = false
  const steps: Record<string, number> = {}
  return {
    mark(step: string) {
      const now = performance.now()
      steps[step + 'Ms'] = round((steps[step + 'Ms'] || 0) + now - last)
      last = now
    },
    end(extra: Record<string, unknown> = {}) {
      if (ended) return
      ended = true
      perf(op, { ...fields, ...extra, totalMs: round(performance.now() - start), ...steps })
    },
  }
}
/** Logs main-thread stalls over `thresholdMs` and a once-a-minute event-loop delay summary. */
export function monitorStalls(thresholdMs = 100, intervalMs = 50) {
  let expected = performance.now() + intervalMs
  const tick = setInterval(() => {
    const now = performance.now()
    const late = now - expected
    if (late > thresholdMs) perf('main:stall', { ms: round(late) })
    expected = now + intervalMs
  }, intervalMs)
  tick.unref?.()
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  const summary = setInterval(() => {
    perf('main:eventloop', {
      meanMs: round(histogram.mean / 1e6),
      p99Ms: round(histogram.percentile(99) / 1e6),
      maxMs: round(histogram.max / 1e6),
    })
    histogram.reset()
  }, 60_000)
  summary.unref?.()
  return () => {
    clearInterval(tick)
    clearInterval(summary)
    histogram.disable()
  }
}
export function startPerfLog(directory: string, fields: Record<string, unknown> = {}) {
  current = new PerfLog(join(directory, 'perf.log'))
  perf('perf:start', {
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    ...fields,
  })
  monitorStalls()
  process.once('exit', () => current?.flushSync())
  return current
}
/** Renderer reports arrive over IPC; only known operations and numeric fields pass. */
export function rendererPerf(entry: unknown) {
  if (!entry || typeof entry !== 'object') return
  const { op, ...rest } = entry as Record<string, unknown>
  if (op !== 'renderer:open' && op !== 'renderer:longtask') return
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest).slice(0, 8))
    if (/^[a-zA-Z]{1,24}$/.test(key) && (typeof value === 'number' || typeof value === 'boolean'))
      fields[key] = value
  perf(op, fields)
}
