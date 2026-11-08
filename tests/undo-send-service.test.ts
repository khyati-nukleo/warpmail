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
import type { UndoSendClock } from '../apps/desktop/src/main/undo-send'
import { ImapProvider } from '../packages/imap/src'
import type { submitSmtpCopies } from '../packages/imap/src/smtp'
import { parseMime } from '../packages/mime/src'
import type {
  AppEvent,
  ConnectInput,
  CopyOutcome,
  Draft,
  HeldSend,
  SubmissionOutcome,
} from '../packages/core/src'
import { FakeImapServer } from './support/fake-imap'

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
  to: [{ name: 'Alex', email: 'alex@example.org' }],
  cc: [{ name: 'Sam', email: 'sam@example.org' }],
  bcc: [],
  subject: 'Plans',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [],
  updatedAt: '2026-11-07T09:59:00.000Z',
  status: 'local',
}

/** The countdown's clock, moved by hand; everything else runs on real time. */
function manualClock(): UndoSendClock & { advance(ms: number): void } {
  let now = Date.parse('2026-11-07T10:00:00.000Z')
  let next = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => now,
    setTimeout: (run, ms) => {
      timers.set(next, { at: now + ms, run })
      return next++
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id)
          timer.run()
        }
    },
  }
}

type Copies = Parameters<typeof submitSmtpCopies>[2]
type Progress = NonNullable<Parameters<typeof submitSmtpCopies>[3]>
let directory: string
let server: FakeImapServer
let service: MailService
let store: JsonStore
let clock: ReturnType<typeof manualClock>
let events: AppEvent[]
let running: MailService[]
let closing: Promise<void>[]
let submit: ReturnType<typeof vi.fn<(...args: any[]) => Promise<SubmissionOutcome>>>
let submitCopies: ReturnType<typeof vi.fn<typeof submitSmtpCopies>>
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
async function start() {
  store = new JsonStore(directory)
  events = []
  service = new MailService(store, (event) => events.push(event), {
    providers: factory,
    undoSendClock: clock,
    readStatusFetch: async () => {
      throw new Error('offline')
    },
  })
  running.push(service)
  await service.init()
}
/** The app is killed: nothing of it runs afterwards, and nothing it had in memory survives. */
async function kill() {
  running = running.filter((s) => s !== service)
  service.dispose()
  await Promise.allSettled(closing)
  await start()
}
const connected = () => vi.waitFor(() => expect(service.accounts[0]?.status).toBe('connected'))
const journal = async () =>
  (await store.read<any[]>('submissions', [])).find((j) => j.draftId === draftId)
const records = () => store.read<unknown[]>('undo-sends', [])
const localDraft = async () => (await service.drafts()).find((d) => d.id === draftId)
const lastHeld = () =>
  events.filter((e): e is Extract<AppEvent, { type: 'heldSends' }> => e.type === 'heldSends').at(-1)
    ?.sends as HeldSend[] | undefined
/** Waits until the draft's countdown has started, so moving the clock reaches its deadline. */
const armed = (id = draftId) =>
  vi.waitFor(() => expect(lastHeld()?.find((s) => s.draftId === id)?.state).toBe('waiting'))
/** Lets the service's own awaits (store writes, IMAP) run while the clock stands still. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'inlark-undo-send-'))
  server = new FakeImapServer()
  clock = manualClock()
  running = []
  closing = []
  submit = vi.fn(async (_settings, envelope) => ({ accepted: envelope.to, rejected: [] }))
  submitCopies = vi.fn()
  await start()
  await service.connect(input)
  await service.saveDraft(draft)
})
afterEach(async () => {
  for (const s of running) s.dispose()
  await Promise.allSettled(closing)
  vi.restoreAllMocks()
  await new Promise((r) => setTimeout(r, 20))
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('Undo send through the mail service', () => {
  it('nothing reaches the server during the countdown; then it is sent and filed as usual', async () => {
    const result = service.sendWithUndo(draft)
    await armed()
    expect(lastHeld()).toMatchObject([{ draftId, state: 'waiting', subject: 'Plans' }])
    clock.advance(9_999)
    await settle()
    expect(submit).not.toHaveBeenCalled()
    expect(server.box('Sent').messages).toHaveLength(0)
    expect(await journal()).toBeUndefined()
    clock.advance(1)
    expect(await result).toMatchObject({ status: 'sent' })
    expect(submit).toHaveBeenCalledTimes(1)
    await service.sendsSettled()
    expect(server.box('Sent').messages).toHaveLength(1)
    expect(await localDraft()).toMatchObject({ status: 'sent', text: '' })
    expect(await records()).toEqual([])
    expect(lastHeld()).toEqual([])
  })
  it('undo sends nothing and leaves the draft in Drafts exactly as it was', async () => {
    const result = service.sendWithUndo(draft)
    await armed()
    clock.advance(4_000)
    const undo = await service.undoSend(draftId)
    expect(undo).toEqual({ undone: true, draft: expect.objectContaining(draft) })
    expect(await result).toMatchObject({ status: 'undone' })
    clock.advance(60_000)
    await settle()
    expect(submit).not.toHaveBeenCalled()
    expect(server.box('Sent').messages).toHaveLength(0)
    expect(await journal()).toBeUndefined()
    expect(await localDraft()).toMatchObject({ ...draft, status: 'local' })
    expect(await records()).toEqual([])
    // Sending it again afterwards is a fresh countdown.
    const again = service.sendWithUndo(draft)
    await armed()
    clock.advance(10_000)
    expect(await again).toMatchObject({ status: 'sent' })
    expect(submit).toHaveBeenCalledTimes(1)
  })
  it('sends straight away when Undo send is off, as before', async () => {
    await service.setSettings({ ...service.settings, undoSendSeconds: 0 })
    expect(await service.sendWithUndo(draft)).toMatchObject({ status: 'sent' })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(await records()).toEqual([])
  })
  it('after a kill mid-countdown, "Send it anyway" sends it on the next launch exactly once', async () => {
    void service.sendWithUndo(draft)
    await armed()
    clock.advance(3_000)
    await kill()
    expect(submit).not.toHaveBeenCalled()
    clock.advance(60_000)
    await kill()
    await connected()
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await vi.waitFor(async () => expect(await records()).toEqual([]))
    expect(await journal()).toMatchObject({ state: 'sent' })
    await kill()
    await connected()
    clock.advance(60_000)
    await settle()
    expect(submit).toHaveBeenCalledTimes(1)
  })
  it('after a kill during sending, the next launch never sends again', async () => {
    let arrived!: () => void
    const submitting = new Promise<void>((resolve) => (arrived = resolve))
    submit.mockImplementationOnce(() => {
      arrived()
      return new Promise(() => {})
    })
    void service.sendWithUndo(draft)
    await armed()
    clock.advance(10_000)
    await submitting
    await kill()
    await connected()
    clock.advance(60_000)
    await settle()
    expect(submit).toHaveBeenCalledTimes(1)
    // The send journal's own recovery reports it, as for any send cut off by a crash.
    expect(await journal()).toMatchObject({ state: 'uncertain' })
    expect(await records()).toEqual([])
  })
  it('after a kill, "Keep it as a draft" sends nothing and saves it to the server Drafts', async () => {
    void service.sendWithUndo(draft)
    await armed()
    clock.advance(3_000)
    await service.setSettings({ ...service.settings, undoSendOnQuit: 'draft' })
    await kill()
    await connected()
    await vi.waitFor(() => expect(server.box('Drafts').messages).toHaveLength(1))
    clock.advance(60_000)
    await settle()
    expect(submit).not.toHaveBeenCalled()
    expect(await localDraft()).toMatchObject({ text: 'Hello', status: 'synced' })
    expect(await records()).toEqual([])
  })
  it('quitting with "Send it anyway" waits out the countdown out of sight, then sends once', async () => {
    const result = service.sendWithUndo(draft)
    await armed()
    clock.advance(2_000)
    let done = false
    const quit = service.heldSendsOnQuit()
    expect(quit).toBeDefined()
    void quit!.then(() => (done = true))
    clock.advance(7_999)
    await settle()
    // Not before its own deadline, even with the window gone.
    expect(submit).not.toHaveBeenCalled()
    expect(server.box('Sent').messages).toHaveLength(0)
    expect(done).toBe(false)
    clock.advance(1)
    expect(await result).toMatchObject({ status: 'sent' })
    await quit
    await service.sendsSettled()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(server.box('Sent').messages).toHaveLength(1)
    expect(await records()).toEqual([])
    clock.advance(60_000)
    await settle()
    expect(submit).toHaveBeenCalledTimes(1)
  })
  it('quitting with "Keep it as a draft" sends nothing and saves it to the server Drafts', async () => {
    await service.setSettings({ ...service.settings, undoSendOnQuit: 'draft' })
    const result = service.sendWithUndo(draft)
    await armed()
    await service.heldSendsOnQuit()
    expect(await result).toMatchObject({ status: 'unsent' })
    expect(server.box('Drafts').messages).toHaveLength(1)
    clock.advance(60_000)
    await settle()
    expect(submit).not.toHaveBeenCalled()
  })
  it('quitting with "Keep it as a draft" while a Send is still saving saves it to the server Drafts', async () => {
    await service.setSettings({ ...service.settings, undoSendOnQuit: 'draft' })
    const result = service.sendWithUndo(draft)
    const quit = service.heldSendsOnQuit()
    expect(quit).toBeDefined()
    await quit
    expect(await result).toMatchObject({ status: 'unsent' })
    expect(server.box('Drafts').messages).toHaveLength(1)
    expect(await localDraft()).toMatchObject({ status: 'synced', text: 'Hello' })
    expect(submit).not.toHaveBeenCalled()
  })
  it('quitting with "Send it anyway" while a Send is still saving counts it down too', async () => {
    const result = service.sendWithUndo(draft)
    const quit = service.heldSendsOnQuit()
    expect(quit).toBeDefined()
    await armed()
    clock.advance(9_999)
    await settle()
    expect(submit).not.toHaveBeenCalled()
    clock.advance(1)
    expect(await result).toMatchObject({ status: 'sent' })
    await quit
    await service.sendsSettled()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(server.box('Sent').messages).toHaveLength(1)
  })
  it('a server draft save already running at Send never overwrites the held copy', async () => {
    const reminders = (service as unknown as { reminders: { afterSend: unknown } }).reminders
    const afterSend = vi.fn(async () => {})
    reminders.afterSend = afterSend
    // Started before Send, with the draft as it was before the follow-up switch was read.
    const syncing = service.syncDraft(draft)
    const result = service.sendWithUndo({ ...draft, followUp: true })
    await syncing
    await armed()
    await settle()
    expect(await localDraft()).toMatchObject({ followUp: true })
    clock.advance(10_000)
    expect(await result).toMatchObject({ status: 'sent' })
    await service.sendsSettled()
    expect(afterSend).toHaveBeenCalledTimes(1)
    expect(afterSend.mock.calls[0]).toMatchObject([{ followUp: true }])
    expect(submit).toHaveBeenCalledTimes(1)
  })
  it('a draft edited during the countdown is not sent', async () => {
    const result = service.sendWithUndo(draft)
    await armed()
    await service.saveDraft({ ...draft, text: 'Changed', updatedAt: '2026-11-07T10:00:03.000Z' })
    clock.advance(10_000)
    expect(await result).toMatchObject({ status: 'unsent' })
    expect(submit).not.toHaveBeenCalled()
    expect(await localDraft()).toMatchObject({ text: 'Changed' })
  })
  it('background draft saves leave a held draft alone: nothing reaches Drafts on the server', async () => {
    const result = service.sendWithUndo(draft)
    await armed()
    // The periodic save of drafts idle for 10 seconds, and a save asked for directly.
    await (service as unknown as { syncPendingDrafts(): Promise<void> }).syncPendingDrafts()
    await service.syncDraft(draft)
    await settle()
    expect(server.box('Drafts').messages).toHaveLength(0)
    clock.advance(10_000)
    expect(await result).toMatchObject({ status: 'sent' })
  })
  it('a draft deleted during the countdown is not sent', async () => {
    const result = service.sendWithUndo(draft)
    await armed()
    await service.deleteDraft(draftId)
    clock.advance(10_000)
    expect(await result).toMatchObject({ status: 'unsent' })
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('Undo send with Read status', () => {
  const SENT = '[Gmail]/Sent Mail'
  const ALL = '[Gmail]/All Mail'
  beforeEach(async () => {
    for (const s of running) s.dispose()
    await Promise.allSettled(closing)
    running = []
    await rm(directory, { recursive: true, force: true })
    directory = await mkdtemp(join(tmpdir(), 'inlark-undo-send-gmail-'))
    server = new FakeImapServer()
    for (const path of [...server.boxes.keys()]) if (path !== 'INBOX') server.boxes.delete(path)
    server.addMailbox(SENT, '\\Sent')
    server.addMailbox(ALL, '\\All')
    server.addMailbox('[Gmail]/Trash', '\\Trash')
    server.addMailbox('[Gmail]/Drafts', '\\Drafts')
    server.gmail = true
    // One copy per recipient; Gmail files the first in Sent itself, image included.
    submitCopies.mockImplementation(
      async (_settings: unknown, _from: string, copies: Copies, progress?: Progress) => {
        const outcomes: CopyOutcome[] = []
        for (const copy of copies) {
          await progress!(copy.recipient, outcomes.at(-1))
          outcomes.push({ recipient: copy.recipient, result: 'accepted' })
        }
        const { messageId, subject, html } = await parseMime(copies[0].mime)
        for (const box of [SENT, ALL])
          server.deliver(box, { messageId, subject, html, flags: ['\\Seen'] })
        return outcomes
      },
    )
    await start()
    await service.connect(input)
    await service.setSettings({
      ...service.settings,
      readStatus: { enabled: true, workerUrl: 'https://read.example.com' },
    })
    await service.readStatusSecret.set('test-password')
    await service.saveDraft(draft)
  })
  it('a tracked email still goes one copy per recipient after the countdown', async () => {
    const result = service.sendWithUndo(draft)
    await armed()
    clock.advance(9_999)
    await settle()
    expect(submitCopies).not.toHaveBeenCalled()
    expect(server.box(SENT).messages).toHaveLength(0)
    clock.advance(1)
    expect(await result).toMatchObject({ status: 'sent' })
    expect(submit).not.toHaveBeenCalled()
    expect(submitCopies).toHaveBeenCalledTimes(1)
    expect(submitCopies.mock.calls[0][2].map((c) => c.recipient)).toEqual([
      'alex@example.org',
      'sam@example.org',
    ])
    await service.sendsSettled()
    expect(await journal()).toMatchObject({ tracked: true, sentCopy: 'filed' })
    // Gmail's copy with the image was replaced by one clean copy.
    expect(server.box(SENT).messages).toHaveLength(1)
    expect(new TextDecoder().decode(server.box(SENT).messages[0].raw)).not.toContain(
      'read.example.com',
    )
  })
})
