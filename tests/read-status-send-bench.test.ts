import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SMTPServer } from 'smtp-server'
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
import { submitSmtp, submitSmtpCopies, type SmtpSettings } from '../packages/imap/src/smtp'
import { MailService, type ProviderFactory } from '../apps/desktop/src/main/service'
import { JsonStore } from '../apps/desktop/src/main/storage'
import { openInProcessIndex } from '../apps/desktop/src/main/imap-index/sqlite-index'
import { ImapProvider } from '../packages/imap/src'
import type { Draft, ImapConnectionConfig } from '../packages/core/src'
import { FakeImapServer } from './support/fake-imap'

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
beforeAll(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)))
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
const port = () => (server.server.address() as AddressInfo).port

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
    const settings: SmtpSettings = {
      host: '127.0.0.1',
      port: port(),
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
  it('a tracked send through the app stays close to an untracked one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inlark-read-status-bench-'))
    const imap = new FakeImapServer()
    const config: ImapConnectionConfig = {
      protocol: 'imap',
      email: 'me@example.com',
      incoming: { host: 'imap.example.com', port: 993, security: 'tls', username: 'me' },
      outgoing: { host: '127.0.0.1', port: port(), security: 'tls', username: 'user' },
      outgoingSameCredentials: false,
    }
    const factory: ProviderFactory = (options) =>
      new ImapProvider({
        connectionId: options.connectionId,
        name: options.name,
        config: options.config as ImapConnectionConfig,
        password: options.secrets.password,
        outgoingPassword: options.secrets.outgoingPassword,
        index: openInProcessIndex(join(directory, options.connectionId + '.sqlite')),
        readAttachment: options.readAttachment,
        background: false,
        ports: imap.port,
        tls: { ca: fixture('ca.crt') },
        timing: { sentCopyGraceMs: 0, previews: 0 },
      })
    const service = new MailService(new JsonStore(directory), () => {}, { providers: factory })
    try {
      await service.init()
      const [account] = await service.connect({
        config,
        password: 'disposable',
        outgoingPassword: password,
        name: 'Work',
        remember: true,
        connectionId: 'bench',
      })
      await service.readStatusSecret.set(password)
      const draft = (): Draft => ({
        id: randomUUID(),
        accountId: account.id,
        identityId: 'default',
        to: recipients.map((email) => ({ name: '', email })),
        cc: [],
        bcc: [],
        subject: 'Hello',
        html: '<p>Hi everyone</p>',
        text: 'Hi everyone',
        attachments: [],
        updatedAt: new Date().toISOString(),
        status: 'local',
      })
      const sends = async (enabled: boolean) => {
        await service.setSettings({
          ...service.settings,
          readStatus: { enabled, workerUrl: 'https://read.example.com' },
        })
        const times: number[] = []
        for (let i = 0; i < RUNS; i++) {
          const started = performance.now()
          expect((await service.send(draft())).status).toBe('sent')
          times.push(performance.now() - started)
          // Filing the Sent copy happens after the send is reported; it is not timed.
          await service.sendsSettled()
        }
        return Math.round(times.sort((a, b) => a - b)[Math.floor(RUNS / 2)])
      }
      const untracked = await sends(false)
      const tracked = await sends(true)
      expect(imap.box('Sent').messages).toHaveLength(2 * RUNS)
      console.info(
        `service send bench (median ms over ${RUNS} runs, ${STEP_MS} ms per server step, 3 recipients):`,
        JSON.stringify({ untracked, tracked }),
      )
      expect(tracked).toBeLessThanOrEqual(untracked + 600)
    } finally {
      service.dispose()
      await new Promise((r) => setTimeout(r, 20))
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
