import { workerBase, type FetchSource } from '@inlark/core'

export interface WorkerRecord {
  id: number
  code: string
  at: number
  source: FetchSource
}

/** An error whose message is safe to show: it never carries the password or server text. */
export class WorkerError extends Error {}

const messages = {
  password: "The Worker didn't accept the password.",
  unreachable: "The Worker address didn't answer. Check it and your connection.",
  unexpected: 'The Worker answered with something unexpected.',
}
const sources: readonly string[] = ['apple', 'google', 'other']
const limit = 1000

export async function fetchRecords(
  base: string,
  password: string,
  since: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ records: WorkerRecord[]; next: number }> {
  let response: Response
  try {
    response = await fetchImpl(`${base}/records?since=${since}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${password}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new WorkerError(messages.unreachable)
  }
  if (response.status === 401) throw new WorkerError(messages.password)
  if (!response.ok) throw new WorkerError(messages.unexpected)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new WorkerError(messages.unexpected)
  }
  const { records, next } = (body ?? {}) as { records?: unknown; next?: unknown }
  if (!Array.isArray(records) || typeof next !== 'number' || !Number.isFinite(next))
    throw new WorkerError(messages.unexpected)
  const clean: WorkerRecord[] = []
  for (const item of records) {
    const r = (item ?? {}) as Record<string, unknown>
    if (
      typeof r.id !== 'number' ||
      !Number.isFinite(r.id) ||
      typeof r.code !== 'string' ||
      typeof r.at !== 'number' ||
      !Number.isFinite(r.at)
    )
      throw new WorkerError(messages.unexpected)
    clean.push({
      id: r.id,
      code: r.code,
      at: r.at,
      source: sources.includes(r.source as string) ? (r.source as FetchSource) : 'other',
    })
  }
  return { records: clean, next }
}

export async function testWorker(
  address: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  const base = workerBase(address)
  if (!base) return { ok: false, message: "Enter the Worker's https address." }
  try {
    // Asking after the last possible id checks the address and password without moving any data.
    await fetchRecords(base, password, Number.MAX_SAFE_INTEGER, fetchImpl)
    return { ok: true, message: 'Connected. The Worker accepted the password.' }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof WorkerError ? error.message : messages.unexpected,
    }
  }
}
