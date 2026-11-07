import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import type { AddressInfo, Socket } from 'node:net'
import { SMTPServer, type SMTPServerOptions } from 'smtp-server'
import type { CopyOutcome, OutgoingCopy } from '../packages/core/src/model'
import { submitSmtpCopies, type SmtpSettings } from '../packages/imap/src/smtp'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url))
const ca = fixture('ca.crt')
const trusted = { key: fixture('server.key'), cert: fixture('server.crt') }
const password = 'test-password'

const servers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()))
})

async function start(options: Partial<SMTPServerOptions> = {}) {
  const log = {
    connections: 0,
    mailFrom: [] as string[],
    transactions: [] as { mailFrom: string; rcptTo: string[]; data: Buffer }[],
  }
  const sockets = new Set<Socket>()
  const server = new SMTPServer({
    logger: false,
    disableReverseLookup: true,
    closeTimeout: 10,
    secure: true,
    ...trusted,
    onConnect(_session, callback) {
      log.connections++
      callback()
    },
    onAuth(auth, _session, callback) {
      if (auth.username === 'user' && auth.password === password) callback(null, { user: 'user' })
      else callback(new Error('Invalid username or password'))
    },
    onMailFrom(address, _session, callback) {
      log.mailFrom.push(address.address)
      callback()
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        log.transactions.push({
          mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          rcptTo: session.envelope.rcptTo.map((a) => a.address),
          data: Buffer.concat(chunks),
        })
        callback(null, 'Queued')
      })
    },
    ...options,
  })
  server.on('error', () => undefined)
  server.server.on('connection', (socket: Socket) => sockets.add(socket))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.server.address() as AddressInfo).port
  servers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { port, log, sockets }
}

const settings = (port: number, overrides: Partial<SmtpSettings> = {}): SmtpSettings => ({
  host: '127.0.0.1',
  port,
  security: 'tls',
  username: 'user',
  password,
  timeoutMs: 3000,
  tls: { ca },
  ...overrides,
})
const recipients = ['alex@example.org', 'sam@example.org', 'kim@example.org']
const copies = (): OutgoingCopy[] =>
  recipients.map((recipient) => ({
    recipient,
    mime: new TextEncoder().encode(
      `From: me@example.com\r\nTo: alex@example.org, sam@example.org, kim@example.org\r\n` +
        `Subject: Hello\r\n\r\nHi, this copy is for ${recipient}.\r\n.a line starting with a dot\r\n`,
    ),
  }))
const recorder = (log: { mailFrom: string[] }) => {
  const calls: { recipient: string; previous?: CopyOutcome['result']; transactions: number }[] = []
  const progress = async (recipient: string, previous?: CopyOutcome) => {
    calls.push({ recipient, previous: previous?.result, transactions: log.mailFrom.length })
  }
  return { calls, progress }
}

describe('SMTP copies over one session', () => {
  it('sends every copy in one session, one recipient per transaction', async () => {
    const { port, log } = await start()
    const sent = copies()
    const { calls, progress } = recorder(log)
    const outcomes = await submitSmtpCopies(settings(port), 'me@example.com', sent, progress)
    expect(outcomes).toEqual(recipients.map((recipient) => ({ recipient, result: 'accepted' })))
    expect(log.connections).toBe(1)
    expect(log.transactions).toHaveLength(3)
    log.transactions.forEach((transaction, i) => {
      expect(transaction.mailFrom).toBe('me@example.com')
      expect(transaction.rcptTo).toEqual([recipients[i]])
      expect(new Uint8Array(transaction.data)).toEqual(sent[i].mime)
    })
    expect(calls).toEqual([
      { recipient: recipients[0], previous: undefined, transactions: 0 },
      { recipient: recipients[1], previous: 'accepted', transactions: 1 },
      { recipient: recipients[2], previous: 'accepted', transactions: 2 },
    ])
  })

  it('a refused recipient does not stop the others', async () => {
    const { port, log } = await start({
      onRcptTo(address, _session, callback) {
        if (address.address === 'sam@example.org')
          callback(Object.assign(new Error('No such user here'), { responseCode: 550 }))
        else callback()
      },
    })
    const outcomes = await submitSmtpCopies(settings(port), 'me@example.com', copies())
    expect(outcomes.map((o) => o.result)).toEqual(['accepted', 'rejected', 'accepted'])
    expect(outcomes[1].recipient).toBe('sam@example.org')
    expect(outcomes[1].reason).toMatch(/No such user here/)
    expect(log.connections).toBe(1)
    expect(log.transactions.map((t) => t.rcptTo)).toEqual([[recipients[0]], [recipients[2]]])
  })

  it('a refused message after DATA does not stop the others', async () => {
    let count = 0
    const { port, log } = await start({
      onData(stream, _session, callback) {
        const reply = ++count === 1 ? 'Message looks like spam' : undefined
        stream.on('data', () => undefined)
        stream.on('end', () =>
          reply
            ? callback(Object.assign(new Error(reply), { responseCode: 554 }))
            : callback(null, 'Queued'),
        )
      },
    })
    const outcomes = await submitSmtpCopies(settings(port), 'me@example.com', copies())
    expect(outcomes.map((o) => o.result)).toEqual(['rejected', 'accepted', 'accepted'])
    expect(outcomes[0].reason).toMatch(/looks like spam/)
    expect(log.connections).toBe(1)
  })

  it("the connection dropping during the second copy's DATA leaves it uncertain and the rest not sent", async () => {
    let count = 0
    const { port, log, sockets } = await start({
      onData(stream, _session, callback) {
        const drop = ++count === 2
        stream.on('data', () => undefined)
        stream.on('end', () => (drop ? sockets.forEach((s) => s.destroy()) : callback()))
      },
    })
    const { calls, progress } = recorder(log)
    const outcomes = await submitSmtpCopies(settings(port), 'me@example.com', copies(), progress)
    expect(outcomes.map((o) => o.result)).toEqual(['accepted', 'uncertain', 'notSent'])
    expect(outcomes[2]).toEqual({
      recipient: 'kim@example.org',
      result: 'notSent',
      reason: 'Not sent: the connection to 127.0.0.1 ended first.',
    })
    expect(calls.map((c) => c.recipient)).toEqual(recipients.slice(0, 2))
    expect(log.connections).toBe(1)
  })

  it('the connection dropping before DATA leaves that copy and the rest not sent', async () => {
    const { port, sockets } = await start({
      onRcptTo(address, _session, callback) {
        if (address.address === 'sam@example.org') sockets.forEach((s) => s.destroy())
        else callback()
      },
    })
    const outcomes = await submitSmtpCopies(settings(port), 'me@example.com', copies())
    expect(outcomes.map((o) => o.result)).toEqual(['accepted', 'notSent', 'notSent'])
  })

  it('a sign-in failure throws and sends nothing', async () => {
    const { port, log } = await start()
    const { calls, progress } = recorder(log)
    const error = await submitSmtpCopies(
      settings(port, { password: 'wrong-password' }),
      'me@example.com',
      copies(),
      progress,
    ).then(
      () => undefined,
      (e: { code: string }) => e,
    )
    expect(error?.code).toBe('outgoingAuthentication')
    expect(calls).toEqual([])
    expect(log.mailFrom).toEqual([])
  })

  it('a progress failure on the first copy sends nothing', async () => {
    const { port, log } = await start()
    const failure = new Error('The journal could not be saved')
    const error = await submitSmtpCopies(settings(port), 'me@example.com', copies(), async () => {
      throw failure
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBe(failure)
    expect(log.mailFrom).toEqual([])
  })

  it('a progress failure on a later copy leaves the rest not sent', async () => {
    const { port, log } = await start()
    const outcomes = await submitSmtpCopies(
      settings(port),
      'me@example.com',
      copies(),
      async (recipient) => {
        if (recipient === 'sam@example.org') throw new Error('The journal could not be saved')
      },
    )
    expect(outcomes.map((o) => o.result)).toEqual(['accepted', 'notSent', 'notSent'])
    expect(log.transactions).toHaveLength(1)
  })

  it('rejects unusable copies without connecting', async () => {
    const { port, log } = await start()
    const one = copies()[0]
    for (const [from, list] of [
      ['me@example.com', []],
      ['', [one]],
      ['me@example.com', [{ ...one, recipient: 'bad address@example.org' }]],
      ['me@example.com', [{ ...one, mime: new Uint8Array() }]],
      ['me@example.com', [one, { ...one, recipient: 'Alex@Example.org' }]],
    ] as [string, OutgoingCopy[]][]) {
      const error = await submitSmtpCopies(settings(port), from, list).then(
        () => undefined,
        (e: { code: string }) => e,
      )
      expect(error?.code).toBe('submissionRejected')
    }
    expect(log.connections).toBe(0)
  })
})
