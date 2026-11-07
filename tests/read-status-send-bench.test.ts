import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'
import { submitSmtp, submitSmtpCopies, type SmtpSettings } from '../packages/imap/src/smtp'

// Prints timings only: never addresses or bodies.
const RUNS = 5
// A stand-in for a real server's processing at each step of a transaction.
const STEP_MS = 40
const fixture = (name: string) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url))
const password = 'test-password'
const later = (callback: () => void) => setTimeout(callback, STEP_MS)

const server = new SMTPServer({
  logger: false,
  disableReverseLookup: true,
  closeTimeout: 10,
  secure: true,
  key: fixture('server.key'),
  cert: fixture('server.crt'),
  onAuth: (_auth, _session, callback) => callback(null, { user: 'user' }),
  onMailFrom: (_address, _session, callback) => later(() => callback()),
  onRcptTo: (_address, _session, callback) => later(() => callback()),
  onData(stream, _session, callback) {
    stream.on('data', () => undefined)
    stream.on('end', () => later(() => callback()))
  },
})
server.on('error', () => undefined)
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const recipients = ['alex@example.org', 'sam@example.org', 'kim@example.org']
const mime = (text: string) =>
  new TextEncoder().encode(`From: me@example.com\r\nSubject: Hello\r\n\r\n${text}\r\n`)

async function median(run: () => Promise<unknown>) {
  const times: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now()
    await run()
    times.push(performance.now() - started)
  }
  return Math.round(times.sort((a, b) => a - b)[Math.floor(RUNS / 2)])
}

describe('read status send bench', () => {
  it('sending one copy per recipient over one session stays close to one plain send', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const settings: SmtpSettings = {
      host: '127.0.0.1',
      port: (server.server.address() as AddressInfo).port,
      security: 'tls',
      username: 'user',
      password,
      timeoutMs: 3000,
      tls: { ca: fixture('ca.crt') },
    }
    const untracked = await median(() =>
      submitSmtp(settings, { from: 'me@example.com', to: recipients }, mime('Hi everyone')),
    )
    const copies = recipients.map((recipient) => ({ recipient, mime: mime('Hi ' + recipient) }))
    const tracked = await median(async () => {
      const outcomes = await submitSmtpCopies(settings, 'me@example.com', copies)
      expect(outcomes.every((o) => o.result === 'accepted')).toBe(true)
    })
    console.info(
      `send bench (median ms over ${RUNS} runs, ${STEP_MS} ms per server step, 3 recipients):`,
      JSON.stringify({ untracked, tracked }),
    )
    expect(tracked).toBeLessThanOrEqual(untracked + 3 * 200)
  }, 30_000)
})
