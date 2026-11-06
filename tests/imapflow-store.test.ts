import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createServer, type TLSSocket } from 'node:tls'
import { ImapFlowPort } from '../packages/imap/src/imapflow-port'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url))
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

/**
 * A CONDSTORE server that parses STORE the way Gmail does: the UNCHANGEDSINCE modifier must
 * come right after the sequence set (RFC 7162), and any other order is a syntax error.
 * Records every STORE line exactly as sent.
 */
async function condstoreServer(options: { modseq?: number; refuseStore?: boolean } = {}) {
  const modseq = options.modseq ?? 414517
  const stores: string[] = []
  const sockets = new Set<TLSSocket>()
  const capability = 'IMAP4rev1 ENABLE CONDSTORE UIDPLUS MOVE'
  const server = createServer(
    { key: fixture('server.key'), cert: fixture('server.crt') },
    (socket) => {
      sockets.add(socket)
      socket.on('error', () => socket.destroy())
      socket.write(`* OK [CAPABILITY ${capability}] Ready\r\n`)
      let buffer = ''
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('latin1')
        for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const [tag, ...rest] = line.split(' ')
          const command = rest.join(' ')
          const name = (rest[0] || '').toUpperCase()
          const reply = (text: string) => socket.write(text + '\r\n')
          if (name === 'CAPABILITY') reply(`* CAPABILITY ${capability}`)
          if (name === 'ENABLE') reply('* ENABLED CONDSTORE')
          if (name === 'SELECT' || name === 'EXAMINE') {
            reply('* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen)')
            reply('* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen \\*)] Flags')
            reply('* 1 EXISTS')
            reply('* OK [UIDVALIDITY 1] UIDs')
            reply('* OK [UIDNEXT 1841] Next')
            reply(`* OK [HIGHESTMODSEQ ${modseq}] Modseq`)
            reply(`${tag} OK [READ-WRITE] Selected`)
            continue
          }
          if (name === 'UID' && /^UID STORE /i.test(command)) {
            stores.push(command)
            const conditional =
              /^UID STORE ([\d,:]+) \(UNCHANGEDSINCE (\d+)\) [+-]FLAGS \(.*\)$/i.exec(command)
            if (options.refuseStore) reply(`${tag} NO Store refused`)
            else if (!conditional && /UNCHANGEDSINCE/i.test(command))
              reply(`${tag} BAD Could not parse command`)
            else if (conditional && modseq > Number(conditional[2]))
              reply(`${tag} OK [MODIFIED ${conditional[1]}] Conditional STORE failed`)
            else reply(`${tag} OK Store completed`)
            continue
          }
          if (name === 'LOGOUT') reply('* BYE Logging out')
          reply(`${tag} OK Done`)
          if (name === 'LOGOUT') socket.end()
        }
      })
    },
  )
  server.on('tlsClientError', () => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    sockets.forEach((s) => s.destroy())
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const port = new ImapFlowPort(
    {
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      security: 'tls',
      username: 'user',
      password: 'secret',
      timeoutMs: 3000,
      tls: { ca: fixture('ca.crt') },
    },
    'command',
  )
  await port.connect()
  closers.unshift(() => port.close())
  await port.select('INBOX')
  return { port, stores }
}

describe('ImapFlow conditional STORE', () => {
  it('sends UNCHANGEDSINCE before the flag change, as RFC 7162 and Gmail require', async () => {
    const { port, stores } = await condstoreServer()
    expect(port.condstore).toBe(true)
    await expect(port.store([1840], 'add', ['\\Seen'], '414517')).resolves.toBe(true)
    await expect(port.store([1840, 1841], 'remove', ['\\Flagged'], '414517')).resolves.toBe(true)
    await expect(port.store([1840], 'add', ['\\Flagged'])).resolves.toBe(true)
    expect(stores).toEqual([
      'UID STORE 1840 (UNCHANGEDSINCE 414517) +FLAGS (\\Seen)',
      'UID STORE 1840,1841 (UNCHANGEDSINCE 414517) -FLAGS (\\Flagged)',
      'UID STORE 1840 +FLAGS (\\Flagged)',
    ])
  })
  it('leaves a concurrent change ([MODIFIED]) for the caller to detect by re-reading flags', async () => {
    const { port, stores } = await condstoreServer({ modseq: 414600 })
    await expect(port.store([1840], 'add', ['\\Seen'], '414517')).resolves.toBe(true)
    expect(stores).toEqual(['UID STORE 1840 (UNCHANGEDSINCE 414517) +FLAGS (\\Seen)'])
  })
  it('reports a STORE the server refused as an error instead of a silent success', async () => {
    const { port } = await condstoreServer({ refuseStore: true })
    await expect(port.store([1840], 'add', ['\\Seen'], '414517')).rejects.toMatchObject({
      code: 'command',
    })
    await expect(port.store([1840], 'add', ['\\Seen'])).rejects.toMatchObject({ code: 'command' })
  })
})

describe('ImapFlow results that mean nothing was found', () => {
  const port = () =>
    new ImapFlowPort(
      { host: '127.0.0.1', port: 993, security: 'tls', username: 'u', password: 'x' },
      'command',
    )
  it('treats a download with no content as a missing message or part', async () => {
    const p = port()
    vi.spyOn((p as any).client, 'download').mockResolvedValue({})
    vi.spyOn(p, 'fetch').mockResolvedValue([{ uid: 7, size: 10 }])
    await expect(p.source(7, 100)).resolves.toBeUndefined()
    await expect(p.download(7, '1', 100)).rejects.toMatchObject({ code: 'notFound' })
  })
  it('reports a folder status the server did not return as an error', async () => {
    const p = port()
    vi.spyOn((p as any).client, 'status').mockResolvedValue(false)
    await expect(p.status('INBOX')).rejects.toMatchObject({ code: 'command' })
  })
})

/**
 * A server holding two messages that, like any IMAP server, sets \Seen when a message is
 * fetched with BODY[] instead of BODY.PEEK[]. Records every FETCH line.
 */
async function sourceServer() {
  const messages = new Map([
    [1840, { raw: 'Subject: One\r\n\r\nFirst body\r\n', seen: false }],
    [1841, { raw: 'Subject: Two\r\n\r\nSecond, longer body\r\n', seen: false }],
  ])
  const fetches: string[] = []
  const sockets = new Set<TLSSocket>()
  const capability = 'IMAP4rev1 UIDPLUS MOVE'
  const server = createServer(
    { key: fixture('server.key'), cert: fixture('server.crt') },
    (socket) => {
      sockets.add(socket)
      socket.on('error', () => socket.destroy())
      socket.write(`* OK [CAPABILITY ${capability}] Ready\r\n`)
      let buffer = ''
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('latin1')
        for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const [tag, ...rest] = line.split(' ')
          const command = rest.join(' ')
          const name = (rest[0] || '').toUpperCase()
          const reply = (text: string) => socket.write(text + '\r\n')
          if (name === 'CAPABILITY') reply(`* CAPABILITY ${capability}`)
          if (name === 'SELECT') {
            reply('* FLAGS (\\Seen)')
            reply(`* ${messages.size} EXISTS`)
            reply('* OK [UIDVALIDITY 1] UIDs')
            reply('* OK [UIDNEXT 1842] Next')
            reply(`${tag} OK [READ-WRITE] Selected`)
            continue
          }
          if (/^UID FETCH /i.test(command)) {
            fetches.push(command)
            const set = command.split(' ')[2]!.split(',').map(Number)
            const peek = /BODY\.PEEK\[\]/i.test(command)
            const body = !peek && /BODY\[\]/i.test(command)
            ;[...messages].forEach(([uid, m], i) => {
              if (!set.includes(uid)) return
              if (body) m.seen = true
              const items = [`UID ${uid}`, `RFC822.SIZE ${m.raw.length}`]
              if (body) items.push('FLAGS (\\Seen)')
              if (peek || body)
                socket.write(
                  `* ${i + 1} FETCH (${items.join(' ')} BODY[] {${m.raw.length}}\r\n${m.raw})\r\n`,
                )
              else reply(`* ${i + 1} FETCH (${items.join(' ')})`)
            })
            reply(`${tag} OK Fetch completed`)
            continue
          }
          if (name === 'LOGOUT') reply('* BYE Logging out')
          reply(`${tag} OK Done`)
          if (name === 'LOGOUT') socket.end()
        }
      })
    },
  )
  server.on('tlsClientError', () => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    sockets.forEach((s) => s.destroy())
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const port = new ImapFlowPort(
    {
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      security: 'tls',
      username: 'user',
      password: 'secret',
      timeoutMs: 3000,
      tls: { ca: fixture('ca.crt') },
    },
    'command',
  )
  await port.connect()
  closers.unshift(() => port.close())
  await port.select('INBOX')
  return { port, fetches, messages }
}

describe('ImapFlow batch source download', () => {
  it('downloads several messages in one UID FETCH without marking them read', async () => {
    const { port, fetches, messages } = await sourceServer()
    const sources = await port.sources([1840, 1841], 1000)
    expect([...sources.keys()].sort()).toEqual([1840, 1841])
    expect(new TextDecoder().decode(sources.get(1841))).toBe(messages.get(1841)!.raw)
    expect(fetches).toHaveLength(1)
    expect(fetches[0]).toMatch(/^UID FETCH 1840,1841 \(.*BODY\.PEEK\[\].*\)$/)
    expect([...messages.values()].map((m) => m.seen)).toEqual([false, false])
  })
  it('leaves out a message larger than the limit', async () => {
    const { port } = await sourceServer()
    const sources = await port.sources([1840, 1841], 30)
    expect([...sources.keys()]).toEqual([1840])
  })
})
