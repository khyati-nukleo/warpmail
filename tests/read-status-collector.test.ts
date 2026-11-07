import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(Buffer.from(value).reverse()),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString(),
  },
  dialog: {},
  shell: {},
  Notification: { isSupported: () => false },
}))
import { JsonStore } from '../apps/desktop/src/main/storage'
import { MailService } from '../apps/desktop/src/main/service'
import { ReadStatusCollector } from '../apps/desktop/src/main/read-status/collector'
import { imageCode, trackedMessageId } from '../apps/desktop/src/main/read-status/codes'
import { testWorker } from '../apps/desktop/src/main/read-status/worker-client'

const base = 'https://read.example.com'
const password = 'test-password'
const DAY = 24 * 60 * 60 * 1000
const unreachable = "The Worker address didn't answer. Check it and your connection."
const wrongPassword = "The Worker didn't accept the password."
const unexpected = 'The Worker answered with something unexpected.'
const NOW = Date.UTC(2026, 10, 6, 12)

type Rec = { id: number; code: string; at: number; source: string }
const rec = (id: number, code = 'code-' + id, at = NOW - 1000): Rec => ({
  id,
  code,
  at,
  source: 'other',
})
const page = (records: Rec[]) =>
  new Response(
    JSON.stringify({ records, next: records.length ? records[records.length - 1].id : 0 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )

/** Serves `all` the way the Worker does: records after `since`, at most `limit` per page. */
function worker(all: Rec[]) {
  const calls: string[] = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(url.search)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + password)
    const since = Number(url.searchParams.get('since'))
    const limit = Number(url.searchParams.get('limit'))
    return page(all.filter((r) => r.id > since).slice(0, limit))
  })
  return { impl: impl as unknown as typeof fetch, calls, mock: impl }
}

let directory: string
let store: JsonStore
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'inlark-read-status-collector-'))
  store = new JsonStore(directory)
  await store.init()
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

/** Fake timers do not drive file I/O, so the backoff test keeps its records in memory. */
const memoryStore = () => {
  const files = new Map<string, unknown>()
  return {
    read: async (name: string, fallback: unknown) => files.get(name) ?? fallback,
    write: async (name: string, value: unknown) => void files.set(name, value),
  } as unknown as JsonStore
}
const make = (
  fetchImpl: typeof fetch,
  config: () => { base?: string; password?: string } = () => ({ base, password }),
  onChange = vi.fn(),
  where: JsonStore = store,
) => ({
  onChange,
  collector: new ReadStatusCollector(where, config, onChange, {
    fetch: fetchImpl,
    now: () => NOW,
  }),
})

describe('collector', () => {
  it('collects new records after the cursor and persists them', async () => {
    const all = Array.from({ length: 1003 }, (_, i) => rec(i + 1, i < 3 ? 'abc' : undefined))
    const { impl, calls } = worker(all)
    const { collector, onChange } = make(impl)
    await collector.collectNow()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('since=1000')
    expect(collector.fetches('abc')).toEqual([
      { at: NOW - 1000, source: 'other' },
      { at: NOW - 1000, source: 'other' },
      { at: NOW - 1000, source: 'other' },
    ])
    expect(onChange).toHaveBeenCalledTimes(1)
    const saved = await store.read<any>('read-status', {})
    expect(saved.records).toHaveLength(1003)
    expect(saved.cursor).toBe(1003)
    expect(saved.base).toBe(base)

    const second = make(worker([]).impl)
    await second.collector.collectNow()
    expect(second.collector.fetches('abc')).toHaveLength(3)
    expect(second.onChange).not.toHaveBeenCalled()
    expect(second.collector.info().lastCollectedAt).toBeTruthy()
  })

  it('de-duplicates and drops records older than 90 days', async () => {
    const all = [rec(1, 'a'), rec(2, 'a', NOW - 91 * DAY), rec(3, 'a', NOW - 89 * DAY)]
    const { collector } = make(worker(all).impl)
    await collector.collectNow()
    expect(collector.fetches('a')).toHaveLength(2)
    // The same ids served again (cursor lost) are not stored twice.
    await store.write('read-status', {
      ...(await store.read<any>('read-status', {})),
      cursor: 0,
    })
    const again = make(worker(all).impl)
    await again.collector.collectNow()
    expect(again.collector.fetches('a')).toHaveLength(2)
  })

  it('backs off when the Worker is unreachable and keeps existing records', async () => {
    vi.useFakeTimers()
    let up = true
    const good = worker([rec(1, 'a')])
    const impl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (!up) throw new TypeError('fetch failed')
      return good.impl(...args)
    }) as unknown as typeof fetch
    const { collector, onChange } = make(impl, () => ({ base, password }), vi.fn(), memoryStore())
    collector.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(collector.info().error).toBeUndefined()
    const calls = () => (impl as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    expect(calls()).toBe(1)
    up = false
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls()).toBe(2)
    expect(collector.info().error).toBe(unreachable)
    expect(collector.fetches('a')).toHaveLength(1)
    const changes = onChange.mock.calls.length
    for (const [wait, expected] of [
      [240_000, 3],
      [480_000, 4],
      [960_000, 5],
      [1_800_000, 6],
      [1_800_000, 7],
    ] as const) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(calls()).toBe(expected - 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls()).toBe(expected)
    }
    // The error did not change, so nobody was told again.
    expect(onChange.mock.calls.length).toBe(changes)
    up = true
    await vi.advanceTimersByTimeAsync(1_800_000)
    expect(calls()).toBe(8)
    expect(collector.info().error).toBeUndefined()
    await vi.advanceTimersByTimeAsync(119_999)
    expect(calls()).toBe(8)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls()).toBe(9)
    collector.stop()
    await vi.advanceTimersByTimeAsync(10_000_000)
    expect(calls()).toBe(9)
  })

  it('reports a wrong password and junk answers plainly', async () => {
    const answers = [
      [new Response('{"error":"unauthorized"}', { status: 401 }), wrongPassword],
      [new Response('<html>Welcome</html>', { status: 200 }), unexpected],
      [new Response('{"records":"nope"}', { status: 200 }), unexpected],
      [new Response('oops', { status: 502 }), unexpected],
    ] as const
    for (const [response, message] of answers) {
      const { collector } = make((async () => response) as unknown as typeof fetch)
      await collector.collectNow()
      expect(collector.info().error).toBe(message)
      expect(message).not.toContain(password)
    }
  })

  it('a new Worker address starts over', async () => {
    let current = base
    const { impl } = worker([rec(1, 'a'), rec(2, 'a')])
    const { collector } = make(impl, () => ({ base: current, password }))
    await collector.collectNow()
    expect(collector.fetches('a')).toHaveLength(2)
    current = 'https://other.example.org'
    const empty = worker([rec(1, 'b')])
    const next = make(empty.impl, () => ({ base: current, password }))
    await next.collector.collectNow()
    expect(next.collector.fetches('a')).toHaveLength(0)
    expect(next.collector.fetches('b')).toHaveLength(1)
    expect(empty.calls[0]).toContain('since=0')
    const saved = await store.read<any>('read-status', {})
    expect(saved.base).toBe(current)
  })

  it('does nothing without an address or password, and clears the error', async () => {
    let config: { base?: string; password?: string } = { base, password }
    const impl = vi.fn(async () => new Response('x', { status: 401 })) as unknown as typeof fetch
    const { collector } = make(impl, () => config)
    await collector.collectNow()
    expect(collector.info().error).toBe(wrongPassword)
    config = { base }
    await collector.collectNow()
    expect(collector.info().error).toBeUndefined()
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('never runs two collections at once', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const impl = vi.fn(async () => {
      await gate
      return page([])
    }) as unknown as typeof fetch
    const { collector } = make(impl)
    const first = collector.collectNow()
    const second = collector.collectNow()
    release()
    await Promise.all([first, second])
    expect(impl).toHaveBeenCalledTimes(1)
  })
})

describe('testWorker', () => {
  it('never puts the password in its message', async () => {
    const failures = [
      async () => new Response('{}', { status: 401 }),
      async () => {
        throw new Error('connect failed for ' + password)
      },
      async () => new Response('<html>' + password + '</html>', { status: 200 }),
    ]
    for (const failure of failures) {
      const result = await testWorker(base, password, failure as unknown as typeof fetch)
      expect(result.ok).toBe(false)
      expect(result.message).not.toContain(password)
    }
    const ok = await testWorker(base, password, worker([]).impl)
    expect(ok).toEqual({ ok: true, message: 'Connected. The Worker accepted the password.' })
    expect(await testWorker('not a url', password, worker([]).impl)).toEqual({
      ok: false,
      message: "Enter the Worker's https address.",
    })
  })
})

describe('service lookups', () => {
  it('readStatus returns null for untracked emails and per-recipient fetches for tracked ones', async () => {
    const tracked = trackedMessageId(password, 'example.com')
    const alex = 'alex@example.org'
    const sam = 'sam@example.org'
    const code = imageCode(password, tracked, alex)
    const fetchImpl = worker([
      { id: 1, code, at: NOW - 5000, source: 'google' },
      { id: 2, code: imageCode(password, 'other-id', sam), at: NOW - 4000, source: 'apple' },
    ]).impl
    const service = new MailService(store, () => {}, { readStatusFetch: fetchImpl })
    await service.init()
    try {
      await service.setSettings({
        ...service.settings,
        readStatus: { enabled: true, workerUrl: base },
      })
      expect(await service.readStatus([{ messageId: tracked, recipients: [alex] }])).toEqual([null])
      expect(await service.readStatusInfo()).toMatchObject({ passwordSet: false })
      expect(await service.setReadStatusPassword(password)).toMatchObject({ passwordSet: true })
      await vi.waitFor(async () =>
        expect((await service.readStatusInfo()).lastCollectedAt).toBeTruthy(),
      )
      const result = await service.readStatus([
        { messageId: tracked, recipients: ['Alex@Example.org', sam] },
        { messageId: 'plain@example.com', recipients: [alex] },
      ])
      expect(result).toEqual([
        {
          recipients: [
            { email: alex, fetches: [{ at: NOW - 5000, source: 'google' }] },
            { email: sam, fetches: [] },
          ],
        },
        null,
      ])
      await service.setSettings({ ...service.settings, readStatus: { enabled: false } })
      expect(await service.readStatus([{ messageId: tracked, recipients: [alex] }])).toEqual([null])
    } finally {
      service.dispose()
    }
  })
})
