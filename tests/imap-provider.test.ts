import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { ProviderError, type Account, type ImapConnectionConfig } from '../packages/core/src'
import { ImapProvider, limitsFor, imapFlowOptions, ImapFlowPort } from '../packages/imap/src'
import { SourceCache } from '../packages/imap/src/provider'
import { openInProcessIndex } from '../apps/desktop/src/main/imap-index/sqlite-index'
import { FakeImapServer, FakePort } from './support/fake-imap'

const config: ImapConnectionConfig = {
  protocol: 'imap',
  email: 'me@example.com',
  incoming: { host: 'imap.example.com', port: 993, security: 'tls', username: 'me' },
  outgoing: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'me' },
  outgoingSameCredentials: true,
}
const me = { name: 'Me', email: 'me@example.com' }
const alex = { name: 'Alex', email: 'alex@example.org' }
let directory: string
let server: FakeImapServer
let providers: ImapProvider[] = []
let account: Account

function provider(options: Partial<ConstructorParameters<typeof ImapProvider>[0]> = {}) {
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
    ...options,
  })
  providers.push(p)
  return p
}
async function connected(options: Parameters<typeof provider>[0] = {}) {
  const p = provider(options)
  ;[account] = await p.connect()
  return p
}
/** Runs the provider's background synchronization once, as the loop would. */
const sync = (p: ImapProvider) => (p as any).syncPass('all') as Promise<void>
const historical = async (p: ImapProvider) => {
  while (await (p as any).historicalBatch());
}
const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString()

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'inlark-imap-'))
  server = new FakeImapServer()
  providers = []
})
afterEach(async () => {
  for (const p of providers) await p.close()
  await rm(directory, { recursive: true, force: true })
})

describe('IMAP connection and folders', () => {
  it('uses server-declared special folders and marks name guesses for review', async () => {
    server.boxes.delete('Archive')
    server.addMailbox('Archives', null, '\\Archive')
    const p = await connected()
    const review = await p.folderMappings()
    expect(review.mappings.sent).toEqual({ path: 'Sent', source: 'server' })
    expect(review.mappings.archive).toEqual({ path: 'Archives', source: 'name' })
    const boxes = await p.mailboxes(account)
    expect(boxes.find((b) => b.name === 'Inbox')?.role).toBe('inbox')
    expect(boxes.find((b) => b.name === 'Sent')?.role).toBe('sent')
  })
  it('lets the user choose or create a missing folder, and that choice wins', async () => {
    server.boxes.delete('Archive')
    const p = await connected()
    expect((await p.folderMappings()).mappings.archive).toBeUndefined()
    const review = await p.setFolderMappings(account, {
      archive: { path: 'Old mail', create: true },
      junk: null,
    })
    expect(server.boxes.has('Old mail')).toBe(true)
    expect(review.mappings.archive).toEqual({ path: 'Old mail', source: 'user' })
    expect(review.mappings.junk).toBeNull()
    expect((await p.mailboxes(account)).find((b) => b.name === 'Junk')?.role).toBeNull()
  })
  it('creates a missing folder where the server keeps its folders', async () => {
    for (const path of ['Sent', 'Drafts', 'Trash', 'Archive', 'Junk']) server.boxes.delete(path)
    server.addMailbox('INBOX/Sent', '\\Sent')
    const p = await connected()
    const review = await p.setFolderMappings(account, {
      archive: { path: 'Archive', create: true },
    })
    expect(review.mappings.archive).toEqual({ path: 'INBOX/Archive', source: 'user' })
    expect(server.boxes.has('INBOX/Archive')).toBe(true)
    expect(server.boxes.has('Archive')).toBe(false)
  })
  it('reports incoming authentication failures without trying anything else', async () => {
    const p = provider({ password: 'wrong' })
    await expect(p.connect()).rejects.toMatchObject({ code: 'authentication' })
    expect(server.commands).toEqual([])
  })
  it('explains and disables unsafe actions when capabilities are missing', () => {
    expect(limitsFor(new Set(['MOVE', 'UIDPLUS']))).toEqual({})
    expect(limitsFor(new Set(['MOVE'])).destroy).toContain('UIDPLUS')
    expect(limitsFor(new Set(['MOVE'])).move).toBeUndefined()
    expect(limitsFor(new Set([])).move).toContain('MOVE nor UIDPLUS')
  })
})

describe('IMAP TLS policy', () => {
  it('preserves the account-wide email ID returned by ImapFlow', async () => {
    const port = new ImapFlowPort({ ...config.incoming, password: 'x' }, 'command')
    vi.spyOn((port as any).client, 'fetch').mockImplementation(async function* () {
      yield { uid: 17, emailId: '18446744073709551615' }
    })
    expect(await port.fetch('17', { envelope: true })).toEqual([
      expect.objectContaining({ uid: 17, emailId: '18446744073709551615' }),
    ])
  })
  it('reports Gmail’s Important folder, which ImapFlow does not recognize', async () => {
    const port = new ImapFlowPort({ ...config.incoming, password: 'x' }, 'command')
    vi.spyOn((port as any).client, 'list').mockResolvedValue([
      {
        path: '[Gmail]/Important',
        name: 'Important',
        flags: new Set(['\\HasNoChildren', '\\Important']),
      },
      {
        path: '[Gmail]/All Mail',
        name: 'All Mail',
        flags: new Set(['\\All']),
        specialUse: '\\All',
        specialUseSource: 'extension',
      },
      { path: 'Work', name: 'Work', flags: new Set() },
    ])
    expect((await port.list()).map((f) => f.specialUse)).toEqual(['\\Important', '\\All', null])
  })
  it('verifies certificates and never falls back to plaintext', () => {
    const tls = imapFlowOptions({ ...config.incoming, password: 'x' }, 'command')
    expect(tls).toMatchObject({
      secure: true,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    })
    const starttls = imapFlowOptions(
      { ...config.incoming, port: 143, security: 'starttls', password: 'x' },
      'idle',
    )
    expect(starttls).toMatchObject({
      secure: false,
      doSTARTTLS: true,
      tls: { rejectUnauthorized: true },
    })
    expect(starttls.servername).toBe('imap.example.com')
    expect(
      imapFlowOptions({ ...config.incoming, host: '127.0.0.1', password: 'x' }, 'command')
        .servername,
    ).toBeUndefined()
  })
  it('refuses a mailbox-wide EXPUNGE and a MOVE emulation in the adapter itself', async () => {
    const port = new ImapFlowPort({ ...config.incoming, password: 'x' }, 'command')
    ;(port as any).client.capabilities = new Map([['IMAP4rev1', true]])
    const expunge = vi.spyOn((port as any).client, 'messageDelete')
    const move = vi.spyOn((port as any).client, 'messageMove')
    expect(() => port.expunge([1])).toThrow(ProviderError)
    expect(() => port.move([1], 'Archive')).toThrow(ProviderError)
    expect(expunge).not.toHaveBeenCalled()
    expect(move).not.toHaveBeenCalled()
  })
})

describe('IMAP indexing and reading', () => {
  it('shows and counts Gmail emails once across Inbox, All Mail and labels', async () => {
    server.capabilities.add('X-GM-EXT-1')
    server.addMailbox('[Gmail]/All Mail', '\\All')
    server.addMailbox('Personal')
    const input = {
      emailId: '18446744073709551615',
      messageId: 'root@x',
      subject: 'Plans',
      from: [alex],
      date: at(1),
      text: 'Shall we?',
      attachments: [{ name: 'plans.txt', type: 'text/plain', content: 'Plan A' }],
    }
    for (const path of ['INBOX', '[Gmail]/All Mail', 'Personal']) server.deliver(path, input)
    const reply = {
      emailId: '18446744073709551614',
      messageId: 'reply@x',
      references: ['root@x'],
      subject: 'Re: Plans',
      date: at(2),
      text: 'Yes.',
    }
    for (const path of ['Sent', '[Gmail]/All Mail']) server.deliver(path, reply)
    const p = await connected()
    await sync(p)
    for (const query of [{ view: 'inbox' }, { view: 'all' }, { view: 'all', text: 'Plans' }]) {
      const page = await p.query(account, query)
      expect(page.total).toBe(1)
      expect(page.items[0].count).toBe(2)
    }
    const [thread] = (await p.query(account, { view: 'inbox' })).items
    const messages = await p.conversation(account, thread.id)
    expect(messages.map((m) => m.text?.trim())).toEqual(['Shall we?', 'Yes.'])
    expect(new TextDecoder().decode(await p.download(account, messages[0].attachments![0]))).toBe(
      'Plan A',
    )
    // Actions still receive all five verified mailbox + UID locations.
    const locations = await p.conversationMetadata(account, [thread.id])
    expect(locations).toHaveLength(5)
    const updated = await p.update(
      account,
      Object.fromEntries(locations.map((m) => [m.id, { keywords: { $seen: true } }])),
    )
    expect(updated.failures).toEqual([])
    expect(updated.updated).toHaveLength(5)
  })
  describe('one Gmail email at three locations', () => {
    const gmail = () => {
      server.capabilities.add('X-GM-EXT-1')
      server.addMailbox('[Gmail]/All Mail', '\\All')
      server.addMailbox('[Gmail]/Important')
      const input = {
        emailId: '777',
        messageId: 'once@x',
        subject: 'Once',
        from: [alex],
        date: at(1),
        text: 'Only one email.',
      }
      for (const path of ['INBOX', '[Gmail]/All Mail', '[Gmail]/Important'])
        server.deliver(path, input)
    }
    const selects = (from: number) =>
      server.commands.slice(from).filter((c) => c === 'SELECT').length

    it('lists it with one summary message, preferring the folder being viewed', async () => {
      gmail()
      const p = await connected()
      await sync(p)
      const boxes = await p.mailboxes(account)
      const id = (name: string) => boxes.find((b) => b.name === name)!.id
      const [inbox] = (await p.query(account, { view: 'inbox' })).items
      expect(inbox.count).toBe(1)
      expect(inbox.messages.map((m) => Object.keys(m.mailboxIds))).toEqual([[id('Inbox')]])
      const [all] = (await p.query(account, { view: 'all' })).items
      expect(all.messages).toHaveLength(1)
      expect(Object.keys(all.messages[0].mailboxIds)).toEqual([id('Inbox')])
      const [important] = (await p.query(account, { mailboxId: id('Important'), view: 'folder' }))
        .items
      expect(important.messages.map((m) => Object.keys(m.mailboxIds))).toEqual([[id('Important')]])
      // Mutations still resolve every location from the index.
      expect(await p.conversationMetadata(account, [inbox.id])).toHaveLength(3)
    })
    it('never lets the Important copy represent an email ahead of a real label', async () => {
      server.capabilities.add('X-GM-EXT-1')
      server.addMailbox('[Gmail]/Important', '\\Important')
      server.addMailbox('Work')
      const input = { emailId: '888', messageId: 'imp@x', subject: 'Imp', date: at(1), text: 'I' }
      for (const path of ['[Gmail]/Important', 'Work']) server.deliver(path, input)
      const p = await connected()
      await sync(p)
      const work = (await p.mailboxes(account)).find((b) => b.name === 'Work')!.id
      const [all] = (await p.query(account, { view: 'all' })).items
      expect(all.messages.map((m) => Object.keys(m.mailboxIds))).toEqual([[work]])
    })
    it('opens it with a single SELECT', async () => {
      gmail()
      const p = await connected()
      await sync(p)
      const [thread] = (await p.query(account, { view: 'inbox' })).items
      const before = server.commands.length
      const messages = await p.conversation(account, thread.id)
      expect(messages.map((m) => m.text?.trim())).toEqual(['Only one email.'])
      expect(selects(before)).toBe(1)
    })
    it('reads the next copy when the preferred location is gone', async () => {
      gmail()
      const p = await connected()
      await sync(p)
      const [thread] = (await p.query(account, { view: 'inbox' })).items
      server.remove('INBOX', 1)
      const before = server.commands.length
      expect((await p.conversation(account, thread.id)).map((m) => m.text?.trim())).toEqual([
        'Only one email.',
      ])
      expect(selects(before)).toBe(2)
    })
  })
  it('opens a conversation spread over Inbox and Sent from All Mail in one SELECT', async () => {
    server.capabilities.add('X-GM-EXT-1')
    server.addMailbox('[Gmail]/All Mail', '\\All')
    const root = { emailId: '1', messageId: 'r@x', subject: 'Q', date: at(1), text: 'Q?' }
    const reply = { emailId: '2', messageId: 'a@x', references: ['r@x'], date: at(2), text: 'A.' }
    for (const path of ['INBOX', '[Gmail]/All Mail']) server.deliver(path, root)
    for (const path of ['Sent', '[Gmail]/All Mail']) server.deliver(path, reply)
    const p = await connected()
    await sync(p)
    const [thread] = (await p.query(account, { view: 'inbox' })).items
    expect(thread.messages).toHaveLength(2)
    const before = server.commands.length
    expect((await p.conversation(account, thread.id)).map((m) => m.text?.trim())).toEqual([
      'Q?',
      'A.',
    ])
    expect(server.commands.slice(before).filter((c) => c === 'SELECT')).toHaveLength(1)
  })
  it('deduplicates by server identity when Message-ID is absent and preserves distinct emails', async () => {
    const same = { emailId: '123', subject: 'No header ID', date: at(1), text: 'One email' }
    server.deliver('INBOX', same)
    server.deliver('Archive', same)
    // Reused Message-ID headers are not proof that two emails are identical.
    server.deliver('INBOX', { emailId: '124', messageId: 'shared@x', date: at(2), text: 'First' })
    server.deliver('Archive', {
      emailId: '125',
      messageId: 'shared@x',
      date: at(3),
      text: 'Second',
    })
    server.deliver('INBOX', { messageId: 'plain@x', date: at(4), text: 'Plain first' })
    server.deliver('Archive', { messageId: 'plain@x', date: at(5), text: 'Plain second' })
    const p = await connected()
    await sync(p)
    const page = await p.query(account, { view: 'all' })
    expect(page.total).toBe(3)
    const noHeader = page.items.find((c) => c.subject === same.subject)!
    expect(noHeader.count).toBe(1)
    expect(await p.conversation(account, noHeader.id)).toHaveLength(1)
    for (const thread of page.items.filter((c) => c.id !== noHeader.id)) {
      expect(thread.count).toBe(2)
      expect(await p.conversation(account, thread.id)).toHaveLength(2)
    }
  })
  it('reads another location if the first Gmail location disappeared or became stale', async () => {
    const input = { emailId: '123', messageId: 'same@x', date: at(1), text: 'Still here' }
    const inboxUid = server.deliver('INBOX', input)
    server.deliver('Archive', input)
    const p = await connected()
    await sync(p)
    const [thread] = (await p.query(account, { view: 'inbox' })).items
    server.remove('INBOX', inboxUid)
    expect((await p.conversation(account, thread.id)).map((m) => m.text?.trim())).toEqual([
      'Still here',
    ])
    server.deliver('INBOX', input)
    await sync(p)
    server.resetUidValidity('INBOX')
    expect((await p.conversation(account, thread.id)).map((m) => m.text?.trim())).toEqual([
      'Still here',
    ])
  })
  it('bounds an empty preview on opening while preserving the full HTML body', async () => {
    const html = ' '.repeat(4096) + '<p>Full message content</p>'
    server.deliver('INBOX', { messageId: 'html@x', subject: 'HTML', date: at(1), html })
    const p = await connected()
    // Exercise the large-message, per-part path without allocating a large attachment.
    const port = server.commandPorts[0]
    const fetch = port.fetch.bind(port)
    vi.spyOn(port, 'fetch').mockImplementation(async (...args) =>
      (await fetch(...args)).map((m) => ({
        ...m,
        ...(args[1].size ? { size: 10_000_001 } : {}),
      })),
    )
    await sync(p)
    const [thread] = (await p.query(account, { view: 'inbox' })).items
    expect(thread.messages[0].preview).toBe('')

    const [message] = await p.conversation(account, thread.id)
    expect(message.text).toBe('')
    expect(message.html).toBe(html)
    expect(message.preview).toBe('')

    const [reopened] = await p.messages(account, [message.id], true)
    expect(reopened.html).toBe(message.html)
    expect(reopened.preview).toBe('')
  })
  it('indexes recent Inbox mail first and reports incomplete results until history is indexed', async () => {
    for (let i = 0; i < 12; i++)
      server.deliver('INBOX', {
        messageId: 'm' + i + '@x',
        subject: 'Message ' + i,
        from: [alex],
        date: at(i),
      })
    const p = await connected()
    const events: any[] = []
    p.subscribe((e) => events.push(e))
    await sync(p)
    let page = await p.query(account, { view: 'inbox' })
    expect(page.items.map((c) => c.subject)).toEqual([
      'Message 11',
      'Message 10',
      'Message 9',
      'Message 8',
      'Message 7',
    ])
    expect(page.incomplete).toBe(true)
    expect(events.find((e) => e.type === 'indexing').indexing).toMatchObject({
      indexed: 5,
      total: 12,
      complete: false,
    })
    await historical(p)
    // Historical indexing never looks like new mail.
    expect(events.filter((e) => e.type === 'changed' && !e.historical)).toHaveLength(1)
    expect(events.filter((e) => e.type === 'changed' && e.historical).length).toBeGreaterThan(0)
    page = await p.query(account, { view: 'inbox' })
    expect(page.total).toBe(12)
    expect(page.incomplete).toBeUndefined()
    expect(events.at(-1).indexing).toMatchObject({ indexed: 12, total: 12, complete: true })
  })
  it('paginates without duplicates while older mail is still being indexed', async () => {
    for (let i = 0; i < 12; i++)
      server.deliver('INBOX', { messageId: 'm' + i + '@x', subject: 'M' + i, date: at(i) })
    const p = await connected()
    await sync(p)
    const first = await p.query(account, { view: 'inbox' }, 0, 3)
    await historical(p)
    const second = await p.query(account, { view: 'inbox' }, first.next!, 3)
    const seen = [...first.items, ...second.items].map((c) => c.subject)
    expect(new Set(seen).size).toBe(6)
    expect(seen).toEqual(['M11', 'M10', 'M9', 'M8', 'M7', 'M6'])
  })
  it('groups a conversation across folders by Message-ID and References, never by subject alone', async () => {
    server.deliver('INBOX', {
      messageId: 'root@x',
      subject: 'Plans',
      from: [alex],
      date: at(1),
      text: 'Shall we?',
    })
    server.deliver('Sent', {
      messageId: 'reply@x',
      inReplyTo: 'root@x',
      references: ['root@x'],
      subject: 'Re: Plans',
      from: [me],
      date: at(2),
      text: 'Yes.',
    })
    server.deliver('INBOX', { messageId: 'other@x', subject: 'Plans', from: [alex], date: at(3) })
    const p = await connected()
    await sync(p)
    const page = await p.query(account, { view: 'all' })
    const plans = page.items.find((c) => c.count === 2)!
    expect(plans.messages.map((m) => m.subject).sort()).toEqual(['Plans', 'Re: Plans'])
    expect(page.items).toHaveLength(2)
    const messages = await p.conversation(account, plans.id)
    expect(messages.map((m) => m.text?.trim())).toEqual(['Shall we?', 'Yes.'])
  })
  it('joins a reply indexed before its ancestor and keeps the old conversation ID working', async () => {
    const p = await connected()
    server.deliver('INBOX', {
      messageId: 'b@x',
      references: ['a@x'],
      inReplyTo: 'a@x',
      subject: 'Re: A',
      date: at(2),
    })
    server.deliver('INBOX', {
      messageId: 'c@x',
      references: ['z@x'],
      subject: 'Re: A',
      date: at(3),
    })
    await sync(p)
    const before = (await p.query(account, { view: 'inbox' })).items
    expect(before).toHaveLength(2)
    // The shared ancestor arrives (e.g. from a folder indexed later) and references both lines.
    server.deliver('Archive', { messageId: 'a@x', references: ['z@x'], subject: 'A', date: at(1) })
    await sync(p)
    const after = (await p.query(account, { view: 'all' })).items
    expect(after).toHaveLength(1)
    for (const old of before) expect((await p.conversation(account, old.id)).length).toBe(3)
  })
  it('discards stale locations after a UIDVALIDITY change and reindexes', async () => {
    server.deliver('INBOX', { messageId: 'a@x', subject: 'A', date: at(1) })
    const p = await connected()
    await sync(p)
    const [before] = (await p.query(account, { view: 'inbox' })).items
    server.resetUidValidity('INBOX')
    server.deliver('INBOX', { messageId: 'b@x', subject: 'B', date: at(2) })
    await sync(p)
    const after = await p.query(account, { view: 'inbox' })
    expect(after.items.map((c) => c.subject)).toEqual(['B', 'A'])
    expect(after.items.find((c) => c.subject === 'A')!.messages[0].id).not.toBe(
      before.messages[0].id,
    )
    expect(await p.messages(account, [before.messages[0].id])).toEqual([])
  })
  it('notices messages expunged by another client', async () => {
    const uid = server.deliver('INBOX', { messageId: 'a@x', subject: 'A', date: at(1) })
    server.deliver('INBOX', { messageId: 'b@x', subject: 'B', date: at(2) })
    const p = await connected()
    await sync(p)
    server.remove('INBOX', uid)
    await sync(p)
    expect((await p.query(account, { view: 'inbox' })).items.map((c) => c.subject)).toEqual(['B'])
  })
  it('falls back to comparing flags when the server lacks CONDSTORE', async () => {
    server.capabilities.delete('CONDSTORE')
    const uid = server.deliver('INBOX', { messageId: 'a@x', subject: 'A', date: at(1) })
    const p = await connected()
    await sync(p)
    expect((await p.query(account, { view: 'inbox' })).items[0].unread).toBe(true)
    server.setFlags('INBOX', uid, ['\\Seen'])
    await sync(p)
    expect((await p.query(account, { view: 'inbox' })).items[0].unread).toBe(false)
  })
  it('searches on the server across folders and indexes matches it had not seen yet', async () => {
    for (let i = 0; i < 8; i++)
      server.deliver('Archive', { messageId: 'a' + i + '@x', subject: 'Old ' + i, date: at(i) })
    server.deliver('Archive', {
      messageId: 'needle@x',
      subject: 'Invoice',
      date: at(0),
      text: 'Needle inside',
      attachments: [{ name: 'invoice.pdf', type: 'application/pdf', content: 'pdf' }],
    })
    server.deliver('Junk', { messageId: 'spam@x', subject: 'Needle spam', date: at(9) })
    const p = await connected()
    await sync(p)
    const found = await p.query(account, { view: 'all', text: 'needle' })
    expect(found.items.map((c) => c.subject)).toEqual(['Invoice'])
    expect(found.items[0].hasAttachment).toBe(true)
    expect(
      (await p.query(account, { view: 'all', text: 'needle', hasAttachment: true })).items,
    ).toHaveLength(1)
    const [message] = await p.conversation(account, found.items[0].id)
    expect(message.attachments).toMatchObject([{ name: 'invoice.pdf', type: 'application/pdf' }])
    const bytes = await p.download(account, message.attachments![0])
    expect(new TextDecoder().decode(bytes)).toBe('pdf')
  })
  it('picks up new Inbox mail announced on the IDLE connection', async () => {
    const p = await connected({
      background: true,
      timing: { reconcileMs: 60_000, sentCopyGraceMs: 0, previews: 0 },
    })
    const changed = vi.fn()
    p.subscribe((e) => e.type === 'changed' && !e.historical && changed())
    await vi.waitFor(() => expect(server.ports.some((port) => port.purpose === 'idle')).toBe(true))
    await vi.waitFor(() => expect(server.commands).toContain('SEARCH'))
    server.deliver('INBOX', { messageId: 'new@x', subject: 'Fresh', date: at(5) })
    await vi.waitFor(async () =>
      expect((await p.query(account, { view: 'inbox' })).items.map((c) => c.subject)).toEqual([
        'Fresh',
      ]),
    )
    expect(changed).toHaveBeenCalled()
  })
  it('reconnects the command connection after it drops', async () => {
    server.deliver('INBOX', { messageId: 'a@x', subject: 'A', date: at(1) })
    const p = await connected()
    await sync(p)
    server.commandPorts[0].drop()
    expect(
      (
        await p.conversationMetadata(account, [
          (await p.query(account, { view: 'inbox' })).items[0].id,
        ])
      ).length,
    ).toBe(1)
    expect(server.commandPorts).toHaveLength(2)
  })
})

describe('IMAP header backfill for inbox mail', () => {
  const check = (p: ImapProvider) => (p as any).checkHeaders() as Promise<void>
  const important = { kind: 'important', always: [], never: [] } as const
  const headerFetches = () =>
    server.fetchQueries.filter((f) => f.query.headers?.includes('list-id') && !f.query.envelope)
  async function uncheckedInbox(options: Parameters<typeof provider>[0] = {}, count = 3) {
    server.deliver('INBOX', {
      messageId: 'news@x',
      date: at(1),
      from: [{ name: 'News', email: 'news@shop.example' }],
      headers: { 'List-Id': '<news.shop.example>', 'X-Other': 'ignored' },
    })
    for (let n = 2; n <= count; n++)
      server.deliver('INBOX', { messageId: 'p' + n + '@x', date: at(n), from: [alex] })
    const file = join(directory, 'backfill.sqlite')
    const index = openInProcessIndex(file)
    const p = await connected({ index, ...options })
    await sync(p)
    const unchecked = async () => {
      // Mail indexed before schema v4 has no checked headers.
      const db = new DatabaseSync(file)
      db.exec('UPDATE messages SET headers_checked = 0, list_id = NULL, automated = 0')
      db.close()
      server.fetchQueries.length = 0
    }
    await unchecked()
    const [inbox] = (await index.listMailboxes((p as any).accountId)).filter(
      (b) => b.path === 'INBOX',
    )
    const count_ = async () =>
      (
        await index.conversations(
          (p as any).accountId,
          { mailboxIds: [inbox!.id], split: important },
          { limit: 50 },
        )
      ).items.length
    return {
      p,
      important: count_,
      reset: unchecked,
      left: async () => (await index.uncheckedHeaders((p as any).accountId, inbox!.id, 100)).length,
    }
  }
  it('fetches only the three headers once and drops lists from Important', async () => {
    const { p, important } = await uncheckedInbox()
    expect(await important()).toBe(3)
    const changed = vi.fn()
    p.subscribe((e) => e.type === 'changed' && changed(e))
    await check(p)
    expect(await important()).toBe(2)
    expect(headerFetches().map((f) => f.query)).toEqual([
      { headers: ['list-id', 'precedence', 'auto-submitted'] },
    ])
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ historical: true }))
    const before = server.commands.length
    await check(p)
    expect(server.commands.slice(before)).toEqual([])
    expect(changed).toHaveBeenCalledTimes(1)
  })
  it('works through several batches, newest first', async () => {
    const { p, important, left } = await uncheckedInbox({ timing: { headerBatch: 2 } }, 5)
    await check(p)
    expect(headerFetches().map((f) => f.range)).toEqual(['4:5', '2:3', '1'])
    expect(await left()).toBe(0)
    expect(await important()).toBe(4)
  })
  it('checks a few batches per pass, so recent bodies still download early', async () => {
    const { p, left } = await uncheckedInbox({ timing: { headerBatch: 1, headerBatches: 2 } }, 5)
    await check(p)
    expect(headerFetches().map((f) => f.range)).toEqual(['5', '4'])
    expect(await left()).toBe(3)
    await check(p)
    expect(headerFetches().map((f) => f.range)).toEqual(['5', '4', '3', '2'])
  })
  it('marks a message that vanished from the server as checked', async () => {
    const { p, left } = await uncheckedInbox()
    const box = server.box('INBOX')
    box.messages = box.messages.filter((m) => m.uid !== 2)
    await check(p)
    expect(await left()).toBe(0)
  })
  it('skips rows of another UIDVALIDITY', async () => {
    const { p, left } = await uncheckedInbox()
    server.box('INBOX').uidValidity += 1
    await check(p)
    expect(headerFetches()).toEqual([])
    expect(await left()).toBe(3)
  })
  it('stops when a sync is requested', async () => {
    const { p, important } = await uncheckedInbox()
    p.requestSync('inbox')
    await check(p)
    expect(await important()).toBe(3)
  })
  it('does not retry a refused batch and lets the rest of the loop go on', async () => {
    const { p, left } = await uncheckedInbox({ timing: { headerBatch: 2 } }, 4)
    const refuse = () => {
      server.hooks.set('FETCH:before', refuse)
      throw new ProviderError('command', 'Refused.')
    }
    server.hooks.set('FETCH:before', refuse)
    await check(p)
    expect(headerFetches()).toHaveLength(2)
    expect(await left()).toBe(4)
    await check(p)
    expect(headerFetches()).toHaveLength(2)
  })
  it('passes connection errors on to the sync loop', async () => {
    const { p } = await uncheckedInbox()
    server.hooks.set('FETCH:before', () => {
      throw new ProviderError('network', 'Dropped.')
    })
    await expect(check(p)).rejects.toMatchObject({ code: 'network' })
  })
  it('runs from the sync loop', async () => {
    const { p, important, reset } = await uncheckedInbox({
      background: true,
      timing: { reconcileMs: 60_000, sentCopyGraceMs: 0, previews: 0 },
    })
    await reset()
    expect(await important()).toBe(3)
    p.requestSync('inbox')
    await vi.waitFor(async () => expect(await important()).toBe(2))
  })
})

describe('IMAP original message sources', () => {
  const plans = () => {
    const root = server.deliver('INBOX', {
      messageId: 'root@x',
      subject: 'Plans',
      date: at(1),
      text: 'Shall we?',
    })
    const reply = server.deliver('INBOX', {
      messageId: 'reply@x',
      references: ['root@x'],
      subject: 'Re: Plans',
      date: at(2),
      text: 'Yes.',
    })
    return { root, reply }
  }
  const opened = async (p: ImapProvider) => {
    await sync(p)
    const [thread] = (await p.query(account, { view: 'inbox' })).items
    return p.conversation(account, thread.id)
  }
  const cached = (p: ImapProvider) => (p as any).sources.size as number

  it('returns the source downloaded with the body without another IMAP command', async () => {
    plans()
    const p = await connected()
    const messages = await opened(p)
    const commands = server.commands.length
    const raw = await p.rawMessage(account, messages[0].id, 1_000_000)
    expect(new TextDecoder().decode(raw)).toContain('Shall we?')
    expect(server.commands.length).toBe(commands)
    // A caller's smaller limit is still respected.
    await expect(p.rawMessage(account, messages[0].id, 10)).rejects.toMatchObject({
      code: 'rawMessage',
    })
  })
  it('forgets downloaded sources of messages removed or renumbered on the server', async () => {
    const { root } = plans()
    const p = await connected()
    await opened(p)
    expect(cached(p)).toBe(2)
    server.remove('INBOX', root)
    await sync(p)
    expect(cached(p)).toBe(1)
    server.resetUidValidity('INBOX')
    await sync(p)
    expect(cached(p)).toBe(0)
  })
  it('bounds downloaded sources by size and evicts the least recently used', () => {
    const cache = new SourceCache(10, 10)
    const row = (id: string, uid: number) => ({ id, mailboxId: 'box', uidValidity: '1', uid })
    const a = row('a', 1),
      b = row('b', 2),
      c = row('c', 3)
    cache.set(a, new Uint8Array(4))
    cache.set(b, new Uint8Array(4))
    expect(cache.get(a)).toBeDefined()
    cache.set(c, new Uint8Array(4))
    expect(cache.get(b)).toBeUndefined()
    expect(cache.get(a)).toBeDefined()
    expect(cache.get(c)).toBeDefined()
    cache.set(row('huge', 4), new Uint8Array(11))
    expect(cache.size).toBe(2)
    // A message moved to another location is downloaded again from there.
    expect(cache.get({ ...a, uid: 9 })).toBeUndefined()
  })
  it('never lets one message take more than a quarter of the cache', () => {
    const cache = new SourceCache(16)
    const row = (id: string, uid: number) => ({ id, mailboxId: 'box', uidValidity: '1', uid })
    cache.set(row('a', 1), new Uint8Array(4))
    cache.set(row('b', 2), new Uint8Array(5))
    expect(cache.get(row('a', 1))).toBeDefined()
    expect(cache.get(row('b', 2))).toBeUndefined()
  })
  it('answers for every location of a Gmail email, but only that email', () => {
    const cache = new SourceCache()
    const inbox = { id: 'a', mailboxId: 'inbox', uidValidity: '1', uid: 1, emailId: '777' }
    cache.set(inbox, new Uint8Array([1]))
    const allMail = { id: 'b', mailboxId: 'all', uidValidity: '9', uid: 40, emailId: '777' }
    expect(cache.get(allMail)).toEqual(new Uint8Array([1]))
    expect(cache.get({ ...allMail, emailId: '778' })).toBeUndefined()
    expect(cache.get({ ...allMail, emailId: undefined })).toBeUndefined()
  })
  it('reuses the source of a Gmail email read at another location', async () => {
    server.capabilities.add('X-GM-EXT-1')
    server.addMailbox('[Gmail]/All Mail', '\\All')
    const input = { emailId: '9', messageId: 'g@x', subject: 'G', date: at(1), text: 'Hi' }
    for (const path of ['INBOX', '[Gmail]/All Mail']) server.deliver(path, input)
    const p = await connected()
    await sync(p)
    const [thread] = (await p.query(account, { view: 'inbox' })).items
    const [opened] = await p.conversation(account, thread.id)
    const locations = await p.conversationMetadata(account, [thread.id])
    const other = locations.find((m) => m.id !== opened.id)!
    const commands = server.commands.length
    expect(new TextDecoder().decode(await p.rawMessage(account, other.id, 1_000_000))).toContain(
      'Hi',
    )
    expect(server.commands.length).toBe(commands)
  })
  it('downloads the original of a message over the body limit only once', async () => {
    server.deliver('INBOX', { messageId: 'big@x', subject: 'Big', date: at(1), text: 'Big' })
    const p = await connected()
    // The index believes the message is large; its real source stays small.
    const port = server.commandPorts[0]
    const fetch = port.fetch.bind(port)
    vi.spyOn(port, 'fetch').mockImplementation(async (...args) =>
      (await fetch(...args)).map((m) => ({ ...m, ...(args[1].size ? { size: 10_000_001 } : {}) })),
    )
    await sync(p)
    const [thread] = (await p.query(account, { view: 'inbox' })).items
    const source = vi.spyOn(port, 'source')
    for (let i = 0; i < 2; i++)
      expect(
        new TextDecoder().decode(await p.rawMessage(account, thread.messages[0].id, 20_000_000)),
      ).toContain('Big')
    expect(source).toHaveBeenCalledTimes(1)
  })
})

describe('IMAP read-ahead', () => {
  it('opens the thread the user chose before conversations read ahead in the background', async () => {
    for (let i = 1; i <= 4; i++)
      server.deliver('INBOX', { messageId: 'm' + i + '@x', subject: 'Thread ' + i, date: at(i) })
    const p = await connected()
    await sync(p)
    const threads = (await p.query(account, { view: 'inbox' })).items.reverse()
    const select = FakePort.prototype.select
    let release!: () => void
    const busy = new Promise<void>((resolve) => (release = resolve))
    // The first read-ahead holds the command connection while the others queue behind it.
    vi.spyOn(FakePort.prototype, 'select').mockImplementationOnce(async function (
      this: FakePort,
      path,
    ) {
      await busy
      return select.call(this, path)
    })
    const order: string[] = []
    const open = (i: number, background?: boolean) =>
      p
        .conversation(account, threads[i].id, background ? { background } : undefined)
        .then(([m]) => order.push(m.subject))
    const loads = [open(0, true), open(1, true), open(2, true)]
    await new Promise((r) => setTimeout(r, 20))
    loads.push(open(3))
    await new Promise((r) => setTimeout(r, 20))
    release()
    await Promise.all(loads)
    expect(order).toEqual(['Thread 1', 'Thread 4', 'Thread 2', 'Thread 3'])
  })
  it('lets the user’s open in between a long background read-ahead after one message', async () => {
    for (let i = 1; i <= 8; i++)
      server.deliver('INBOX', {
        messageId: 'long' + i + '@x',
        references: i > 1 ? ['long1@x'] : [],
        subject: 'Long',
        date: at(i),
        text: 'Long ' + i,
      })
    server.deliver('INBOX', { messageId: 'other@x', subject: 'Other', date: at(20), text: 'Hi' })
    const p = await connected()
    await sync(p)
    const [other, long] = (await p.query(account, { view: 'inbox' })).items
    const source = FakePort.prototype.source
    let release!: () => void
    const busy = new Promise<void>((resolve) => (release = resolve))
    const read: number[] = []
    vi.spyOn(FakePort.prototype, 'source').mockImplementation(async function (
      this: FakePort,
      uid,
      max,
    ) {
      if (!read.length) await busy
      read.push(uid)
      return source.call(this, uid, max)
    })
    const ahead = p.conversation(account, long.id, { background: true })
    await new Promise((r) => setTimeout(r, 20))
    const open = p.conversation(account, other.id)
    await new Promise((r) => setTimeout(r, 20))
    release()
    await Promise.all([ahead, open])
    // UID 9 is the message the user opened; only the read-ahead message in progress precedes it.
    expect(read.indexOf(9)).toBe(1)
  })
  // Reminders
  it('is ready for reminders only after a full pass since connecting', async () => {
    const p = await connected()
    const events: string[] = []
    p.subscribe((e) => void events.push(e.type))
    expect(p.readyForReminders()).toBe(false)
    await (p as any).syncPass('inbox')
    expect(p.readyForReminders()).toBe(false)
    await sync(p)
    expect(p.readyForReminders()).toBe(true)
    // Announced even with nothing new, so held-back returns run.
    expect(events).toContain('changed')
    await p.connect()
    expect(p.readyForReminders()).toBe(false)
    await sync(p)
    expect(p.readyForReminders()).toBe(true)
  })
  it('reads message bodies in the background without counting as the user’s own open', async () => {
    for (let i = 1; i <= 3; i++)
      server.deliver('Sent', {
        messageId: 's' + i + '@x',
        subject: 'S' + i,
        date: at(i),
        text: 'Hi ' + i,
      })
    server.deliver('INBOX', { messageId: 'other@x', subject: 'Other', date: at(20), text: 'Hi' })
    const p = await connected()
    await sync(p)
    const sent = (await p.query(account, { view: 'sent' })).items.map((c) => c.messages[0]!.id)
    const [other] = (await p.query(account, { view: 'inbox' })).items
    const source = FakePort.prototype.source
    let release!: () => void
    const busy = new Promise<void>((resolve) => (release = resolve))
    const read: string[] = []
    vi.spyOn(FakePort.prototype, 'source').mockImplementation(async function (
      this: FakePort,
      uid,
      max,
    ) {
      if (!read.length) await busy
      read.push((this as any).selected + ':' + uid)
      return source.call(this, uid, max)
    })
    const scan = p.messages(account, sent, true, { background: true })
    await new Promise((r) => setTimeout(r, 20))
    expect((p as any).lastOpened).toBe(0)
    const open = p.conversation(account, other!.id)
    await new Promise((r) => setTimeout(r, 20))
    release()
    const [bodies] = await Promise.all([scan, open])
    expect(bodies.map((m) => m.text?.trim()).sort()).toEqual(['Hi 1', 'Hi 2', 'Hi 3'])
    // One background message at a time: the user's open comes right after the first.
    expect(read.indexOf('INBOX:1')).toBe(1)
  })
})

describe('IMAP mail stored ahead of time', () => {
  const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString()
  const prefetch = (p: ImapProvider) => (p as any).prefetchBodies() as Promise<void>

  it('opens recent mail from disk without any IMAP command, even after a restart', async () => {
    server.deliver('INBOX', { messageId: 'a@x', subject: 'A', date: ago(1), text: 'Body A' })
    server.deliver('Sent', { messageId: 'b@x', subject: 'B', date: ago(2), text: 'Body B' })
    const file = join(directory, 'kept.sqlite')
    const first = await connected({ index: openInProcessIndex(file) })
    await sync(first)
    await prefetch(first)
    await first.close()
    const p = await connected({ index: openInProcessIndex(file) })
    const before = server.commands.length
    for (const view of ['inbox', 'sent']) {
      const [thread] = (await p.query(account, { view })).items
      const [message] = await p.conversation(account, thread.id)
      expect(message.text?.trim()).toBe(view === 'inbox' ? 'Body A' : 'Body B')
      expect(new TextDecoder().decode(await p.rawMessage(account, message.id, 1e6))).toContain(
        view === 'inbox' ? 'Body A' : 'Body B',
      )
    }
    expect(server.commands.slice(before)).toEqual([])
  })
  it('downloads recent Inbox and Sent mail newest first, several per FETCH, in short batches', async () => {
    for (let i = 1; i <= 12; i++)
      server.deliver('INBOX', { messageId: 'i' + i + '@x', date: ago(13 - i), text: 'Inbox ' + i })
    server.deliver('Sent', { messageId: 's@x', date: ago(20), text: 'Sent' })
    server.deliver('INBOX', { messageId: 'old@x', date: ago(24 * 40), text: 'Too old' })
    server.deliver('Archive', { messageId: 'arch@x', date: ago(1), text: 'Elsewhere' })
    const big = server.deliver('INBOX', {
      messageId: 'big@x',
      date: ago(1),
      text: 'x'.repeat(3000),
    })
    const p = await connected({ timing: { initialBatch: 50, prefetchMaxSize: 2000 } })
    await sync(p)
    await prefetch(p)
    const inbox = (n: number) =>
      server.box('INBOX').messages.find((m) => m.input.text === 'Inbox ' + n)!.uid
    expect(server.sourceBatches).toEqual([
      { path: 'INBOX', uids: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map(inbox) },
      { path: 'INBOX', uids: [2, 1].map(inbox) },
      { path: 'Sent', uids: [1] },
    ])
    expect(server.sourceBatches.flatMap((b) => b.uids)).not.toContain(big)
    // A second pass has nothing left to do.
    await prefetch(p)
    expect(server.sourceBatches).toHaveLength(3)
  })
  it('leaves a message too large for one short task to load on open, then keeps it', async () => {
    const big = { messageId: 'lone@x', subject: 'Lone', date: ago(1), text: 'y'.repeat(1_000_000) }
    server.deliver('INBOX', big)
    const index = openInProcessIndex(join(directory, 'lone.sqlite'))
    const p = await connected({ index })
    await sync(p)
    await prefetch(p)
    expect(server.sourceBatches).toEqual([])
    const [thread] = (await p.query(account, { view: 'inbox' })).items
    const [row] = await index.messages((p as any).accountId, [thread.messages[0].id])
    await p.conversation(account, thread.id)
    await vi.waitFor(async () =>
      expect(await index.storedSource((p as any).accountId, row!)).toBeDefined(),
    )
  })
  it('drains one folder before the next, so batches never alternate SELECTs', async () => {
    for (let i = 0; i < 6; i++)
      server.deliver('INBOX', { messageId: 'in' + i + '@x', date: ago(2 * i + 1), text: 'In ' + i })
    for (let i = 0; i < 4; i++)
      server.deliver('Sent', {
        messageId: 'out' + i + '@x',
        date: ago(2 * i + 2),
        text: 'Out ' + i,
      })
    const p = await connected({ timing: { prefetchBatch: 2 } })
    await sync(p)
    await prefetch(p)
    expect(server.sourceBatches.map((b) => b.path)).toEqual([
      'INBOX',
      'INBOX',
      'INBOX',
      'Sent',
      'Sent',
    ])
  })
  it('stops holding back as soon as a sync is requested', async () => {
    server.deliver('INBOX', { messageId: 'w@x', subject: 'W', date: ago(2), text: 'W' })
    server.deliver('INBOX', { messageId: 'v@x', subject: 'V', date: ago(1), text: 'V' })
    const p = await connected({ timing: { prefetchQuietMs: 10_000 } })
    await sync(p)
    const [, thread] = (await p.query(account, { view: 'inbox' })).items
    await p.conversation(account, thread.id)
    const started = Date.now()
    const done = prefetch(p)
    setTimeout(() => p.requestSync('inbox'), 50)
    await done
    expect(Date.now() - started).toBeLessThan(2000)
  })
  it('downloads a message the store declines only once, even when its size was understated', async () => {
    server.deliver('INBOX', { messageId: 'new@x', date: ago(1), text: 'n'.repeat(1000) })
    server.deliver('INBOX', { messageId: 'old@x', date: ago(2), text: 'o'.repeat(1000) })
    const p = await connected({ timing: { storedBytes: 1500 } })
    // The server reports a tiny RFC822.SIZE, so the older one still seems to fit.
    const port = server.commandPorts[0]
    const fetch = port.fetch.bind(port)
    vi.spyOn(port, 'fetch').mockImplementation(async (...args) =>
      (await fetch(...args)).map((m) => ({ ...m, ...(args[1].size ? { size: 10 } : {}) })),
    )
    await sync(p)
    // A pass that downloaded the declined message forever would never end: stop it after a few.
    const sources = FakePort.prototype.sources
    vi.spyOn(FakePort.prototype, 'sources').mockImplementation(async function (this: any, ...a) {
      if (server.sourceBatches.length >= 4) (p as any).disposed = true
      return sources.apply(this, a)
    })
    await prefetch(p)
    expect(server.sourceBatches.flatMap((b) => b.uids).sort()).toEqual([1, 2])
  })
  it('never marks mail read while downloading ahead', async () => {
    server.deliver('INBOX', { messageId: 'u@x', date: ago(1), text: 'Unread' })
    const p = await connected()
    await sync(p)
    await prefetch(p)
    expect(server.sourceBatches).toHaveLength(1)
    expect(server.commands).not.toContain('STORE')
    expect(server.box('INBOX').messages[0]!.flags.has('\\Seen')).toBe(false)
    expect((await p.query(account, { view: 'inbox' })).items[0]!.unread).toBe(true)
  })
  it('keeps stored mail within the cap, newest first', async () => {
    for (let i = 1; i <= 4; i++)
      server.deliver('INBOX', {
        messageId: 'c' + i + '@x',
        date: ago(5 - i),
        text: 'Capped ' + i + ' ' + 'x'.repeat(1000),
      })
    // Each message is a little over 1 KB, so two fit.
    const p = await connected({ timing: { storedBytes: 2500 } })
    await sync(p)
    await prefetch(p)
    // Only the newest two fit; older mail is not downloaded just to be dropped.
    expect(server.sourceBatches.flatMap((b) => b.uids)).toEqual([4, 3])
  })
  it('holds back while the user is opening mail', async () => {
    server.deliver('INBOX', { messageId: 'open@x', subject: 'Open', date: ago(2), text: 'O' })
    server.deliver('INBOX', { messageId: 'next@x', subject: 'Next', date: ago(1), text: 'N' })
    const p = await connected({ timing: { prefetchQuietMs: 300 } })
    await sync(p)
    const [, opened] = (await p.query(account, { view: 'inbox' })).items
    await p.conversation(account, opened.id)
    const started = Date.now()
    await prefetch(p)
    expect(server.sourceBatches).toHaveLength(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })
  it('downloads ahead on its own after a sync pass', async () => {
    server.deliver('INBOX', { messageId: 'auto@x', date: ago(1), text: 'Auto' })
    await connected({ background: true })
    await vi.waitFor(() => expect(server.sourceBatches).toHaveLength(1), { timeout: 3000 })
  })
})

describe('IMAP organization', () => {
  async function inboxMessage(p: ImapProvider) {
    await sync(p)
    const [conversation] = (await p.query(account, { view: 'inbox' })).items
    return conversation.messages[0]
  }
  it('keeps changing other folders when one refuses a flag change, and reports each message', async () => {
    server.deliver('Archive', { messageId: 'r@x', subject: 'Refused', date: at(1) })
    server.deliver('INBOX', { messageId: 'k@x', subject: 'Kept', date: at(2) })
    const p = await connected()
    await sync(p)
    const [refused] = await p
      .messages(
        account,
        (await p.query(account, { view: 'all' })).items.flatMap((c) => c.messages.map((m) => m.id)),
      )
      .then((all) => all.filter((m) => m.subject === 'Refused'))
    const [kept] = (await p.query(account, { view: 'inbox' })).items[0]!.messages
    const store = FakePort.prototype.store
    vi.spyOn(FakePort.prototype, 'store').mockImplementation(async function (this: any, ...args) {
      if (this.selected === 'Archive')
        throw new ProviderError('command', 'The server did not change the flags.')
      return store.apply(this, args)
    })
    // The refused folder is changed first, so the folder after it must not be skipped.
    const result = await p.update(account, {
      [refused!.id]: { keywords: { $seen: true } },
      [kept!.id]: { keywords: { $seen: true } },
    })
    expect(result.updated).toEqual([kept!.id])
    expect(result.failures).toEqual([refused!.id + ': changed on the server'])
    expect(server.box('INBOX').messages[0]!.flags.has('\\Seen')).toBe(true)
  })
  it('moves with MOVE and keeps the message ID through the confirmed move', async () => {
    server.deliver('INBOX', { messageId: 'a@x', subject: 'A', date: at(1) })
    const p = await connected()
    const message = await inboxMessage(p)
    const boxes = await p.mailboxes(account)
    const inbox = boxes.find((b) => b.role === 'inbox')!.id
    const archive = boxes.find((b) => b.role === 'archive')!.id
    const result = await p.update(account, {
      [message.id]: { mailboxes: { [inbox]: false, [archive]: true } },
    })
    expect(result).toEqual({ updated: [message.id], failures: [] })
    expect(server.box('Archive').messages).toHaveLength(1)
    const [moved] = await p.messages(account, [message.id])
    expect(moved.mailboxIds).toEqual({ [archive]: true })
  })
  it('finds a moved message by Message-ID when the server does not report new UIDs', async () => {
    server.capabilities.delete('UIDPLUS')
    server.deliver('INBOX', { messageId: 'a@x', subject: 'A', date: at(1) })
    const p = await connected()
    const message = await inboxMessage(p)
    const boxes = await p.mailboxes(account)
    const [inbox, archive] = ['inbox', 'archive'].map((r) => boxes.find((b) => b.role === r)!.id)
    await p.update(account, { [message.id]: { mailboxes: { [inbox]: false, [archive]: true } } })
    expect((await p.messages(account, [message.id]))[0].mailboxIds).toEqual({ [archive]: true })
  })
  it('emulates MOVE only with UID EXPUNGE, leaving other clients’ pending deletions alone', async () => {
    server.capabilities.delete('MOVE')
    server.deliver('INBOX', { messageId: 'a@x', subject: 'A', date: at(1) })
    server.deliver('INBOX', {
      messageId: 'pending@x',
      subject: 'Pending',
      date: at(0),
      flags: ['\\Deleted'],
    })
    const p = await connected()
    await sync(p)
    const message = (await p.query(account, { view: 'inbox' })).items.find(
      (c) => c.subject === 'A',
    )!.messages[0]
    const boxes = await p.mailboxes(account)
    const [inbox, archive] = ['inbox', 'archive'].map((r) => boxes.find((b) => b.role === r)!.id)
    await p.update(account, { [message.id]: { mailboxes: { [inbox]: false, [archive]: true } } })
    expect(server.commands).toContain('COPY')
    expect(server.commands).toContain('UID EXPUNGE')
    expect(server.box('INBOX').messages.map((m) => m.input.subject)).toEqual(['Pending'])
  })
  it('refuses to move or permanently delete when that cannot be done safely', async () => {
    server.capabilities.delete('MOVE')
    server.capabilities.delete('UIDPLUS')
    server.deliver('INBOX', { messageId: 'a@x', subject: 'A', date: at(1) })
    const p = await connected()
    expect(account.limits?.move).toBeTruthy()
    const message = await inboxMessage(p)
    const boxes = await p.mailboxes(account)
    expect(boxes.every((b) => !b.rights.mayRemoveItems)).toBe(true)
    const [inbox, archive] = ['inbox', 'archive'].map((r) => boxes.find((b) => b.role === r)!.id)
    await expect(
      p.update(account, { [message.id]: { mailboxes: { [inbox]: false, [archive]: true } } }),
    ).rejects.toMatchObject({ code: 'unsupported' })
    await expect(p.update(account, {}, [message.id])).rejects.toMatchObject({ code: 'unsupported' })
    expect(server.box('INBOX').messages).toHaveLength(1)
    expect(server.commands).not.toContain('COPY')
  })
  it('permanently deletes exactly the chosen messages', async () => {
    server.deliver('Trash', { messageId: 'a@x', subject: 'A', date: at(1) })
    server.deliver('Trash', { messageId: 'b@x', subject: 'B', date: at(2), flags: ['\\Deleted'] })
    const p = await connected()
    await sync(p)
    const a = (await p.query(account, { view: 'trash' })).items.find((c) => c.subject === 'A')!
      .messages[0]
    expect(await p.update(account, {}, [a.id])).toEqual({ updated: [a.id], failures: [] })
    expect(server.box('Trash').messages.map((m) => m.input.subject)).toEqual(['B'])
  })
  it('reads current flags before acting and reports a concurrent change as a failure', async () => {
    const uid = server.deliver('INBOX', { messageId: 'a@x', subject: 'A', date: at(1) })
    const p = await connected()
    const message = await inboxMessage(p)
    // Another client flags the message between our read and our write.
    server.hooks.set('STORE:before', () => server.setFlags('INBOX', uid, ['\\Flagged']))
    const result = await p.update(account, { [message.id]: { keywords: { $seen: true } } })
    expect(result.failures).toEqual([message.id + ': changed on the server'])
    expect([...server.box('INBOX').messages[0].flags]).toEqual(['\\Flagged'])
    const [current] = await p.messages(account, [message.id])
    expect(current.keywords).toEqual({ $flagged: true })
  })
  it('refuses to delete a folder that still has messages', async () => {
    server.addMailbox('Projects')
    server.deliver('Projects', { messageId: 'p@x', subject: 'P', date: at(1) })
    const p = await connected()
    const id = (await p.mailboxes(account)).find((b) => b.name === 'Projects')!.id
    await expect(p.folder(account, 'delete', id)).rejects.toThrow('still contains messages')
    await p.folder(account, 'rename', id, 'Clients')
    expect(server.boxes.has('Clients')).toBe(true)
    expect((await p.mailboxes(account)).find((b) => b.name === 'Clients')?.id).toBe(id)
  })
})

describe('IMAP drafts and sending', () => {
  const draft = {
    id: 'fb4c0a00-254f-4fb1-965e-96d56ca9ef17',
    accountId: '',
    identityId: 'default',
    to: [alex],
    cc: [],
    bcc: [{ name: 'Secret', email: 'secret@example.net' }],
    subject: 'Grüße',
    html: '<p>Hallo</p>',
    text: 'Hallo',
    attachments: [],
    updatedAt: '2026-09-23T10:00:00.000Z',
    status: 'local' as const,
  }
  it('treats mail in the Drafts folder as a draft even without the Draft flag', async () => {
    // Superhuman saves Gmail drafts that IMAP lists in Drafts and All Mail with only \Seen.
    server.capabilities.add('X-GM-EXT-1')
    server.addMailbox('[Gmail]/All Mail', '\\All')
    const asked = { emailId: '1', messageId: 'q@x', from: [alex], date: at(1), text: 'Q?' }
    const unsent = {
      emailId: '2',
      messageId: 'd@x',
      references: ['q@x'],
      from: [me],
      flags: ['\\Seen'],
      date: at(2),
      text: 'Not sent yet',
    }
    for (const path of ['INBOX', '[Gmail]/All Mail']) server.deliver(path, asked)
    for (const path of ['Drafts', '[Gmail]/All Mail']) server.deliver(path, unsent)
    const p = await connected()
    await sync(p)
    const [thread] = (await p.query(account, { view: 'inbox' })).items
    const messages = await p.conversation(account, thread.id)
    expect(messages.map((m) => [m.text?.trim(), !!m.keywords.$draft])).toEqual([
      ['Q?', false],
      ['Not sent yet', true],
    ])
    expect(thread.messages.map((m) => !!m.keywords.$draft).sort()).toEqual([false, true])
  })
  it('appends drafts with the Draft flag and confirms them before returning an ID', async () => {
    const p = await connected()
    const id = await p.createDraft(account, {
      ...draft,
      accountId: account.id,
      inReplyTo: ['root@x'],
      references: ['root@x'],
    })
    const stored = server.box('Drafts').messages[0]
    expect([...stored.flags].sort()).toEqual(['\\Draft', '\\Seen'])
    const [message] = await p.messages(account, [id], true)
    expect(message.keywords.$draft).toBe(true)
    expect(message.subject).toBe('Grüße')
    const raw = new TextDecoder().decode(stored.raw)
    expect(raw).toMatch(/^In-Reply-To: <root@x>/m)
    // Drafts keep Bcc so another client resuming the draft still sees it.
    expect(raw).toMatch(/^Bcc:/m)
  })
  it('keeps Bcc recipients in the envelope only', async () => {
    const p = await connected()
    const outgoing = await p.prepareSubmission(
      account,
      { ...draft, accountId: account.id },
      'attempt@example.com',
    )
    expect(outgoing.envelope).toEqual({
      from: 'me@example.com',
      to: ['alex@example.org', 'secret@example.net'],
    })
    const raw = new TextDecoder().decode(outgoing.mime)
    expect(raw).not.toMatch(/^Bcc:/im)
    expect(raw).not.toContain('secret@example.net')
    expect(raw).toMatch(/^Message-ID: <attempt@example.com>/m)
    expect(server.commands).not.toContain('APPEND')
  })
  it('sends from an alias in the From header, the envelope and the Message-ID', async () => {
    const p = await connected()
    const aliased = {
      ...account,
      senderName: 'Me',
      aliases: [
        { id: 'hello', email: 'hello@alias.example', name: 'Hello desk' },
        { id: 'custom', email: 'me@custom.example' },
      ],
    }
    expect((await p.identities(aliased)).map((i) => [i.id, i.name, i.email, i.mayDelete])).toEqual([
      ['default', 'Me', 'me@example.com', false],
      ['hello', 'Hello desk', 'hello@alias.example', true],
      // Without a name of its own, an alias uses the account's.
      ['custom', 'Me', 'me@custom.example', true],
    ])
    const outgoing = await p.prepareSubmission(
      aliased,
      { ...draft, accountId: account.id, identityId: 'hello' },
      'attempt@alias.example',
    )
    expect(outgoing.envelope.from).toBe('hello@alias.example')
    const raw = new TextDecoder().decode(outgoing.mime)
    expect(raw).toMatch(/^From: Hello desk <hello@alias\.example>/m)
    expect(raw).not.toContain('me@example.com')
    // A saved draft gets a Message-ID on the alias's domain, never the account's.
    await p.createDraft(aliased, { ...draft, accountId: account.id, identityId: 'custom' })
    const stored = new TextDecoder().decode(server.box('Drafts').messages[0].raw)
    expect(stored).toMatch(/^From: Me <me@custom\.example>/m)
    expect(stored).toMatch(/^Message-ID: <[^@>]+@custom\.example>/m)
  })
  it('refuses to send from an address that is no longer set up', async () => {
    const p = await connected()
    const removed = { ...draft, accountId: account.id, identityId: 'removed' }
    await expect(p.prepareSubmission(account, removed, 'attempt@x')).rejects.toMatchObject({
      code: 'identity',
    })
    await expect(p.createDraft(account, removed)).rejects.toMatchObject({ code: 'identity' })
    expect(server.box('Drafts').messages).toHaveLength(0)
  })
  it('does not duplicate a Sent copy the server already filed', async () => {
    const p = await connected()
    const outgoing = await p.prepareSubmission(
      account,
      { ...draft, accountId: account.id },
      'attempt@example.com',
    )
    server.deliver('Sent', { messageId: 'attempt@example.com', subject: 'Grüße' })
    expect(await p.fileSentCopy(account, outgoing)).toBe('server')
    expect(server.box('Sent').messages).toHaveLength(1)
  })
  it('reports an ambiguous append and reconciles it before appending again', async () => {
    const p = await connected()
    const outgoing = await p.prepareSubmission(
      account,
      { ...draft, accountId: account.id },
      'attempt@example.com',
    )
    // The server stores the copy but the response is lost.
    server.hooks.set('APPEND:after', () => {
      server.commandPorts.at(-1)!.drop()
      throw new ProviderError('network', 'Connection lost.')
    })
    await expect(p.fileSentCopy(account, outgoing)).rejects.toMatchObject({
      code: 'filingUncertain',
    })
    expect(await p.fileSentCopy(account, outgoing)).toBe('server')
    expect(server.box('Sent').messages).toHaveLength(1)
  })
  it('finds its own Sent copy even when the server search index lags behind', async () => {
    server.laggingSearch = true
    const p = await connected()
    const outgoing = await p.prepareSubmission(
      account,
      { ...draft, accountId: account.id },
      'attempt@example.com',
    )
    expect(await p.fileSentCopy(account, outgoing)).toBe('filed')
    expect(await p.fileSentCopy(account, outgoing)).toBe('server')
    expect(server.box('Sent').messages).toHaveLength(1)
  })
  it('asks for a Sent folder instead of guessing when none is mapped', async () => {
    server.boxes.delete('Sent')
    const p = await connected()
    const outgoing = await p.prepareSubmission(
      account,
      { ...draft, accountId: account.id },
      'attempt@example.com',
    )
    await expect(p.fileSentCopy(account, outgoing)).rejects.toMatchObject({ code: 'filing' })
  })
  it('submits through SMTP with the incoming login by default and never claims later proof', async () => {
    const submit = vi.fn().mockResolvedValue({ accepted: ['alex@example.org'], rejected: [] })
    const verify = vi.fn().mockResolvedValue(undefined)
    const p = await connected({ smtp: { submit, verify } })
    await p.verifyOutgoing()
    const outgoing = await p.prepareSubmission(
      account,
      { ...draft, accountId: account.id },
      'attempt@example.com',
    )
    await p.submit(account, outgoing)
    expect(submit.mock.calls[0][0]).toMatchObject({
      host: 'smtp.example.com',
      username: 'me',
      password: 'disposable',
    })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(await p.submissionExists()).toBe(false)
  })
  it('uses separate outgoing credentials when configured', async () => {
    const submit = vi.fn().mockResolvedValue({ accepted: [], rejected: [] })
    const p = await connected({
      config: {
        ...config,
        outgoingSameCredentials: false,
        outgoing: { ...config.outgoing, username: 'smtp-user' },
      },
      outgoingPassword: 'smtp-secret',
      smtp: { submit, verify: vi.fn() },
    })
    await p.submit(
      account,
      await p.prepareSubmission(account, { ...draft, accountId: account.id }, 'x@example.com'),
    )
    expect(submit.mock.calls[0][0]).toMatchObject({
      username: 'smtp-user',
      password: 'smtp-secret',
    })
  })
})
