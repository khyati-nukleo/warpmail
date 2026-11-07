import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { MailService, type ProviderFactory } from '../apps/desktop/src/main/service'
import { JsonStore } from '../apps/desktop/src/main/storage'
import { openInProcessIndex } from '../apps/desktop/src/main/imap-index/sqlite-index'
import { imageCode, isTrackedMessageId } from '../apps/desktop/src/main/read-status/codes'
import { recoverCopies, settleCopies } from '../apps/desktop/src/main/read-status/tracked-send'
import { ImapProvider } from '../packages/imap/src'
import type { submitSmtpCopies } from '../packages/imap/src/smtp'
import { parseMime } from '../packages/mime/src'
import {
  pixelUrl,
  ProviderError,
  type ConnectInput,
  type CopyOutcome,
  type Draft,
  type SubmissionOutcome,
} from '../packages/core/src'
import { FakeImapServer } from './support/fake-imap'

const base = 'https://read.example.com'
const password = 'test-password'
const SENT = '[Gmail]/Sent Mail'
const ALL = '[Gmail]/All Mail'
const alex = 'alex@example.org'
const sam = 'sam@example.org'
const kim = 'kim@example.org'
const closed = 'Not sent: the app closed before sending to this recipient.'
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
const draftId = 'fb4c0a00-254f-4fb1-965e-96d56ca9ef17'
const accountId = JSON.stringify(['imap-connection', 'imap'])
const draft: Draft = {
  id: draftId,
  accountId,
  identityId: 'default',
  to: [{ name: 'Alex', email: alex }],
  cc: [{ name: 'Sam', email: sam }],
  bcc: [{ name: 'Kim', email: kim }],
  subject: 'Plans',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [],
  updatedAt: '2026-09-23T10:00:00.000Z',
  status: 'local',
}
type Copies = Parameters<typeof submitSmtpCopies>[2]
type Progress = NonNullable<Parameters<typeof submitSmtpCopies>[3]>
const reasons: Record<CopyOutcome['result'], string | undefined> = {
  accepted: undefined,
  rejected: '550 No such user',
  uncertain: 'The connection ended while sending.',
  notSent: 'Not sent: the connection ended first.',
}
let directory: string
let server: FakeImapServer
let service: MailService
let store: JsonStore
let submit: ReturnType<typeof vi.fn<(...args: any[]) => Promise<SubmissionOutcome>>>
let submitCopies: ReturnType<typeof vi.fn<typeof submitSmtpCopies>>
/** What each copy's transaction ends with, in order; accepted when not given. */
let plan: CopyOutcome['result'][]
const factory: ProviderFactory = (options) =>
  new ImapProvider({
    connectionId: options.connectionId,
    name: options.name,
    config: options.config as typeof input.config & { protocol: 'imap' },
    password: options.secrets.password,
    outgoingPassword: options.secrets.outgoingPassword,
    folders: options.folders,
    index: openInProcessIndex(
      options.temporary ? ':memory:' : join(directory, options.connectionId + '.sqlite'),
    ),
    readAttachment: options.readAttachment,
    background: false,
    ports: server.port,
    smtp: { submit, verify: async () => {}, submitCopies },
    timing: { sentCopyGraceMs: 0, previews: 0 },
  })
const text = (bytes?: Uint8Array) => new TextDecoder().decode(bytes)
/** Gmail files the first accepted copy in Sent itself, image included. */
async function gmailFiles(copy: Copies[number]) {
  const { messageId, subject, html } = await parseMime(copy.mime)
  for (const box of [SENT, ALL])
    server.deliver(box, { messageId, subject, html, flags: ['\\Seen'] })
}
/** Behaves like the real one: progress before each copy, nothing after the connection ends. */
async function fakeCopies(_settings: unknown, _from: string, copies: Copies, progress?: Progress) {
  const outcomes: CopyOutcome[] = []
  let stopped = false
  for (const [i, copy] of copies.entries()) {
    const result = stopped ? 'notSent' : (plan[i] ?? 'accepted')
    if (!stopped) await progress!(copy.recipient, outcomes.at(-1))
    outcomes.push({ recipient: copy.recipient, result, reason: reasons[result] })
    if (result === 'uncertain' || result === 'notSent') stopped = true
  }
  const first = outcomes.findIndex((o) => o.result === 'accepted')
  if (first >= 0) await gmailFiles(copies[first])
  return outcomes
}
async function start() {
  store = new JsonStore(directory)
  service = new MailService(store, () => {}, { providers: factory })
  await service.init()
}
const connected = () => vi.waitFor(() => expect(service.accounts[0]?.status).toBe('connected'))
const journal = async () =>
  (await store.read<any[]>('submissions', [])).find((j) => j.draftId === draftId)
const localDraft = async () => (await service.drafts()).find((d) => d.id === draftId)
const recipientsOf = (d: Draft) => [...d.to, ...d.cc, ...d.bcc].map((a) => a.email)
const untrackedReasons = async () =>
  JSON.parse(await service.diagnostics())
    .events.filter((e: { event: string }) => e.event === 'read-status-untracked')
    .map((e: { state: string }) => e.state)
const setReadStatus = (enabled: boolean) =>
  service.setSettings({ ...service.settings, readStatus: { enabled, workerUrl: base } })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'inlark-read-status-service-'))
  server = new FakeImapServer()
  // Laid out like Gmail: labels shown as folders, every message in All Mail.
  for (const path of [...server.boxes.keys()]) if (path !== 'INBOX') server.boxes.delete(path)
  server.addMailbox(SENT, '\\Sent')
  server.addMailbox(ALL, '\\All')
  server.addMailbox('[Gmail]/Trash', '\\Trash')
  server.addMailbox('[Gmail]/Drafts', '\\Drafts')
  server.gmail = true
  plan = []
  submit = vi.fn(async (_settings, envelope) => ({ accepted: envelope.to, rejected: [] }))
  submitCopies = vi.fn(fakeCopies)
  await start()
  await service.connect(input)
  await setReadStatus(true)
  await service.readStatusSecret.set(password)
})
afterEach(async () => {
  service.dispose()
  vi.restoreAllMocks()
  await new Promise((r) => setTimeout(r, 20))
  await rm(directory, { recursive: true, force: true })
})

describe('Read status: tracked sending', () => {
  it('sends one copy per recipient with its own image and files one clean Sent copy', async () => {
    const result = await service.send(draft)
    expect(result.status).toBe('sent')
    expect(submit).not.toHaveBeenCalled()
    expect(submitCopies).toHaveBeenCalledTimes(1)
    const copies = submitCopies.mock.calls[0][2]
    expect(copies.map((c) => c.recipient)).toEqual([alex, sam, kim])
    const messageId = (await journal()).messageId
    expect(isTrackedMessageId(password, messageId)).toBe(true)
    for (const copy of copies) {
      const html = (await parseMime(copy.mime)).html
      for (const r of [alex, sam, kim]) {
        const image = pixelUrl(base, imageCode(password, messageId, r))
        if (r === copy.recipient) expect(html).toContain(image)
        else expect(html).not.toContain(image)
      }
    }
    await service.sendsSettled()
    const sent = server.box(SENT).messages
    expect(sent).toHaveLength(1)
    expect(text(sent[0].raw)).not.toContain('read.example.com')
    expect(text(sent[0].raw)).toMatch(/^Bcc:.*kim@example\.org/im)
    expect((await journal()).sentCopy).toBe('filed')
  })
  it('the journal is durable before each copy', async () => {
    let stored: any
    submitCopies.mockImplementationOnce(async (_s, _f, copies, progress) => {
      await progress!(alex)
      await progress!(sam, { recipient: alex, result: 'accepted' })
      stored = await journal()
      await progress!(kim, { recipient: sam, result: 'accepted' })
      return copies.map((c) => ({ recipient: c.recipient, result: 'accepted' as const }))
    })
    expect((await service.send(draft)).status).toBe('sent')
    expect(stored).toMatchObject({ state: 'submitting', tracked: true })
    expect(stored.copies).toEqual([
      { recipient: alex, state: 'accepted' },
      { recipient: sam, state: 'sending' },
      { recipient: kim, state: 'pending' },
    ])
  })
  it('a crash midway never sends to anyone twice', async () => {
    let reached!: () => void
    const midway = new Promise<void>((resolve) => (reached = resolve))
    submitCopies.mockImplementationOnce(async (_s, _f, _copies, progress) => {
      await progress!(alex)
      await progress!(sam, { recipient: alex, result: 'accepted' })
      reached()
      // The app dies here: the copy to Sam may or may not have arrived.
      return new Promise<CopyOutcome[]>(() => {})
    })
    void service.send(draft)
    await midway
    const crashed = service
    await start()
    crashed.dispose()
    expect(await journal()).toMatchObject({
      state: 'partial',
      accepted: [alex],
      unconfirmed: [sam],
      rejected: [{ email: kim, reason: closed }],
    })
    expect((await localDraft())?.status).toBe('sent')
    await connected()
    expect((await service.send(draft)).status).toBe('partial')
    const recovery = await service.recoverRejected(draftId)
    expect(recipientsOf(recovery)).toEqual([kim])
    expect(recovery.bcc.map((a) => a.email)).toEqual([kim])
    expect(submitCopies).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()
  })
  it('a crash before the first copy is recovered as not sent', async () => {
    let reached!: () => void
    const before = new Promise<void>((resolve) => (reached = resolve))
    submitCopies.mockImplementationOnce(async () => {
      reached()
      return new Promise<CopyOutcome[]>(() => {})
    })
    void service.send(draft)
    await before
    const crashed = service
    await start()
    crashed.dispose()
    expect(await journal()).toMatchObject({ state: 'rejected', error: closed })
    expect(await localDraft()).toMatchObject({ status: 'error', error: closed, text: 'Hello' })
  })
  it('a dropped connection mid-send ends partial with the unconfirmed recipient excluded from recovery', async () => {
    plan = ['accepted', 'uncertain', 'notSent']
    const result = await service.send(draft)
    expect(result.status).toBe('partial')
    expect(result.message).toContain("1 didn't get it.")
    expect(result.message).toContain("Delivery to 1 isn't confirmed.")
    expect(await journal()).toMatchObject({
      state: 'partial',
      accepted: [alex],
      unconfirmed: [sam],
      rejected: [{ email: kim, reason: reasons.notSent }],
    })
    const recovery = await service.recoverRejected(draftId)
    expect(recipientsOf(recovery)).toEqual([kim])
    await service.sendsSettled()
    expect(server.box(SENT).messages).toHaveLength(1)
    expect(text(server.box(SENT).messages[0].raw)).not.toContain('read.example.com')
  })
  it('a first copy that may have arrived leaves the whole send unconfirmed, never resent', async () => {
    plan = ['uncertain']
    expect((await service.send(draft)).status).toBe('uncertain')
    expect(await journal()).toMatchObject({ state: 'uncertain', unconfirmed: [alex] })
    expect((await localDraft())?.status).toBe('uncertain')
    expect((await service.send(draft)).status).toBe('uncertain')
    expect(submitCopies).toHaveBeenCalledTimes(1)
  })
  it('a journal write that fails before the first copy is a plain not-sent', async () => {
    const write = store.write.bind(store)
    vi.spyOn(store, 'write').mockImplementation((name, data, version) => {
      if (name === 'submissions' && (data as any[]).some((j) => j.copies?.[0]?.state === 'sending'))
        return Promise.reject(new Error('Disk full'))
      return write(name, data, version)
    })
    await expect(service.send(draft)).rejects.toMatchObject({ code: 'submission' })
    expect(await localDraft()).toMatchObject({ status: 'error', text: 'Hello' })
    expect((await journal()).state).toBe('rejected')
    expect(server.box(SENT).messages).toHaveLength(0)
  })
  it('everything refused throws and the draft stays', async () => {
    plan = ['rejected', 'rejected', 'rejected']
    await expect(service.send(draft)).rejects.toMatchObject({
      code: 'submissionRejected',
      message: reasons.rejected,
    })
    expect(await localDraft()).toMatchObject({ status: 'error', text: 'Hello' })
    expect((await journal()).state).toBe('rejected')
    expect(server.box(SENT).messages).toHaveLength(0)
  })
  it('an automated recipient gets a copy without an image', async () => {
    const noReply = { ...draft, cc: [{ name: '', email: 'no-reply@example.org' }], bcc: [] }
    expect((await service.send(noReply)).status).toBe('sent')
    const copies = submitCopies.mock.calls[0][2]
    expect(copies.map((c) => c.recipient)).toEqual([alex, 'no-reply@example.org'])
    expect((await parseMime(copies[0].mime)).html).toContain('read.example.com')
    expect((await parseMime(copies[1].mime)).html).not.toContain('read.example.com')
  })
  it('a tracked Sent copy left uncertain is filed after a restart by replacing the server copy', async () => {
    // The app quits while the Sent copy is being filed: it is `uncertain` after the restart.
    vi.spyOn(ImapProvider.prototype, 'fileSentCopy').mockImplementationOnce(
      () => new Promise(() => {}),
    )
    expect((await service.send(draft)).status).toBe('sent')
    await vi.waitFor(async () => expect((await journal()).sentCopy).toBe('appending'))
    expect(server.box(SENT).messages[0].input.html).toContain('read.example.com')
    service.dispose()
    await start()
    await connected()
    await vi.waitFor(async () => expect((await journal()).sentCopy).toBe('filed'))
    const sent = server.box(SENT).messages
    expect(sent).toHaveLength(1)
    expect(text(sent[0].raw)).not.toContain('read.example.com')
    expect(submitCopies).toHaveBeenCalledTimes(1)
  })
})

describe('Read status: sends that are never tracked', () => {
  const many = Array.from({ length: 26 }, (_, i) => ({ name: '', email: `p${i}@example.org` }))
  const cases: [string, string, () => Promise<unknown>, Partial<Draft>][] = [
    ['the main switch is off', 'off', () => setReadStatus(false), {}],
    ['no password is set', 'notConfigured', () => service.readStatusSecret.set(null), {}],
    ['the draft switched it off', 'switchedOff', async () => {}, { readStatus: false }],
    [
      'every recipient is automated',
      'automated',
      async () => {},
      { to: [{ name: '', email: 'noreply@example.com' }], cc: [], bcc: [] },
    ],
    ['there are 26 recipients', 'tooMany', async () => {}, { to: many, cc: [], bcc: [] }],
    [
      'the account itself is a recipient',
      'self',
      async () => {},
      { cc: [{ name: 'Me', email: 'Me@Example.com' }], bcc: [] },
    ],
  ]
  for (const [name, reason, arrange, patch] of cases)
    it(`when ${name}`, async () => {
      await arrange()
      await service.send({ ...draft, ...patch })
      expect(submit).toHaveBeenCalledTimes(1)
      expect(submitCopies).not.toHaveBeenCalled()
      expect(await untrackedReasons()).toEqual([reason])
      expect(isTrackedMessageId(password, (await journal()).messageId)).toBe(false)
    })
  it('when the email is signed', async () => {
    // A signed send may fail before submitting here, since no OpenPGP key exists.
    await service.send({ ...draft, encryption: 'sign' }).catch(() => undefined)
    expect(submitCopies).not.toHaveBeenCalled()
    expect(await untrackedReasons()).toEqual(['protected'])
  })
  it('quoted Worker images are stripped from every send', async () => {
    await setReadStatus(false)
    const quoted =
      '<p>Hello</p><blockquote><img src="https://read.example.com/p/OLDOLDOLDOLDOLDOLDOLDO.gif"></blockquote>'
    await service.send({ ...draft, html: quoted })
    expect(submit).toHaveBeenCalledTimes(1)
    const mime = text(submit.mock.calls[0][2])
    expect(mime).not.toContain('OLDOLD')
    expect(mime).toContain('Hello')
  })
})

describe('Read status: settling copies', () => {
  const copy = (recipient: string, state: string, reason?: string) =>
    ({ recipient, state, reason }) as Parameters<typeof settleCopies>[0][number]
  it('all accepted is sent; some accepted is partial with unconfirmed copies kept apart', () => {
    expect(settleCopies([copy(alex, 'accepted'), copy(sam, 'accepted')]).state).toBe('sent')
    expect(
      settleCopies([copy(alex, 'accepted'), copy(sam, 'uncertain'), copy(kim, 'rejected', 'No')]),
    ).toEqual({
      state: 'partial',
      accepted: [alex],
      rejected: [{ email: kim, reason: 'No' }],
      unconfirmed: [sam],
    })
  })
  it('none accepted is uncertain when a copy may have arrived, otherwise rejected', () => {
    expect(settleCopies([copy(alex, 'uncertain'), copy(sam, 'notSent', 'x')]).state).toBe(
      'uncertain',
    )
    expect(settleCopies([copy(alex, 'rejected', 'No'), copy(sam, 'notSent', 'x')]).state).toBe(
      'rejected',
    )
    expect(settleCopies([]).state).toBe('rejected')
  })
  it('after a restart a copy being sent is unconfirmed and a pending one was never sent', () => {
    expect(
      recoverCopies([copy(alex, 'accepted'), copy(sam, 'sending'), copy(kim, 'pending')]),
    ).toEqual([copy(alex, 'accepted'), copy(sam, 'uncertain'), copy(kim, 'notSent', closed)])
  })
})
