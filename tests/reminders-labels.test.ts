import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Account, ImapConnectionConfig, SplitScope } from '../packages/core/src'
import { ImapProvider } from '../packages/imap/src'
import { openInProcessIndex } from '../apps/desktop/src/main/imap-index/sqlite-index'
import { planMutation } from '../apps/desktop/src/main/mail-mutations'
import { FakeImapServer, FakePort, type FakeMessageInput } from './support/fake-imap'

const config: ImapConnectionConfig = {
  protocol: 'imap',
  email: 'me@example.com',
  incoming: { host: 'imap.example.com', port: 993, security: 'tls', username: 'me' },
  outgoing: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'me' },
  outgoingSameCredentials: true,
}
const me = { name: 'Me', email: 'me@example.com' }
const alex = { name: 'Alex', email: 'alex@example.org' }
const important: Extract<SplitScope, { kind: 'important' }> = {
  kind: 'important',
  always: [],
  never: [],
}
const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString()
const noReminder = 'Warpmail/No reminder'

let directory: string
let server: FakeImapServer
let providers: ImapProvider[] = []
let account: Account

async function connected() {
  const p = new ImapProvider({
    connectionId: 'c1',
    name: 'Work',
    config,
    password: 'disposable',
    index: openInProcessIndex(join(directory, 'index-' + providers.length + '.sqlite')),
    readAttachment: async () => new TextEncoder().encode('attached'),
    background: false,
    ports: server.port,
    timing: { sentCopyGraceMs: 0, initialBatch: 5, historicalBatch: 5, previews: 0 },
  })
  providers.push(p)
  ;[account] = await p.connect()
  await sync(p)
  return p
}
const sync = (p: ImapProvider) => (p as any).syncPass('all') as Promise<void>
/** Every indexed folder, hidden ones included. */
const indexed = (p: ImapProvider) =>
  (p as any).index.listMailboxes((p as any).accountId) as Promise<{ id: string; path: string }[]>
const idOf = async (p: ImapProvider, path: string) =>
  (await indexed(p)).find((b) => b.path === path)!.id
const facts = (p: ImapProvider) => p.reminderFacts(account, { important, sinceMs: 0 })

const email: FakeMessageInput = {
  emailId: '901',
  messageId: 'question@example.org',
  subject: 'A question',
  from: [alex],
  to: [me],
  date: at(1),
  text: 'Can you look?',
}
/** Gmail: the email is in INBOX and All Mail; new labels bring their parent along. */
function gmail(paths = ['INBOX', '[Gmail]/All Mail']) {
  server.capabilities.add('X-GM-EXT-1')
  server.createsParents = true
  server.addMailbox('[Gmail]/All Mail', '\\All')
  for (const path of paths) server.deliver(path, email)
}
/** Where each COPY was made from and to. */
function copies() {
  const made: { from: string; to: string }[] = []
  const copy = FakePort.prototype.copy
  vi.spyOn(FakePort.prototype, 'copy').mockImplementation(function (
    this: FakePort,
    uids,
    destination,
  ) {
    made.push({ from: (this as any).selected, to: destination })
    return copy.call(this, uids, destination)
  })
  return made
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'warpmail-labels-'))
  server = new FakeImapServer()
  providers = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const p of providers) await p.close()
  await rm(directory, { recursive: true, force: true })
})

describe('Warpmail label folders', () => {
  it('creates the label folder on first use and copies the email from All Mail once', async () => {
    gmail()
    const made = copies()
    const p = await connected()
    await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
    expect(server.boxes.has('Warpmail')).toBe(true)
    expect(server.box(noReminder).messages.map((m) => m.input.messageId)).toEqual([
      'question@example.org',
    ])
    expect(made).toEqual([{ from: '[Gmail]/All Mail', to: noReminder }])
    await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
    expect(server.box(noReminder).messages).toHaveLength(1)
    expect(made).toHaveLength(1)
    expect(server.commands.filter((c) => c === 'CREATE')).toHaveLength(1)
  })
  it('copies from INBOX when All Mail does not have it', async () => {
    for (const path of ['Archive', 'Sent', 'INBOX']) server.deliver(path, email)
    const made = copies()
    const p = await connected()
    await p.labelMessage!(account, 'followUp', 'question@example.org', true)
    expect(made).toEqual([{ from: 'INBOX', to: 'Warpmail/Follow up' }])
  })
  it('copies from Sent when neither All Mail nor INBOX has it', async () => {
    for (const path of ['Archive', 'Sent']) server.deliver(path, { ...email, from: [me] })
    const made = copies()
    const p = await connected()
    await p.labelMessage!(account, 'followUp', 'question@example.org', true)
    expect(made).toEqual([{ from: 'Sent', to: 'Warpmail/Follow up' }])
  })
  it('never copies from Trash or Junk', async () => {
    for (const path of ['Trash', 'Junk']) server.deliver(path, email)
    const made = copies()
    const p = await connected()
    await expect(
      p.labelMessage!(account, 'noReminder', 'question@example.org', true),
    ).rejects.toMatchObject({ code: 'notFound' })
    expect(made).toEqual([])
  })
  it('adding a label that is already there changes nothing and announces nothing', async () => {
    gmail()
    const made = copies()
    const p = await connected()
    await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
    const events: string[] = []
    // Previews filled in the background after the first add are announced as historical.
    p.subscribe((event) => {
      if (event.type === 'changed' && !event.historical) events.push(event.type)
    })
    const before = server.commands.length
    await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
    expect(made).toHaveLength(1)
    expect(events).not.toContain('changed')
    expect(server.commands.slice(before)).not.toContain('STATUS')
  })
  it('asks for a full sync when the label folder was rebuilt during a remove', async () => {
    gmail()
    const p = await connected()
    await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
    server.resetUidValidity(noReminder)
    const requested = vi.spyOn(p, 'requestSync')
    await p.labelMessage!(account, 'noReminder', 'question@example.org', false)
    expect(server.box(noReminder).messages).toEqual([])
    expect(requested).toHaveBeenCalledWith('all')
  })
  for (const action of ['move', 'spam', 'trash'] as const)
    it('keeps the labels when its conversation is acted on (' + action + ')', async () => {
      gmail(['INBOX'])
      const p = await connected()
      await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
      const [thread] = (await p.query(account, { view: 'inbox' })).items
      const boxes = await p.mailboxes(account)
      const messages = await p.conversationMetadata(account, [thread!.id])
      const archive = boxes.find((b) => b.name === 'Archive')!.id
      const plan = planMutation(messages, boxes, action, archive)
      const result = await p.update(account, plan.changes, plan.destroy, p.getStateToken(account))
      expect(result.failures).toEqual([])
      expect(server.box('INBOX').messages).toEqual([])
      expect(server.box(noReminder).messages).toHaveLength(1)
      await sync(p)
      expect(server.box(noReminder).messages).toHaveLength(1)
      if (action === 'move') expect((await facts(p))[0]?.labels.noReminder).toBe(true)
    })
  it('skips a location whose UIDVALIDITY changed on the server', async () => {
    gmail()
    const made = copies()
    const p = await connected()
    server.resetUidValidity('[Gmail]/All Mail')
    await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
    expect(made).toEqual([{ from: 'INBOX', to: noReminder }])
  })
  it('uses a label folder another device made instead of creating it again', async () => {
    gmail()
    const p = await connected()
    server.addMailbox('Warpmail')
    server.addMailbox(noReminder)
    await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
    expect(server.commands).not.toContain('CREATE')
    expect(server.box(noReminder).messages).toHaveLength(1)
  })
  it('shows the label in reminder facts at once, and clears it on remove', async () => {
    gmail()
    const p = await connected()
    expect((await facts(p))[0]!.labels).toEqual({
      noReminder: false,
      followUp: false,
      returned: false,
    })
    await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
    expect((await facts(p))[0]!.labels).toEqual({
      noReminder: true,
      followUp: false,
      returned: false,
    })
    await p.labelMessage!(account, 'noReminder', 'question@example.org', false)
    expect((await facts(p))[0]!.labels).toEqual({
      noReminder: false,
      followUp: false,
      returned: false,
    })
    expect(server.box(noReminder).messages).toEqual([])
    // The email itself stays where it was.
    expect(server.box('INBOX').messages).toHaveLength(1)
    expect(server.box('[Gmail]/All Mail').messages).toHaveLength(1)
  })
  it('removing a label that was never added does nothing', async () => {
    gmail()
    const p = await connected()
    await p.labelMessage!(account, 'followUp', 'question@example.org', false)
    expect(server.boxes.has('Warpmail/Follow up')).toBe(false)
  })
  it('leaves the Warpmail folders out of the folder list', async () => {
    gmail()
    const p = await connected()
    await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
    await sync(p)
    expect((await indexed(p)).map((b) => b.path)).toContain(noReminder)
    const names = (await p.mailboxes(account)).map((b) => b.name)
    expect(names).not.toContain('Warpmail')
    expect(names).not.toContain('No reminder')
  })
  it('never shows the label copy of an email in INBOX', async () => {
    gmail()
    const p = await connected()
    await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
    const inbox = await idOf(p, 'INBOX')
    const all = await p.query(account, { view: 'all' })
    expect(all.total).toBe(1)
    expect(all.items[0]!.messages.map((m) => Object.keys(m.mailboxIds))).toEqual([[inbox]])
  })
  it('never shows the label copy of an archived email, nor counts it in All mail or search', async () => {
    gmail(['[Gmail]/All Mail'])
    const p = await connected()
    await p.labelMessage!(account, 'noReminder', 'question@example.org', true)
    const allMail = await idOf(p, '[Gmail]/All Mail')
    const all = await p.query(account, { view: 'all' })
    expect(all.total).toBe(1)
    expect(all.items[0]!.messages.map((m) => Object.keys(m.mailboxIds))).toEqual([[allMail]])
    const thread = await p.conversation(account, all.items[0]!.id)
    expect(thread.map((m) => Object.keys(m.mailboxIds))).toEqual([[allMail]])
    const found = await p.query(account, { view: 'all', text: 'question' })
    expect(found.total).toBe(1)
    expect(found.items[0]!.messages.map((m) => Object.keys(m.mailboxIds))).toEqual([[allMail]])
  })
  it('rejects an unknown Message-ID with notFound', async () => {
    gmail()
    const p = await connected()
    await expect(
      p.labelMessage!(account, 'noReminder', 'missing@example.org', true),
    ).rejects.toMatchObject({ code: 'notFound', message: 'This email is no longer on the server.' })
    expect(server.commands).not.toContain('CREATE')
  })
})
