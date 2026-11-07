import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { dialog } from 'electron'
import { publicFetch } from '../apps/desktop/src/main/public-fetch'
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
/** Every provider's close, so cleanup waits until no service writes to the directory. */
let closing: Promise<void>[] = []
/** Every service started in a test, including ones a test treats as crashed. */
let running: MailService[] = []
/** What the service asks the Worker; offline unless a test says otherwise. */
let workerFetch: typeof fetch
const factory: ProviderFactory = (options) => {
  const provider = new ImapProvider({
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
  const close = provider.close.bind(provider)
  provider.close = () => {
    const closed = close()
    closing.push(closed)
    return closed
  }
  return provider
}
/** Stops a service the way the app quits: nothing of it runs or writes afterwards. */
async function stop(stopped: MailService) {
  running = running.filter((s) => s !== stopped)
  stopped.dispose()
  await Promise.allSettled(closing)
}
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
  service = new MailService(store, () => {}, {
    providers: factory,
    readStatusFetch: (...args) => workerFetch(...args),
  })
  running.push(service)
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
  workerFetch = async () => {
    throw new Error('offline')
  }
  submit = vi.fn(async (_settings, envelope) => ({ accepted: envelope.to, rejected: [] }))
  submitCopies = vi.fn(fakeCopies)
  await start()
  await service.connect(input)
  await setReadStatus(true)
  await service.readStatusSecret.set(password)
})
afterEach(async () => {
  for (const s of running) s.dispose()
  running = []
  await Promise.allSettled(closing)
  closing = []
  vi.restoreAllMocks()
  vi.useRealTimers()
  await new Promise((r) => setTimeout(r, 20))
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
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
    await stop(crashed)
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
    await stop(crashed)
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
    await service.sendsSettled()
    expect(await service.submissions()).toMatchObject([
      { draftId, state: 'partial', rejected: [{ email: kim }], unconfirmed: [sam] },
    ])
    const recovery = await service.recoverRejected(draftId)
    expect(recipientsOf(recovery)).toEqual([kim])
    expect(server.box(SENT).messages).toHaveLength(1)
    expect(text(server.box(SENT).messages[0].raw)).not.toContain('read.example.com')
  })
  it('a partial with nothing refused offers no recovery and keeps its record', async () => {
    plan = ['accepted', 'accepted', 'uncertain']
    const result = await service.send(draft)
    expect(result.status).toBe('partial')
    expect(result.message).toContain("Delivery to 1 isn't confirmed.")
    await service.sendsSettled()
    const before = await localDraft()
    await expect(service.recoverRejected(draftId)).rejects.toThrow(
      'There are no refused recipients to recover for this message.',
    )
    expect((await journal()).dismissed).toBeUndefined()
    expect(await localDraft()).toEqual(before)
    expect(before).toMatchObject({ status: 'sent', text: 'Hello' })
    expect(await service.drafts()).toHaveLength(1)
    expect(await service.submissions()).toMatchObject([
      { draftId, state: 'partial', rejected: [], unconfirmed: [kim] },
    ])
  })
  it('a first copy that may have arrived leaves the whole send unconfirmed, never resent', async () => {
    plan = ['uncertain']
    expect((await service.send(draft)).status).toBe('uncertain')
    expect(await journal()).toMatchObject({ state: 'uncertain', unconfirmed: [alex] })
    expect((await localDraft())?.status).toBe('uncertain')
    expect((await service.send(draft)).status).toBe('uncertain')
    expect(submitCopies).toHaveBeenCalledTimes(1)
  })
  describe('an unconfirmed tracked send', () => {
    const one = { ...draft, cc: [], bcc: [] }
    /** The reply to DATA is lost, but Gmail accepted the copy and filed its merged Sent copy. */
    const lostReply = async (_s: unknown, _f: string, copies: Copies, progress?: Progress) => {
      await progress!(copies[0].recipient)
      await gmailFiles(copies[0])
      return [{ recipient: alex, result: 'uncertain' as const, reason: reasons.uncertain }]
    }
    const expectOneCleanSentCopy = () => {
      const sent = server.box(SENT).messages
      expect(sent).toHaveLength(1)
      expect(text(sent[0].raw)).not.toContain('read.example.com')
      expect(
        server.box(ALL).messages.filter((m) => text(m.raw).includes('read.example.com')),
      ).toHaveLength(0)
    }
    it("replaces Gmail's merged copy right away and stays unconfirmed", async () => {
      submitCopies.mockImplementationOnce(lostReply)
      expect((await service.send(one)).status).toBe('uncertain')
      await service.sendsSettled()
      expectOneCleanSentCopy()
      expect(await journal()).toMatchObject({
        state: 'uncertain',
        unconfirmed: [alex],
        sentCopy: 'filed',
      })
      expect((await localDraft())?.status).toBe('uncertain')
      expect(submitCopies).toHaveBeenCalledTimes(1)
      expect(submit).not.toHaveBeenCalled()
    })
    it('files nothing when the server has no copy', async () => {
      plan = ['uncertain']
      expect((await service.send(one)).status).toBe('uncertain')
      await service.sendsSettled()
      expect(server.box(SENT).messages).toHaveLength(0)
      expect(server.box(ALL).messages).toHaveLength(0)
      expect(await journal()).toMatchObject({ state: 'uncertain', sentCopy: 'pending' })
    })
    it('replaces the merged copy after a crash mid-send, once reconnected', async () => {
      let reached!: () => void
      const during = new Promise<void>((resolve) => (reached = resolve))
      submitCopies.mockImplementationOnce(async (_s, _f, copies, progress) => {
        await progress!(alex)
        await gmailFiles(copies[0])
        reached()
        // The app dies during DATA.
        return new Promise<CopyOutcome[]>(() => {})
      })
      void service.send(one)
      await during
      const crashed = service
      await start()
      await stop(crashed)
      await connected()
      await vi.waitFor(async () => expect((await journal()).sentCopy).toBe('filed'))
      expectOneCleanSentCopy()
      expect((await journal()).state).toBe('uncertain')
      expect(submitCopies).toHaveBeenCalledTimes(1)
      expect(submit).not.toHaveBeenCalled()
    })
    /** Only the clock moves: timers stay real, so the IMAP fake and the store keep working. */
    const later = async (minutes: number) => {
      const at = Date.parse((await journal()).at)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(at + minutes * 60_000)
    }
    it('the periodic retry looks again for an hour, then stops', async () => {
      plan = ['uncertain']
      expect((await service.send(one)).status).toBe('uncertain')
      await service.sendsSettled()
      const filing = vi.spyOn(ImapProvider.prototype, 'fileSentCopy')
      await later(30)
      await service.refresh()
      expect(filing).toHaveBeenCalledTimes(1)
      expect((await journal()).sentCopy).toBe('pending')
      await later(61)
      await service.refresh()
      expect(filing).toHaveBeenCalledTimes(1)
      expect(submitCopies).toHaveBeenCalledTimes(1)
      expect(submit).not.toHaveBeenCalled()
    })
    it('a restart still looks once, however old the send', async () => {
      plan = ['uncertain']
      expect((await service.send(one)).status).toBe('uncertain')
      await service.sendsSettled()
      await gmailFiles(submitCopies.mock.calls[0][2][0])
      await stop(service)
      await later(61)
      await start()
      await connected()
      await vi.waitFor(async () => expect((await journal()).sentCopy).toBe('filed'))
      expectOneCleanSentCopy()
      expect((await journal()).state).toBe('uncertain')
    })
    it('a sent tracked journal still files after an hour', async () => {
      vi.spyOn(ImapProvider.prototype, 'fileSentCopy').mockRejectedValueOnce(
        new ProviderError('filing', 'The server did not accept the Sent copy.'),
      )
      expect((await service.send(draft)).status).toBe('sent')
      await service.sendsSettled()
      expect((await journal()).sentCopy).toBe('failed')
      await later(61)
      await service.refresh()
      expect((await journal()).sentCopy).toBe('filed')
      expectOneCleanSentCopy()
    })
    it('looks again before a dismiss marks it done', async () => {
      plan = ['uncertain']
      expect((await service.send(one)).status).toBe('uncertain')
      await service.sendsSettled()
      expect((await journal()).sentCopy).toBe('pending')
      // Gmail's merged copy turns up later.
      await gmailFiles(submitCopies.mock.calls[0][2][0])
      await service.dismissSubmission(draftId)
      expectOneCleanSentCopy()
      expect(await journal()).toMatchObject({
        state: 'uncertain',
        dismissed: true,
        sentCopy: 'filed',
      })
      expect(submitCopies).toHaveBeenCalledTimes(1)
    })
  })
  describe('a dropped connection while the Sent copy is replaced', () => {
    const one = { ...draft, cc: [], bcc: [] }
    const TRASH = '[Gmail]/Trash'
    /** The next IMAP command of this kind fails as if the connection dropped. */
    const dropAt = (hook: string) =>
      server.hooks.set(hook, () => {
        throw new ProviderError('network', 'Connection closed.')
      })
    /** The reply to DATA is lost; Gmail filed its copy, and the connection drops after the move. */
    const unconfirmedThenDrop = async (_s: unknown, _f: string, copies: Copies, p?: Progress) => {
      await p!(copies[0].recipient)
      await gmailFiles(copies[0])
      dropAt('APPEND:before')
      return [{ recipient: alex, result: 'uncertain' as const, reason: reasons.uncertain }]
    }
    const expectReplaced = () => {
      const sent = server.box(SENT).messages
      expect(sent).toHaveLength(1)
      expect(text(sent[0].raw)).not.toContain('read.example.com')
      expect(server.box(ALL).messages).toHaveLength(1)
      expect(server.box(TRASH).messages).toHaveLength(0)
    }
    const owedAfterDrop = async () => {
      submitCopies.mockImplementationOnce(unconfirmedThenDrop)
      expect((await service.send(one)).status).toBe('uncertain')
      await service.sendsSettled()
      // Gmail's copy is in Trash, the clean one isn't filed yet: the journal says it's owed.
      expect(server.box(TRASH).messages).toHaveLength(1)
      expect(server.box(SENT).messages).toHaveLength(0)
      expect(await journal()).toMatchObject({ state: 'uncertain', cleanOwed: true })
    }
    const later = async (minutes: number) => {
      const at = Date.parse((await journal()).at)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(at + minutes * 60_000)
    }
    const mimeFile = () => join(directory, 'outgoing', draftId + '.eml')
    it('the next retry of an unconfirmed send files the clean copy, even after an hour', async () => {
      await owedAfterDrop()
      await later(61)
      await service.refresh()
      expectReplaced()
      expect(await journal()).toMatchObject({ state: 'uncertain', sentCopy: 'filed' })
      expect((await journal()).cleanOwed).toBeUndefined()
      expect((await journal()).cleanUid).toBe(server.box(SENT).messages[0].uid)
      expect(submitCopies).toHaveBeenCalledTimes(1)
      expect(submit).not.toHaveBeenCalled()
    })
    it('a restart files the clean copy', async () => {
      await owedAfterDrop()
      await stop(service)
      await start()
      await connected()
      await vi.waitFor(async () => expect((await journal()).sentCopy).toBe('filed'))
      expectReplaced()
      expect(submitCopies).toHaveBeenCalledTimes(1)
    })
    it('after the APPEND, a restart confirms the copy without filing another', async () => {
      submitCopies.mockImplementationOnce(async (...args) => {
        const outcomes = await fakeCopies(...args)
        dropAt('APPEND:after')
        return outcomes
      })
      expect((await service.send(draft)).status).toBe('sent')
      await service.sendsSettled()
      expect(await journal()).toMatchObject({ sentCopy: 'uncertain', cleanOwed: true })
      await stop(service)
      await start()
      await connected()
      await vi.waitFor(async () => expect((await journal()).sentCopy).toBe('filed'))
      expectReplaced()
      // Filed once: the restart confirmed it in Sent instead of filing it again.
      expect(server.commands.filter((c) => c === 'APPEND').length).toBe(1)
    })
    it('a dismiss keeps the MIME while the clean copy is owed, and the retry still files', async () => {
      await owedAfterDrop()
      // The dismiss's own last look drops too.
      dropAt('APPEND:before')
      await service.dismissSubmission(draftId)
      expect(await journal()).toMatchObject({ dismissed: true, cleanOwed: true, mime: true })
      expect((await journal()).sentCopy).not.toBe('dismissed')
      expect(existsSync(mimeFile())).toBe(true)
      expect(await service.submissions()).toEqual([])
      await service.refresh()
      expectReplaced()
      expect(await journal()).toMatchObject({ dismissed: true, sentCopy: 'filed' })
      expect(existsSync(mimeFile())).toBe(false)
    })
    it('a dismissed partial send still files its owed Sent copy', async () => {
      plan = ['accepted', 'rejected', 'rejected']
      submitCopies.mockImplementationOnce(async (...args) => {
        const outcomes = await fakeCopies(...args)
        dropAt('APPEND:before')
        return outcomes
      })
      expect((await service.send(draft)).status).toBe('partial')
      await service.sendsSettled()
      expect(await journal()).toMatchObject({ cleanOwed: true })
      await service.dismissSubmission(draftId)
      expect(await journal()).toMatchObject({ dismissed: true, mime: true })
      expect(existsSync(mimeFile())).toBe(true)
      await service.refresh()
      expectReplaced()
      expect(await journal()).toMatchObject({ sentCopy: 'filed' })
    })
  })
  describe('a merged copy Gmail files after the clean one', () => {
    const later = async (minutes: number) => {
      const at = Date.parse((await journal()).at)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(at + minutes * 60_000)
    }
    const sentLate = async () => {
      expect((await service.send(draft)).status).toBe('sent')
      await service.sendsSettled()
      expect((await journal()).sweepAt).toBeDefined()
      // Gmail files its merged copy, first recipient's image included, after the replacement.
      await gmailFiles(submitCopies.mock.calls[0][2][0])
      expect(server.box(SENT).messages).toHaveLength(2)
    }
    const expectOneClean = () => {
      const sent = server.box(SENT).messages
      expect(sent).toHaveLength(1)
      expect(text(sent[0].raw)).not.toContain('read.example.com')
      expect(text(sent[0].raw)).toMatch(/^Bcc:.*kim@example\.org/im)
      expect(server.box('[Gmail]/Trash').messages).toHaveLength(0)
    }
    it('is removed by one sweep about a minute later', async () => {
      await sentLate()
      // Not before the minute is up.
      await service.refresh()
      expect(server.box(SENT).messages).toHaveLength(2)
      await later(2)
      await service.refresh()
      expectOneClean()
      expect((await journal()).sweepAt).toBeUndefined()
    })
    it('is removed after a restart before the sweep ran', async () => {
      await sentLate()
      await stop(service)
      await later(2)
      await start()
      await connected()
      await vi.waitFor(async () => expect((await journal()).sweepAt).toBeUndefined())
      expectOneClean()
    })
    it('is no longer looked for an hour after filing', async () => {
      await sentLate()
      await later(70)
      await service.refresh()
      expect((await journal()).sweepAt).toBeUndefined()
      expect(server.box(SENT).messages).toHaveLength(2)
    })
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
    await stop(service)
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
  it('when one copy per person would be too large', async () => {
    // 3 MiB × 4/3 × 10 recipients is over the 30 MiB limit.
    const path = join(directory, 'big.zip')
    await writeFile(path, Buffer.alloc(3 * 1024 * 1024, 1))
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [path] })
    const attachments = await service.stageAttachments()
    const ten = many.slice(0, 10)
    expect((await service.send({ ...draft, to: ten, cc: [], bcc: [], attachments })).status).toBe(
      'sent',
    )
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submitCopies).not.toHaveBeenCalled()
    expect(await untrackedReasons()).toEqual(['tooLarge'])
    expect(isTrackedMessageId(password, (await journal()).messageId)).toBe(false)
  })
  /** Signs in again, so the account is looked at afresh on the changed server. */
  const reconnect = async () => {
    await service.connect(input)
    await connected()
  }
  it('when the IMAP server is not Gmail', async () => {
    server.gmail = false
    await reconnect()
    expect(service.accounts[0].readStatus).toBeUndefined()
    expect((await service.send(draft)).status).toBe('sent')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submitCopies).not.toHaveBeenCalled()
    expect(await untrackedReasons()).toEqual(['unsupported'])
    expect(isTrackedMessageId(password, (await journal()).messageId)).toBe(false)
  })
  it("when Gmail's All Mail is not shown in IMAP", async () => {
    server.boxes.delete(ALL)
    await reconnect()
    expect(service.accounts[0].readStatus).toBeUndefined()
    expect((await service.send(draft)).status).toBe('sent')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submitCopies).not.toHaveBeenCalled()
    expect(await untrackedReasons()).toEqual(['unsupported'])
  })
  it('a Gmail account is tracked', async () => {
    expect(service.accounts[0].readStatus).toBe(true)
    expect((await service.send(draft)).status).toBe('sent')
    expect(submitCopies).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()
  })
  it('when the email is signed', async () => {
    // A signed send may fail before submitting here, since no OpenPGP key exists.
    await service.send({ ...draft, encryption: 'sign' }).catch(() => undefined)
    expect(submitCopies).not.toHaveBeenCalled()
    expect(await untrackedReasons()).toEqual(['protected'])
  })
  const quoted =
    '<p>Hello</p><blockquote><img src="https://read.example.com/p/OLDOLDOLDOLDOLDOLDOLDO.gif"></blockquote>'
  it('quoted Worker images are stripped from every send', async () => {
    await setReadStatus(false)
    await service.send({ ...draft, html: quoted })
    expect(submit).toHaveBeenCalledTimes(1)
    const mime = text(submit.mock.calls[0][2])
    expect(mime).not.toContain('OLDOLD')
    expect(mime).toContain('Hello')
  })
  it('quoted Worker images are stripped from every copy of a tracked send', async () => {
    expect((await service.send({ ...draft, html: quoted })).status).toBe('sent')
    expect(submit).not.toHaveBeenCalled()
    const copies = submitCopies.mock.calls[0][2]
    expect(copies).toHaveLength(3)
    for (const copy of copies) {
      expect(text(copy.mime)).not.toContain('OLDOLD')
      expect((await parseMime(copy.mime)).html).toContain('read.example.com/p/')
    }
    await service.sendsSettled()
    expect(server.box(SENT).messages).toHaveLength(1)
    expect(text(server.box(SENT).messages[0].raw)).not.toContain('read.example.com')
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

describe('Read status: testing the Worker', () => {
  /** The passwords sent to each address, in order. */
  let asked: { url: string; auth: string | null }[]
  beforeEach(() => {
    asked = []
    workerFetch = async (url, init) => {
      asked.push({
        url: String(url),
        auth: new Headers(init?.headers).get('authorization'),
      })
      return new Response(JSON.stringify({ records: [], next: 0 }), {
        headers: { 'content-type': 'application/json' },
      })
    }
  })
  it('uses the saved password for the saved address', async () => {
    expect((await service.testReadStatus(base)).ok).toBe(true)
    expect(asked.map((a) => a.auth)).toEqual(['Bearer ' + password])
  })
  it('never sends the saved password to another address', async () => {
    expect(await service.testReadStatus('https://other.example.com')).toEqual({
      ok: false,
      message: 'Enter the password for this address.',
    })
    expect(asked).toEqual([])
  })
  it('tests another address with the password typed for it', async () => {
    expect((await service.testReadStatus('https://other.example.com', 'typed-password')).ok).toBe(
      true,
    )
    expect(asked).toEqual([expect.objectContaining({ auth: 'Bearer typed-password' })])
    expect(asked[0].url).toMatch(/^https:\/\/other\.example\.com\//)
  })
})

describe('Read status: a previous Worker address', () => {
  const old = 'https://old.example.com'
  const moved = async () => {
    await service.setSettings({
      ...service.settings,
      readStatus: { enabled: true, workerUrl: old },
    })
    await setReadStatus(true)
    expect(service.settings.readStatus?.previousWorkerUrls).toEqual([old])
    expect((await store.read<any>('settings', {})).readStatus.previousWorkerUrls).toEqual([old])
  }
  it('its images are still never loaded, also through a redirect', async () => {
    await moved()
    await service.setSettings({ ...service.settings, remoteImages: true })
    vi.mocked(publicFetch).mockClear()
    expect(await service.remoteImage(`${old}/p/AbCdEfGhIjKlMnOpQrStUv.gif`)).toBeNull()
    expect(publicFetch).not.toHaveBeenCalled()
    vi.mocked(publicFetch).mockResolvedValueOnce({
      status: 302,
      type: '',
      bytes: Buffer.alloc(0),
      location: `${old}/p/AbCdEfGhIjKlMnOpQrStUv.gif`,
    } as Awaited<ReturnType<typeof publicFetch>>)
    expect(await service.remoteImage('https://images.example.net/logo.png')).toBeNull()
    expect(publicFetch).toHaveBeenCalledTimes(1)
  })
  it('its images are stripped from outgoing mail', async () => {
    await moved()
    await setReadStatus(false)
    const quoted = `<p>Hello</p><blockquote><img src="${old}/p/OLDOLDOLDOLDOLDOLDOLDO.gif"></blockquote>`
    await service.send({ ...draft, html: quoted })
    const mime = text(submit.mock.calls[0][2])
    expect(mime).not.toContain('OLDOLD')
    expect(mime).toContain('Hello')
  })
})

describe('Read status: the app never loads the Worker', () => {
  it('refuses an image from the Worker even with remote images on', async () => {
    await service.setSettings({ ...service.settings, remoteImages: true })
    vi.mocked(publicFetch).mockClear()
    expect(await service.remoteImage(`${base}/p/AbCdEfGhIjKlMnOpQrStUv.gif`)).toBeNull()
    expect(await service.remoteImage(`${base}./p/AbCdEfGhIjKlMnOpQrStUv.gif`)).toBeNull()
    expect(publicFetch).not.toHaveBeenCalled()
    await service.remoteImage('https://images.example.net/logo.png')
    expect(publicFetch).toHaveBeenCalledTimes(1)
  })
})
