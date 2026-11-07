import { DatabaseSync } from 'node:sqlite'

type Value = string | number | null

export interface D1StatementLike {
  bind(...values: Value[]): D1StatementLike
  all(): Promise<{ results: Record<string, unknown>[] }>
  run(): Promise<{ meta: { changes: number } }>
  first(): Promise<Record<string, unknown> | null>
}

export interface D1Like {
  prepare(sql: string): D1StatementLike
  exec(sql: string): Promise<unknown>
  batch(statements: D1StatementLike[]): Promise<unknown[]>
  /** Test-only access to the underlying database. */
  raw: DatabaseSync
}

/** A small in-memory stand-in for Cloudflare D1, backed by node:sqlite. */
export function createFakeD1(): D1Like {
  const raw = new DatabaseSync(':memory:')
  const statement = (sql: string, values: Value[] = []): D1StatementLike => ({
    bind: (...next) => statement(sql, next),
    all: async () => ({ results: raw.prepare(sql).all(...values) as Record<string, unknown>[] }),
    run: async () => {
      const result = raw.prepare(sql).run(...values)
      return { meta: { changes: Number(result.changes) } }
    },
    first: async () => (raw.prepare(sql).get(...values) as Record<string, unknown>) ?? null,
  })
  return {
    prepare: (sql) => statement(sql),
    exec: async (sql) => {
      raw.exec(sql)
      return { count: 1 }
    },
    batch: async (statements) => {
      const out: unknown[] = []
      for (const s of statements) out.push(await s.run())
      return out
    },
    raw,
  }
}
