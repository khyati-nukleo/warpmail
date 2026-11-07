import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ProviderError,
  type Account,
  type ImapConnectionConfig,
  type OutgoingMessage,
} from '../packages/core/src'
import { ImapProvider } from '../packages/imap/src'
import { openInProcessIndex } from '../apps/desktop/src/main/imap-index/sqlite-index'
import { FakeImapServer } from './support/fake-imap'

const config: ImapConnectionConfig = {
  protocol: 'imap',
  email: 'me@example.com',
  incoming: { host: 'imap.example.com', port: 993, security: 'tls', username: 'me' },
  outgoing: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'me' },
  outgoingSameCredentials: true,
}
const me = { name: 'Me', email: 'me@example.com' }
const alex = { name: 'Alex', email: 'alex@example.org' }
const sam = { name: 'Sam', email: 'sam@example.org' }
const id = '6f1c2a90-3b4d-4e5f-8a7b-9c0d1e2f3a4b.0a1b2c3d4e@example.com'
const SENT = '[Gmail]/Sent Mail'
const ALL = '[Gmail]/All Mail'
const TRASH = '[Gmail]/Trash'
/** What the server filed itself: the first recipient's copy, image included. */
const serverCopy = {
  messageId: id,
  subject: 'Plans',
  from: [me],
  to: [alex, sam],
  html: '<p>See you</p><img src="https://read.example.com/p/Zx9Yw8Vu7Ts6Rq5Po4Nm3L.gif">',
  flags: ['\\Seen'],
}
const clean = new TextEncoder().encode(
  [
    'Message-ID: <' + id + '>',
    'From: Me <me@example.com>',
    'To: Alex <alex@example.org>, Sam <sam@example.org>',
    'Subject: Plans',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>See you</p>',
    '',
  ].join('\r\n'),
)
const message: OutgoingMessage = {
  messageId: id,
  mime: clean,
  envelope: { from: me.email, to: [alex.email, sam.email] },
  replaceServerCopies: true,
  replacement: { hosts: ['https://read.example.com'] },
}

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
    readAttachment: async () => new Uint8Array(),
    background: false,
    ports: server.port,
    timing: { sentCopyGraceMs: 0, initialBatch: 5, historicalBatch: 5, previews: 0 },
  })
  providers.push(p)
  ;[account] = await p.connect()
  return p
}
/** A server laid out like Gmail: labels shown as folders, every message in All Mail. */
function gmailServer({ allMail = true, trashUse = '\\Trash' as string | null } = {}) {
  for (const path of [...server.boxes.keys()]) if (path !== 'INBOX') server.boxes.delete(path)
  server.addMailbox(SENT, '\\Sent')
  if (allMail) server.addMailbox(ALL, '\\All')
  server.addMailbox(TRASH, trashUse)
  server.gmail = true
}
/** Nothing was deleted or filed: the server's copy is still where it was. */
function expectUntouched(path: string) {
  expect(server.commands).not.toContain('MOVE')
  expect(server.commands).not.toContain('UID EXPUNGE')
  expect(server.commands).not.toContain('APPEND')
  expect(withId(path)).toHaveLength(1)
  expect(withId(path)[0].input.html).toContain('read.example.com')
}
const withId = (path: string) => server.box(path).messages.filter((m) => m.input.messageId === id)
const decoded = (raw?: Uint8Array) => new TextDecoder().decode(raw)
/** Exactly one copy in Sent, and it is the clean one, already read. */
function expectOneCleanCopy(path: string) {
  const sent = server.box(path).messages
  expect(sent).toHaveLength(1)
  expect(decoded(sent[0].raw)).toBe(decoded(clean))
  expect(sent[0].flags.has('\\Seen')).toBe(true)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'inlark-read-status-'))
  server = new FakeImapServer()
  providers = []
})
afterEach(async () => {
  for (const p of providers) await p.close()
  await rm(directory, { recursive: true, force: true })
})

describe('Read status: which accounts can be tracked', () => {
  it('marks a Gmail account with All Mail and Trash shown', async () => {
    gmailServer()
    await connected()
    expect(account.readStatus).toBe(true)
  })
  it('leaves other IMAP servers and Gmail without All Mail or Trash unmarked', async () => {
    await connected()
    expect(account.readStatus).toBeUndefined()
    gmailServer({ allMail: false })
    await connected()
    expect(account.readStatus).toBeUndefined()
    gmailServer({ trashUse: null })
    await connected()
    expect(account.readStatus).toBeUndefined()
  })
})

describe('Read status: the Sent copy of a tracked email', () => {
  it("replaces Gmail's merged copy with one clean copy", async () => {
    gmailServer()
    server.deliver(ALL, serverCopy)
    server.deliver(SENT, serverCopy)
    const p = await connected()
    const sync = vi.spyOn(p, 'requestSync')
    expect(await p.fileSentCopy(account, message)).toBe('filed')
    expectOneCleanCopy(SENT)
    expect(
      server.box(ALL).messages.filter((m) => m.input.html?.includes('read.example.com')),
    ).toHaveLength(0)
    expect(withId(ALL)).toHaveLength(1)
    expect(withId(TRASH)).toHaveLength(0)
    expect(sync).toHaveBeenCalledWith('all')
  })
  it("files the clean copy with the message's own date, so it stays before later replies", async () => {
    gmailServer()
    server.deliver(ALL, serverCopy)
    server.deliver(SENT, serverCopy)
    const p = await connected()
    const dated = new TextEncoder().encode(
      'Date: Thu, 05 Nov 2026 09:30:00 -0500\r\n' + decoded(clean),
    )
    expect(await p.fileSentCopy(account, { ...message, mime: dated })).toBe('filed')
    const [filed] = server.box(SENT).messages
    expect(filed.internalDate).toBe('2026-11-05T14:30:00.000Z')
  })
  it('finds a late server copy after the grace period', async () => {
    gmailServer()
    const p = await connected()
    // Gmail files its merged copy only after the first lookup has already come back empty.
    server.hooks.set('SEARCH:before', () =>
      server.hooks.set('SELECT:before', () => {
        server.deliver(ALL, serverCopy)
        server.deliver(SENT, serverCopy)
      }),
    )
    expect(await p.fileSentCopy(account, message)).toBe('filed')
    expectOneCleanCopy(SENT)
    expect(withId(ALL)).toHaveLength(1)
    expect(withId(TRASH)).toHaveLength(0)
  })
  it('running it twice still leaves exactly one clean copy', async () => {
    gmailServer()
    server.deliver(ALL, serverCopy)
    server.deliver(SENT, serverCopy)
    const p = await connected()
    expect(await p.fileSentCopy(account, message)).toBe('filed')
    // As after a crash before the result was recorded: the whole replacement runs again.
    expect(await p.fileSentCopy(account, message)).toBe('filed')
    expectOneCleanCopy(SENT)
    expect(withId(ALL)).toHaveLength(1)
    expect(withId(TRASH)).toHaveLength(0)
  })
  it("only moves Gmail's matches whose Message-ID is exactly this one", async () => {
    gmailServer()
    const other = { ...serverCopy, messageId: 'unrelated@example.com', html: '<p>Other</p>' }
    server.deliver(ALL, serverCopy)
    const stray = server.deliver(ALL, other)
    server.deliver(SENT, serverCopy)
    server.deliver(SENT, other)
    const p = await connected()
    // Gmail's query language is not exact matching, so its search may return other messages.
    const port = server.commandPorts.at(-1)!
    const search = port.search.bind(port)
    port.search = async (criteria) =>
      criteria.gmraw ? [...(await search(criteria)), stray] : search(criteria)
    expect(await p.fileSentCopy(account, message)).toBe('filed')
    expect(
      server.box(ALL).messages.filter((m) => m.input.messageId === other.messageId),
    ).toHaveLength(1)
    expect(
      server.box(SENT).messages.filter((m) => m.input.messageId === other.messageId),
    ).toHaveLength(1)
    expect(withId(SENT)).toHaveLength(1)
    expect(decoded(withId(SENT)[0].raw)).toBe(decoded(clean))
  })
  it('refuses a Message-ID that could widen the search', async () => {
    gmailServer()
    server.deliver(ALL, serverCopy)
    server.deliver(SENT, serverCopy)
    const p = await connected()
    await expect(
      p.fileSentCopy(account, { ...message, messageId: 'from:me' }),
    ).rejects.toMatchObject({ code: 'filing' })
    expectUntouched(SENT)
    // Also when a clean copy is owed, so nothing is looked for first.
    const owed = { ...message, messageId: 'from:me', replacement: { hosts: [], owed: true } }
    await expect(p.fileSentCopy(account, owed)).rejects.toMatchObject({ code: 'filing' })
    expect(server.commands).not.toContain('SEARCH')
  })
  it('on Gmail without All Mail in IMAP it deletes nothing and says why', async () => {
    gmailServer({ allMail: false })
    server.deliver(SENT, serverCopy)
    const p = await connected()
    await expect(p.fileSentCopy(account, message)).rejects.toMatchObject({ code: 'filing' })
    expectUntouched(SENT)
  })
  it('on Gmail with a Trash folder that is not \\Trash it deletes nothing', async () => {
    gmailServer({ trashUse: null })
    server.deliver(ALL, serverCopy)
    server.deliver(SENT, serverCopy)
    const p = await connected()
    await expect(p.fileSentCopy(account, message)).rejects.toMatchObject({ code: 'filing' })
    expectUntouched(SENT)
    expectUntouched(ALL)
  })
  it('on a non-Gmail server without UIDPLUS it never files a second copy', async () => {
    server.capabilities.delete('UIDPLUS')
    server.deliver('Sent', serverCopy)
    const p = await connected()
    await expect(p.fileSentCopy(account, message)).rejects.toMatchObject({ code: 'filing' })
    expectUntouched('Sent')
  })
  it('on a non-Gmail server with UIDPLUS it expunges its own copy in Sent and appends the clean one', async () => {
    server.deliver('Sent', serverCopy)
    const p = await connected()
    expect(await p.fileSentCopy(account, message)).toBe('filed')
    expectOneCleanCopy('Sent')
    expect(server.commands).toContain('UID EXPUNGE')
    expect(withId('Trash')).toHaveLength(0)
  })
  it("'ifPresent' replaces a server copy that exists with one clean copy", async () => {
    gmailServer()
    server.deliver(ALL, serverCopy)
    server.deliver(SENT, serverCopy)
    const p = await connected()
    const unconfirmed = { ...message, replaceServerCopies: 'ifPresent' as const }
    expect(await p.fileSentCopy(account, unconfirmed)).toBe('filed')
    expectOneCleanCopy(SENT)
    expect(withId(ALL)).toHaveLength(1)
    expect(withId(TRASH)).toHaveLength(0)
  })
  it("'ifPresent' files nothing when the server has no copy, even after the grace period", async () => {
    gmailServer()
    const p = await connected()
    const unconfirmed = { ...message, replaceServerCopies: 'ifPresent' as const }
    expect(await p.fileSentCopy(account, unconfirmed)).toBe('absent')
    expect(server.commands).not.toContain('APPEND')
    expect(server.commands).not.toContain('MOVE')
    expect(server.box(SENT).messages).toHaveLength(0)
    expect(server.box(ALL).messages).toHaveLength(0)
  })
  it("'ifPresent' finds a late server copy after the grace period", async () => {
    gmailServer()
    const p = await connected()
    server.hooks.set('SEARCH:before', () =>
      server.hooks.set('SELECT:before', () => {
        server.deliver(ALL, serverCopy)
        server.deliver(SENT, serverCopy)
      }),
    )
    const unconfirmed = { ...message, replaceServerCopies: 'ifPresent' as const }
    expect(await p.fileSentCopy(account, unconfirmed)).toBe('filed')
    expectOneCleanCopy(SENT)
  })
  describe('on Gmail nothing is lost when the connection drops', () => {
    const drop = () => {
      throw new ProviderError('network', 'Connection closed.')
    }
    /** What the app's journal keeps: whether a clean copy is owed, and its UID once confirmed. */
    function journal() {
      const record: { owed: boolean; uid?: number; commandsAtOwe?: string[] } = { owed: false }
      const attempt = (mode: true | 'ifPresent'): OutgoingMessage => ({
        ...message,
        replaceServerCopies: mode,
        replacement: {
          hosts: ['https://read.example.com'],
          owed: record.owed,
          owe: async () => {
            record.owed = true
            record.commandsAtOwe ??= [...server.commands]
          },
          confirmed: (uid) => (record.uid = uid),
        },
      })
      return { record, attempt }
    }
    const appends = () => server.commands.filter((c) => c === 'APPEND').length
    /** Exactly one clean copy in Sent and All Mail, and nothing left in Trash. */
    function expectReplaced() {
      expectOneCleanCopy(SENT)
      expect(withId(ALL)).toHaveLength(1)
      expect(decoded(withId(ALL)[0].raw)).toBe(decoded(clean))
      expect(withId(TRASH)).toHaveLength(0)
    }
    for (const mode of [true, 'ifPresent'] as const) {
      it(`after the move to Trash, a retry (${mode}) still files the clean copy`, async () => {
        gmailServer()
        server.deliver(ALL, serverCopy)
        server.deliver(SENT, serverCopy)
        const p = await connected()
        const { record, attempt } = journal()
        server.hooks.set('APPEND:before', drop)
        await expect(p.fileSentCopy(account, attempt(mode))).rejects.toMatchObject({
          code: 'filingUncertain',
        })
        // Gmail's copies are in Trash and the debt was recorded before they moved.
        expect(withId(TRASH)).toHaveLength(1)
        expect(record.owed).toBe(true)
        expect(record.commandsAtOwe).not.toContain('MOVE')
        expect(await p.fileSentCopy(account, attempt(mode))).toBe('filed')
        expectReplaced()
        expect(record.uid).toBe(withId(SENT)[0].uid)
      })
    }
    it('after the APPEND, a retry confirms the copy and never files a second one', async () => {
      gmailServer()
      server.deliver(ALL, serverCopy)
      server.deliver(SENT, serverCopy)
      const p = await connected()
      const { record, attempt } = journal()
      server.hooks.set('APPEND:after', drop)
      await expect(p.fileSentCopy(account, attempt(true))).rejects.toMatchObject({
        code: 'filingUncertain',
      })
      // Not confirmed, so the trashed copy is still there.
      expect(withId(TRASH)).toHaveLength(1)
      expect(await p.fileSentCopy(account, attempt('ifPresent'))).toBe('filed')
      expectReplaced()
      expect(appends()).toBe(1)
    })
    it('after the copies in Trash are deleted, a retry leaves everything as it is', async () => {
      gmailServer()
      server.deliver(ALL, serverCopy)
      server.deliver(SENT, serverCopy)
      const p = await connected()
      const { record, attempt } = journal()
      server.hooks.set('UID EXPUNGE:after', drop)
      await expect(p.fileSentCopy(account, attempt(true))).rejects.toMatchObject({
        code: 'network',
      })
      expect(record.owed).toBe(true)
      expect(await p.fileSentCopy(account, attempt('ifPresent'))).toBe('filed')
      expectReplaced()
      expect(appends()).toBe(1)
    })
    it('deletes nothing for good before the clean copy is confirmed in Sent', async () => {
      gmailServer()
      server.deliver(ALL, serverCopy)
      server.deliver(SENT, serverCopy)
      const p = await connected()
      expect(await p.fileSentCopy(account, journal().attempt(true))).toBe('filed')
      const at = (command: string) => server.commands.indexOf(command)
      expect(at('MOVE')).toBeLessThan(at('APPEND'))
      expect(at('APPEND')).toBeLessThan(at('UID EXPUNGE'))
      expectReplaced()
    })
    it('if Gmail drops the APPEND while a copy is in Trash, it empties Trash and files again', async () => {
      gmailServer()
      server.deliver(ALL, serverCopy)
      server.deliver(SENT, serverCopy)
      const p = await connected()
      // Gmail answers OK but keeps nothing.
      server.hooks.set('APPEND:after', () => {
        for (const path of [SENT, ALL]) {
          const box = server.box(path)
          box.messages = box.messages.filter((m) => m.input.messageId !== id)
        }
      })
      expect(await p.fileSentCopy(account, journal().attempt(true))).toBe('filed')
      expectReplaced()
      expect(appends()).toBe(2)
    })
    it('keeps a clean copy already in Sent and only removes the copies with an image', async () => {
      gmailServer()
      server.deliver(ALL, serverCopy)
      server.deliver(SENT, serverCopy)
      const p = await connected()
      expect(await p.fileSentCopy(account, journal().attempt(true))).toBe('filed')
      // Gmail files its merged copy late, after the clean one.
      server.deliver(ALL, serverCopy)
      server.deliver(SENT, serverCopy)
      expect(await p.fileSentCopy(account, journal().attempt(true))).toBe('filed')
      expectReplaced()
      expect(appends()).toBe(1)
    })
  })
  it("without replaceServerCopies it keeps today's behaviour", async () => {
    server.deliver('Sent', serverCopy)
    const p = await connected()
    const untracked = { ...message, replaceServerCopies: undefined }
    expect(await p.fileSentCopy(account, untracked)).toBe('server')
    expect(server.box('Sent').messages).toHaveLength(1)
    expect(server.box('Sent').messages[0].input.html).toContain('read.example.com')
    expect(server.commands).not.toContain('APPEND')
  })
})
