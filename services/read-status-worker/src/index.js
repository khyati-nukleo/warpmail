import { classify } from './classify.js'

/**
 * @typedef {{ prepare(sql: string): any, exec(sql: string): Promise<unknown> }} Database
 * @typedef {{ DB: Database, PASSWORD?: string }} Env
 * @typedef {{ waitUntil(promise: Promise<unknown>): void }} Context
 */

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const MAX_LIMIT = 1000
// Warpmail's codes are exactly 22 base64url characters; anything else is served but never written.
const CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/

// The standard 43-byte transparent 1x1 GIF.
const GIF = Uint8Array.from(
  '47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b'.match(
    /../g,
  ) ?? [],
  (byte) => parseInt(byte, 16),
)

const IMAGE_HEADERS = {
  'Content-Type': 'image/gif',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
}

/** Databases whose table already exists in this isolate. */
const ready = new WeakSet()

/** @param {Database} db */
async function ensureTable(db) {
  if (ready.has(db)) return
  await db.exec(
    'CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL)',
  )
  await db.exec('CREATE INDEX IF NOT EXISTS records_at ON records (at)')
  ready.add(db)
}

/**
 * @param {unknown} body
 * @param {number} status
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/** @param {string} text */
async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

/**
 * Constant-time comparison: compare SHA-256 digests byte by byte.
 * @param {string} a
 * @param {string} b
 */
async function sameSecret(a, b) {
  const [left, right] = await Promise.all([digest(a), digest(b)])
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i]
  return diff === 0
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Context} ctx
 * @param {string} code
 */
function record(request, env, ctx, code) {
  const ip = request.headers.get('CF-Connecting-IP') ?? ''
  const userAgent = request.headers.get('User-Agent') ?? ''
  // @ts-ignore request.cf exists only on Cloudflare
  const asn = request.cf?.asn
  // The address is used here and dropped; only the source type is stored.
  const source = classify(ip, userAgent, typeof asn === 'number' ? asn : undefined)
  ctx.waitUntil(
    ensureTable(env.DB).then(() =>
      env.DB.prepare('INSERT INTO records (code, at, source) VALUES (?, ?, ?)')
        .bind(code, Date.now(), source)
        .run(),
    ),
  )
}

/**
 * @param {Request} request
 * @param {Env} env
 */
async function listRecords(request, env) {
  if (!env.PASSWORD) return json({ error: 'not configured' }, 500)
  const header = request.headers.get('Authorization') ?? ''
  const given = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!(await sameSecret(given, env.PASSWORD))) return json({ error: 'unauthorized' }, 401)

  const params = new URL(request.url).searchParams
  const sinceValue = Number(params.get('since') ?? 0)
  const since = Number.isFinite(sinceValue) && sinceValue > 0 ? Math.floor(sinceValue) : 0
  const limitValue = Number(params.get('limit') ?? MAX_LIMIT)
  const limit =
    Number.isFinite(limitValue) && limitValue >= 1
      ? Math.min(Math.floor(limitValue), MAX_LIMIT)
      : MAX_LIMIT

  await ensureTable(env.DB)
  const { results } = await env.DB.prepare(
    'SELECT id, code, at, source FROM records WHERE id > ? ORDER BY id ASC LIMIT ?',
  )
    .bind(since, limit)
    .all()
  const records = results.map((/** @type {any} */ r) => ({
    id: r.id,
    code: r.code,
    at: r.at,
    source: r.source,
  }))
  return json({ records, next: records.length ? records[records.length - 1].id : since })
}

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {Context} ctx
   */
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url)
    const image = /^\/p\/([^/]+)\.gif$/.exec(pathname)
    if (image && (request.method === 'GET' || request.method === 'HEAD')) {
      if (request.method === 'GET' && CODE_PATTERN.test(image[1])) {
        record(request, env, ctx, image[1])
      }
      return new Response(request.method === 'HEAD' ? null : GIF, { headers: IMAGE_HEADERS })
    }
    if (pathname === '/records' && request.method === 'GET') return listRecords(request, env)
    return new Response(null, { status: 404 })
  },

  /**
   * @param {{ scheduledTime?: number }} event
   * @param {Env} env
   * @param {Context} ctx
   */
  async scheduled(event, env, ctx) {
    const now = event.scheduledTime ?? Date.now()
    ctx.waitUntil(
      ensureTable(env.DB).then(() =>
        env.DB.prepare('DELETE FROM records WHERE at < ?')
          .bind(now - RETENTION_MS)
          .run(),
      ),
    )
  },
}
