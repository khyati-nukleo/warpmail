// Warpmail perf log (temporary): remove with apps/desktop/src/main/perf-log.ts.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PerfLog } from '../apps/desktop/src/main/perf-log'
import { setImapPerfLogger, timedPorts, type ImapPort } from '@inlark/imap'

const dirs: string[] = []
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-log-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  setImapPerfLogger(undefined)
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('perf log', () => {
  it('appends buffered JSON lines with a timestamp and operation', async () => {
    const log = new PerfLog(join(await temp(), 'mail', 'perf.log'))
    log.log('ipc', { channel: 'conversation', ms: 12.5 })
    log.log('imap:task', { label: 'withBodies', waitMs: 3 })
    await log.flush()
    const lines = (await readFile(log.path, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toMatchObject([
      { op: 'ipc', channel: 'conversation', ms: 12.5 },
      { op: 'imap:task', label: 'withBodies', waitMs: 3 },
    ])
    expect(Date.parse(lines[0].t)).not.toBeNaN()
  })

  it('moves the file aside at the size cap', async () => {
    const log = new PerfLog(join(await temp(), 'perf.log'), 300)
    for (let i = 0; i < 10; i++) {
      log.log('x', { i, pad: 'p'.repeat(40) })
      await log.flush()
    }
    expect((await stat(log.path)).size).toBeLessThanOrEqual(300)
    expect((await stat(log.path + '.1')).size).toBeLessThanOrEqual(300)
  })

  it('times every port call and connection event', async () => {
    const events: [string, Record<string, unknown>][] = []
    setImapPerfLogger((op, fields) => events.push([op, fields]))
    let close = () => {}
    const fake = {
      capabilities: new Set<string>(),
      condstore: false,
      connect: async () => {},
      close: async () => close(),
      on: (event: string, listener: () => void) => {
        if (event === 'close') close = listener
      },
      select: async (path: string) => ({ path, uidValidity: '1', uidNext: 1, exists: 0 }),
      status: async () => {
        throw Object.assign(new Error('boom'), { code: 'network' })
      },
    } as unknown as ImapPort
    const port = timedPorts(() => fake)({} as never, 'command')
    await port.connect()
    await port.select('INBOX')
    await expect(port.status('INBOX')).rejects.toThrow('boom')
    await port.close()
    expect(events.map(([op, f]) => [op, f.method ?? f.reason ?? f.ok])).toEqual([
      ['imap:connect-start', undefined],
      ['imap:connect', true],
      ['imap:port', 'select'],
      ['imap:port', 'status'],
      ['imap:closed', 'client-close'],
      ['imap:port', 'close'],
    ])
    expect(events[2][1]).toMatchObject({ path: 'INBOX', ok: true, purpose: 'command' })
    expect(events[3][1]).toMatchObject({ ok: false, code: 'network' })
  })
})
