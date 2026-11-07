import { describe, expect, it } from 'vitest'
import worker from '../services/read-status-worker/src/index.js'
import { inRanges } from '../services/read-status-worker/src/classify.js'
import { createFakeD1 } from './support/fake-d1'

const CODE = 'AbCdEfGhIjKlMnOpQrStUv'
const DAY = 24 * 60 * 60 * 1000

function setup(password: string | null = 'test-password') {
  const DB = createFakeD1()
  const env = { DB, PASSWORD: password ?? undefined }
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
  const call = async (path: string, init: RequestInit & { cf?: unknown } = {}) => {
    const request = new Request(`https://read.example.com${path}`, init)
    // Cloudflare attaches request.cf; Node's Request ignores it in init.
    if (init.cf) Object.defineProperty(request, 'cf', { value: init.cf })
    const res = await worker.fetch(request, env, ctx)
    await Promise.all(pending)
    return res
  }
  const rows = () => {
    const table = DB.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'records'").get()
    if (!table) return []
    return DB.raw.prepare('SELECT id, code, at, source FROM records ORDER BY id').all() as {
      id: number
      code: string
      at: number
      source: string
    }[]
  }
  return { DB, env, ctx, call, rows }
}

const auth = { Authorization: 'Bearer test-password' }

describe('read status worker', () => {
  it('serves a no-cache GIF and records time and source', async () => {
    const { call, rows, DB } = setup()
    const before = Date.now()
    const res = await call(`/p/${CODE}.gif`, { headers: { 'CF-Connecting-IP': '17.58.0.1' } })
    const after = Date.now()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/gif')
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(res.headers.get('Pragma')).toBe('no-cache')
    expect(res.headers.get('Expires')).toBe('0')
    expect((await res.arrayBuffer()).byteLength).toBe(43)
    const all = rows()
    expect(all).toHaveLength(1)
    expect(all[0].code).toBe(CODE)
    expect(all[0].source).toBe('apple')
    expect(all[0].at).toBeGreaterThanOrEqual(before)
    expect(all[0].at).toBeLessThanOrEqual(after)
    const columns = DB.raw.prepare('PRAGMA table_info(records)').all() as { name: string }[]
    expect(columns.map((c) => c.name)).toEqual(['id', 'code', 'at', 'source'])
  })

  it("classifies Google's image proxy and others", async () => {
    const { call, rows } = setup()
    await call(`/p/${CODE}.gif`, {
      headers: {
        'CF-Connecting-IP': '203.0.113.9',
        'User-Agent': 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)',
      },
    })
    await call(`/p/${CODE}.gif`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } })
    await call(`/p/${CODE}.gif`, {
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
      cf: { asn: 714 },
    })
    expect(rows().map((r) => r.source)).toEqual(['google', 'other', 'apple'])
  })

  it('does not record malformed codes or HEAD requests but still serves the image', async () => {
    const { call, rows } = setup()
    const short = await call('/p/short.gif')
    const bad = await call(`/p/${'a'.repeat(21)}!.gif`)
    // App codes are exactly 22 base64url characters; anything else is never written.
    const lengths = await Promise.all([16, 21, 23, 64].map((n) => call(`/p/${'a'.repeat(n)}.gif`)))
    const head = await call(`/p/${CODE}.gif`, { method: 'HEAD' })
    expect(short.status).toBe(200)
    expect(bad.status).toBe(200)
    for (const res of lengths) {
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('image/gif')
      expect((await res.arrayBuffer()).byteLength).toBe(43)
    }
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Type')).toBe('image/gif')
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    expect(rows()).toHaveLength(0)
  })

  it('returns 404 for anything else', async () => {
    const { call } = setup()
    const res = await call('/nothing')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
  })

  it('returns records after a cursor, oldest first, behind the password', async () => {
    const { call } = setup()
    for (let i = 0; i < 3; i++) await call(`/p/${CODE}.gif`)
    const first = await (await call('/records?since=0', { headers: auth })).json()
    expect(first.records).toHaveLength(3)
    expect(first.records.map((r: { id: number }) => r.id)).toEqual(
      [...first.records.map((r: { id: number }) => r.id)].sort((a, b) => a - b),
    )
    expect(first.records[0]).toEqual({
      id: expect.any(Number),
      code: CODE,
      at: expect.any(Number),
      source: 'other',
    })
    expect(first.next).toBe(first.records[2].id)
    const none = await (await call(`/records?since=${first.next}`, { headers: auth })).json()
    expect(none).toEqual({ records: [], next: first.next })
    const two = await (await call('/records?since=0&limit=2', { headers: auth })).json()
    expect(two.records).toHaveLength(2)
    expect(two.next).toBe(two.records[1].id)
  })

  it('rejects a missing or wrong password with 401', async () => {
    const { call } = setup()
    const missing = await call('/records?since=0')
    expect(missing.status).toBe(401)
    expect(await missing.json()).toEqual({ error: 'unauthorized' })
    const wrong = await call('/records?since=0', { headers: { Authorization: 'Bearer nope' } })
    expect(wrong.status).toBe(401)
  })

  it('answers 500 when PASSWORD is not set', async () => {
    const { call } = setup(null)
    const res = await call('/records?since=0', { headers: auth })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'not configured' })
  })

  it('the scheduled job deletes records older than 90 days', async () => {
    const { call, env, ctx, rows } = setup()
    await call(`/p/${CODE}.gif`) // creates the table
    const now = Date.now()
    env.DB.raw.exec('DELETE FROM records')
    const insert = env.DB.raw.prepare('INSERT INTO records (code, at, source) VALUES (?, ?, ?)')
    insert.run('old', now - 91 * DAY, 'other')
    insert.run('new', now - 89 * DAY, 'other')
    await worker.scheduled({ scheduledTime: now }, env, ctx)
    expect(rows().map((r) => r.code)).toEqual(['new'])
  })
})

describe('inRanges', () => {
  it.each([
    ['17.0.0.1', ['17.0.0.0/8'], true],
    ['18.0.0.1', ['17.0.0.0/8'], false],
    ['2620:149::1', ['2620:149::/32'], true],
    ['2620:14a::1', ['2620:149::/32'], false],
    ['::ffff:17.1.2.3', ['17.0.0.0/8'], true],
    ['not an ip', ['17.0.0.0/8'], false],
    ['', ['17.0.0.0/8'], false],
    ['17.0.0.1', ['garbage'], false],
  ])('%s in %j -> %s', (ip, ranges, expected) => {
    expect(inRanges(ip, ranges)).toBe(expected)
  })
})
