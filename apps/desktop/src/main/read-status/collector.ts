import type { FetchRecord } from '@inlark/core'
import type { JsonStore } from '../storage'
import { fetchRecords, WorkerError, type WorkerRecord } from './worker-client'

interface Data {
  base?: string
  cursor: number
  records: WorkerRecord[]
}
interface Options {
  fetch?: typeof fetch
  now?: () => number
  intervalMs?: number
  maxBackoffMs?: number
}

const name = 'read-status'
const retention = 90 * 24 * 60 * 60 * 1000
const pageSize = 1000

/** Polls the Worker for image fetches and keeps them in the app's own store file. */
export class ReadStatusCollector {
  private data: Data = { cursor: 0, records: [] }
  private byCode = new Map<string, FetchRecord[]>()
  private ready: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private rerun = false
  private started = false
  private failures = 0
  private lastCollectedAt?: string
  private error?: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly maxBackoffMs: number

  constructor(
    private readonly store: JsonStore,
    private readonly config: () => { base?: string; password?: string },
    private readonly onChange: () => void,
    options: Options = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.intervalMs = options.intervalMs ?? 120_000
    this.maxBackoffMs = options.maxBackoffMs ?? 1_800_000
    this.ready = this.store.read<Data>(name, this.data).then(
      (saved) => {
        this.data = { cursor: saved.cursor ?? 0, base: saved.base, records: saved.records ?? [] }
        this.index()
      },
      () => {},
    )
  }

  start(): void {
    this.started = true
    void this.collectNow()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Joins a run in progress, which then runs once more so new settings take effect. */
  collectNow(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.rerun = false
        await this.collect()
      } while (this.rerun)
    })().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  fetches(code: string): FetchRecord[] {
    return this.byCode.get(code) ?? []
  }

  info(): { lastCollectedAt?: string; error?: string } {
    return { lastCollectedAt: this.lastCollectedAt, error: this.error }
  }

  private index() {
    this.byCode = new Map()
    for (const r of this.data.records) {
      const list = this.byCode.get(r.code) ?? []
      list.push({ at: r.at, source: r.source })
      this.byCode.set(r.code, list)
    }
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.started) this.timer = setTimeout(() => void this.collectNow(), delay)
  }

  private async collect(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.ready
    const { base, password } = this.config()
    const before = this.error
    let added = false
    let dirty = false
    let delay = this.intervalMs
    if (!base || !password) {
      this.error = undefined
      this.failures = 0
    } else {
      if (this.data.base !== base) {
        this.data = { base, cursor: 0, records: [] }
        this.index()
        added = true
        dirty = true
      }
      const seen = new Set(this.data.records.map((r) => r.id))
      const oldest = this.now() - retention
      try {
        for (;;) {
          const { records, next } = await fetchRecords(
            base,
            password,
            this.data.cursor,
            this.fetchImpl,
          )
          for (const r of records) {
            if (seen.has(r.id) || r.at < oldest) continue
            seen.add(r.id)
            this.data.records.push(r)
            added = true
          }
          const advanced = next > this.data.cursor
          if (advanced) dirty = true
          this.data.cursor = Math.max(this.data.cursor, next)
          if (records.length < pageSize || !advanced) break
        }
        this.error = undefined
        this.failures = 0
        this.lastCollectedAt = new Date(this.now()).toISOString()
      } catch (error) {
        this.error =
          error instanceof WorkerError ? error.message : 'Read status could not be collected.'
        this.failures += 1
        delay = Math.min(this.intervalMs * 2 ** this.failures, this.maxBackoffMs)
      }
      const kept = this.data.records.filter((r) => r.at >= oldest)
      if (kept.length !== this.data.records.length) {
        this.data.records = kept
        dirty = true
      }
      if (added || dirty) this.index()
      if (dirty || added) await this.store.write(name, this.data).catch(() => {})
    }
    this.schedule(delay)
    if (added || this.error !== before) this.onChange()
  }
}
