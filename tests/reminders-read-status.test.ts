import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('../apps/desktop/src/main/public-fetch', async (original) => ({
  ...(await original<typeof import('../apps/desktop/src/main/public-fetch')>()),
  publicFetch: vi.fn(async () => ({ status: 404, type: 'text/html', bytes: Buffer.alloc(0) })),
}))
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(Buffer.from(value).reverse()),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString(),
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: {},
  Notification: { isSupported: () => false },
}))
import { MailService, type ProviderFactory } from '../apps/desktop/src/main/service'
import { JsonStore } from '../apps/desktop/src/main/storage'
import { openInProcessIndex } from '../apps/desktop/src/main/imap-index/sqlite-index'
import { ImapProvider } from '../packages/imap/src'
import type { submitSmtpCopies } from '../packages/imap/src/smtp'
import { parseMime } from '../packages/mime/src'
import type { ConnectInput, CopyOutcome, Draft, SubmissionOutcome } from '../packages/core/src'
import { FakeImapServer } from './support/fake-imap'

// Reminders × Read status: a follow-up switched on by hand is a Gmail label on the Sent copy.
// Read status swaps Gmail's copy (with an image) for a clean one, and sweeps a copy Gmail files
// late; the label must end up on the clean copy and survive both.

const base = 'https://read.example.com'
const SENT = '[Gmail]/Sent Mail'
const ALL = '[Gmail]/All Mail'
const TRASH = '[Gmail]/Trash'
const FOLLOW_UP = 'Warpmail/Follow up'
const alex = 'alex@example.org'
const input: ConnectInput = {
  config: {
    protocol: 'imap',
    email: 'me@example.com',
    incoming: { host: 'imap.example.com', port: 993, security: 'tls', username: 'me' },
    outgoing: { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'me' },
    outgoingSameCredentials: true,
  },
  password: 'disposable',
  name: 'Work',
  remember: true,
  connectionId: 'imap-connection',
}
const draftId = 'b7a1c3e0-5d2f-4c8a-9e61-0f3b2d4a6c81'
const accountId = JSON.stringify(['imap-connection', 'imap'])
// Asks nothing, so the ask-check guesses no follow-up; the switch is turned on by hand.
const draft: Draft = {
  id: draftId,
  accountId,
  identityId: 'default',
  to: [{ name: 'Alex', email: alex }],
  cc: [],
  bcc: [],
  subject: 'Plans',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [],
  updatedAt: '2026-09-23T10:00:00.000Z',
  status: 'local',
  followUp: true,
}
type Copies = Parameters<typeof submitSmtpCopies>[2]
type Progress = NonNullable<Parameters<typeof submitSmtpCopies>[3]>

let directory: string
let server: FakeImapServer
let service: MailService
let store: JsonStore
let closing: Promise<void>[] = []
const factory: ProviderFactory = (options) => {
  const provider = new ImapProvider({
    connectionId: options.connectionId,
    name: options.name,
    config: options.config as typeof input.config & { protocol: 'imap' },
    password: options.secrets.password,
    folders: options.folders,
    index: openInProcessIndex(join(directory, options.connectionId + '.sqlite')),
    readAttachment: options.readAttachment,
    // As in the app: the sync Read status asks for after filing is what indexes the clean copy.
    background: true,
    ports: server.port,
    smtp: {
      submit: async (_settings, envelope) =>
        ({ accepted: envelope.to, rejected: [] }) as SubmissionOutcome,
      verify: async () => {},
      submitCopies: fakeCopies,
    },
    timing: { sentCopyGraceMs: 0, previews: 0 },
  })
  const close = provider.close.bind(provider)
  provider.close = () => {
    const closed = close()
    closing.push(closed)
    return closed
  }
  return provider
}
const text = (bytes?: Uint8Array) => new TextDecoder().decode(bytes)
const hasImage = (raw?: Uint8Array) => text(raw).includes('read.example.com')
let firstCopy: Copies[number] | undefined
/** Gmail files the accepted copy in Sent itself, image included. */
async function gmailFiles(copy: Copies[number]) {
  const { messageId, subject, html } = await parseMime(copy.mime)
  for (const box of [SENT, ALL])
    server.deliver(box, { messageId, subject, html, flags: ['\\Seen'] })
}
async function fakeCopies(_settings: unknown, _from: string, copies: Copies, progress?: Progress) {
  const outcomes: CopyOutcome[] = []
  for (const copy of copies) {
    await progress!(copy.recipient, outcomes.at(-1))
    outcomes.push({ recipient: copy.recipient, result: 'accepted' })
  }
  firstCopy = copies[0]
  await gmailFiles(copies[0])
  return outcomes
}
const journal = async () =>
  (await store.read<any[]>('submissions', [])).find((j) => j.draftId === draftId)
const provider = () => [...(service as any).providers.values()][0] as ImapProvider
/** Moves only the clock (timers stay real) to this many minutes after the send. */
const later = async (minutes: number) => {
  const at = Date.parse((await journal()).at)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(at + minutes * 60_000)
}
/** The Follow up label is on the one clean Sent copy, on the server and in the index. */
async function expectLabelOnCleanCopy() {
  const sent = server.box(SENT).messages
  expect(sent).toHaveLength(1)
  expect(hasImage(sent[0].raw)).toBe(false)
  const labelled = server.box(FOLLOW_UP).messages
  expect(labelled).toHaveLength(1)
  expect(labelled[0].input.messageId).toBe(sent[0].input.messageId)
  expect(hasImage(labelled[0].raw)).toBe(false)
  expect(server.box(TRASH).messages).toHaveLength(0)
  const p = provider() as any
  const boxes: { id: string; path: string }[] = await p.index.listMailboxes(p.accountId)
  const label = boxes.find((b) => b.path === FOLLOW_UP)!
  const rows = await p.index.findByMessageId(p.accountId, (await journal()).messageId, label.id)
  expect(rows).toHaveLength(1)
}
/** Waits for the label the switch asked for, written in the background after the send. */
const labelWritten = () =>
  vi.waitFor(() => expect(server.boxes.get(FOLLOW_UP)?.messages).toHaveLength(1), {
    timeout: 8000,
  })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'inlark-reminders-read-status-'))
  server = new FakeImapServer()
  // Laid out like Gmail: labels shown as folders, every message in All Mail.
  for (const path of [...server.boxes.keys()]) if (path !== 'INBOX') server.boxes.delete(path)
  server.addMailbox(SENT, '\\Sent')
  server.addMailbox(ALL, '\\All')
  server.addMailbox(TRASH, '\\Trash')
  server.addMailbox('[Gmail]/Drafts', '\\Drafts')
  server.gmail = true
  firstCopy = undefined
  store = new JsonStore(directory)
  service = new MailService(store, () => {}, {
    providers: factory,
    readStatusFetch: async () => {
      throw new Error('offline')
    },
  })
  await service.init()
  await service.connect(input)
  await service.setSettings({
    ...service.settings,
    readStatus: { enabled: true, workerUrl: base },
  })
  await service.readStatusSecret.set('test-password')
})
afterEach(async () => {
  service.dispose()
  await Promise.allSettled(closing)
  closing = []
  vi.restoreAllMocks()
  vi.useRealTimers()
  await new Promise((r) => setTimeout(r, 20))
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('Reminders with Read status: a follow-up switched on by hand', () => {
  it('is labelled on the clean Sent copy, and keeps it through the late-copy sweep', async () => {
    expect((await service.send(draft)).status).toBe('sent')
    await service.sendsSettled()
    expect((await journal()).tracked).toBe(true)
    expect((await journal()).sentCopy).toBe('filed')
    await labelWritten()
    await expectLabelOnCleanCopy()
    // Gmail files its merged copy, image included, after the clean one.
    await gmailFiles(firstCopy!)
    expect(server.box(SENT).messages).toHaveLength(2)
    await later(2)
    await service.refresh()
    expect((await journal()).sweepAt).toBeUndefined()
    await vi.waitFor(() => expectLabelOnCleanCopy())
  })
  it('lands on the clean copy even when the late copy is indexed first', async () => {
    // Gmail files its merged copy before Reminders writes the label, and the index has it.
    const label = ImapProvider.prototype.labelMessage
    vi.spyOn(ImapProvider.prototype, 'labelMessage').mockImplementation(async function (
      this: ImapProvider,
      ...args
    ) {
      if (server.box(SENT).messages.length === 1) {
        await gmailFiles(firstCopy!)
        await (this as any).syncPass('all')
      }
      return label.apply(this, args)
    })
    expect((await service.send(draft)).status).toBe('sent')
    await service.sendsSettled()
    await labelWritten()
    expect(server.box(SENT).messages).toHaveLength(2)
    expect(hasImage(server.box(FOLLOW_UP).messages[0].raw)).toBe(false)
    await later(2)
    await service.refresh()
    expect((await journal()).sweepAt).toBeUndefined()
    await vi.waitFor(() => expectLabelOnCleanCopy())
  })
})
