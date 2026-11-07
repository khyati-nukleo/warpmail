import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SplitScope } from '@inlark/core'
import {
  openInProcessIndex,
  SCHEMA_VERSION,
} from '../apps/desktop/src/main/imap-index/sqlite-index'
import { registerSplitFunctions } from '../apps/desktop/src/main/imap-index/split-schema'
import {
  ASK_CHECKS_NEEDED_SQL,
  reminderFactsQuery,
} from '../apps/desktop/src/main/imap-index/reminder-sql'
import type { FolderListing, MetadataIndex, NewMessage, ReminderFactsQuery } from '@inlark/imap'

let directory: string
let path: string
let index: MetadataIndex
let boxes: {
  inbox: string
  all: string
  sent: string
  noReminder: string
  followUp: string
  drafts: string
}

const folder = (path: string, specialUse: string | null = null): FolderListing => ({
  path,
  name: path,
  delimiter: '/',
  parentPath: null,
  specialUse,
  guessedSpecialUse: null,
  noSelect: false,
})

/** `n` hours into 2024. */
const hour = (n: number) => new Date(Date.UTC(2024, 0, 1) + n * 3600_000).toISOString()
const me = [{ name: 'Me', email: 'me@example.com' }]
const ada = [{ name: 'Ada', email: 'ada@example.com' }]
const bo = [{ name: 'Bo', email: 'bo@example.org' }]
const important: Extract<SplitScope, { kind: 'important' }> = {
  kind: 'important',
  always: [],
  never: [],
}

function message(mailboxId: string, uid: number, extra: Partial<NewMessage> = {}): NewMessage {
  return {
    mailboxId,
    uidValidity: '1',
    uid,
    messageId: 'm' + uid + '@example.com',
    inReplyTo: [],
    references: [],
    subject: 'Subject ' + uid,
    from: [{ name: 'Ada', email: 'Ada@Example.com' }],
    to: [{ name: 'Me', email: 'Me@Example.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    receivedAt: hour(uid),
    size: 1000 + uid,
    flags: [],
    hasAttachment: false,
    preview: 'Preview ' + uid,
    ...extra,
  }
}

/** My message to Ada in Sent. */
const sent = (uid: number, extra: Partial<NewMessage> = {}) =>
  message(boxes.sent, uid, { from: me, to: ada, ...extra })

function facts(extra: Partial<ReminderFactsQuery> = {}) {
  return index.reminderFacts('a', {
    inboxId: boxes.inbox,
    mailboxIds: [boxes.inbox, boxes.all, boxes.sent],
    labelIds: { noReminder: boxes.noReminder, followUp: boxes.followUp },
    important,
    sinceMs: Date.parse(hour(0)),
    draftsId: boxes.drafts,
    ...extra,
  })
}

async function threadOf(uid: number, mailboxId = boxes.inbox) {
  const [found] = await index.messagesAt('a', mailboxId, [uid])
  return found!.threadId
}

async function open() {
  index = openInProcessIndex(path)
  const [inbox, all, sentBox, noReminder, followUp, drafts] = await index.syncMailboxes('a', [
    folder('INBOX'),
    folder('[Gmail]/All Mail', '\\All'),
    folder('[Gmail]/Sent Mail', '\\Sent'),
    folder('Warpmail/No reminder'),
    folder('Warpmail/Follow up'),
    folder('[Gmail]/Drafts', '\\Drafts'),
  ])
  boxes = {
    inbox: inbox!.id,
    all: all!.id,
    sent: sentBox!.id,
    noReminder: noReminder!.id,
    followUp: followUp!.id,
    drafts: drafts!.id,
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'inlark-reminders-'))
  path = join(directory, 'index', 'imap.sqlite')
  await open()
})
afterEach(async () => {
  await index.close()
  await rm(directory, { recursive: true, force: true })
})

describe('reminder facts', () => {
  it('reports a person’s email to me in the inbox', async () => {
    await index.upsertMessages('a', [message(boxes.inbox, 1)])
    expect(await facts()).toEqual([
      {
        threadId: await threadOf(1),
        messageId: 'm1@example.com',
        receivedAt: hour(1),
        fromEmail: 'ada@example.com',
        to: ['me@example.com'],
        inInbox: true,
        labels: { noReminder: false, followUp: false },
        asks: null,
      },
    ])
  })

  it('reports the To line without me when I am only on Cc', async () => {
    await index.upsertMessages('a', [message(boxes.inbox, 1, { to: bo, cc: me })])
    const [fact] = await facts()
    expect(fact!.to).toEqual(['bo@example.org'])
  })

  it('skips automated replies after my sent message', async () => {
    await index.upsertMessages('a', [
      sent(1),
      message(boxes.inbox, 2, {
        inReplyTo: ['m1@example.com'],
        automation: { listId: null, precedence: null, autoSubmitted: 'auto-replied' },
      }),
      message(boxes.inbox, 3, {
        inReplyTo: ['m1@example.com'],
        unsubscribe: { url: 'https://list.example/u', oneClick: true },
      }),
    ])
    const found = await facts()
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      messageId: 'm1@example.com',
      fromEmail: 'me@example.com',
      to: ['ada@example.com'],
      // The thread's automated replies are in the inbox.
      inInbox: true,
    })
  })

  it('reports a colleague’s reply after my sent message', async () => {
    await index.upsertMessages('a', [
      sent(1, { cc: bo }),
      message(boxes.inbox, 2, { from: bo, inReplyTo: ['m1@example.com'] }),
    ])
    const found = await facts()
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ messageId: 'm2@example.com', fromEmail: 'bo@example.org' })
  })

  it('reports Gmail’s copies of one email once', async () => {
    await index.upsertMessages('a', [
      message(boxes.inbox, 1, { emailId: 'e1' }),
      message(boxes.all, 1, { emailId: 'e1' }),
    ])
    const found = await facts()
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ messageId: 'm1@example.com', inInbox: true })
  })

  it('reports label copies without taking them as the message', async () => {
    await index.upsertMessages('a', [
      message(boxes.inbox, 1, { emailId: 'e1' }),
      // Same email, later date: it would be the latest if label folders counted.
      message(boxes.noReminder, 1, { emailId: 'e1', receivedAt: hour(5) }),
      // A thread that is only in a label folder.
      message(boxes.followUp, 7),
    ])
    expect(await facts()).toEqual([
      expect.objectContaining({
        messageId: 'm1@example.com',
        receivedAt: hour(1),
        labels: { noReminder: true, followUp: false },
      }),
    ])
  })

  it('stores ask-checks by Message-ID and lists Sent mail still unchecked', async () => {
    await index.upsertMessages('a', [sent(1), sent(2)])
    const since = Date.parse(hour(0))
    const ids = { 1: (await index.messagesAt('a', boxes.sent, [1]))[0]!.id }
    const needed = await index.askChecksNeeded('a', boxes.sent, since, 10)
    expect(needed.map((n) => n.messageId)).toEqual(['m2@example.com', 'm1@example.com'])
    expect(needed[1]).toEqual({ id: ids[1], messageId: 'm1@example.com' })
    expect(await index.askChecksNeeded('a', boxes.sent, Date.parse(hour(2)), 10)).toHaveLength(1)
    expect(await index.askChecksNeeded('a', boxes.sent, since, 1)).toHaveLength(1)

    await index.setAskChecks('a', [{ messageId: 'm1@example.com', asks: true }])
    const byId = async () => new Map((await facts()).map((f) => [f.messageId, f.asks]))
    expect(await byId()).toEqual(
      new Map([
        ['m2@example.com', null],
        ['m1@example.com', true],
      ]),
    )
    expect(
      (await index.askChecksNeeded('a', boxes.sent, since, 10)).map((n) => n.messageId),
    ).toEqual(['m2@example.com'])
    // An upsert: a later answer replaces the stored one.
    await index.setAskChecks('a', [{ messageId: 'm1@example.com', asks: false }])
    expect((await byId()).get('m1@example.com')).toBe(false)
  })

  it('leaves out threads older than sinceMs unless they are listed', async () => {
    await index.upsertMessages('a', [
      message(boxes.inbox, 1),
      // A person's message, then only automated mail after sinceMs.
      message(boxes.inbox, 2),
      message(boxes.inbox, 10, {
        references: ['m2@example.com'],
        automation: { listId: '<news.example>', precedence: null, autoSubmitted: null },
      }),
    ])
    const sinceMs = Date.parse(hour(5))
    const [one, two] = [await threadOf(1), await threadOf(2)]
    expect(await facts({ sinceMs })).toEqual([])
    expect((await facts({ sinceMs, threadIds: [one] })).map((f) => f.threadId)).toEqual([one])
    expect((await facts({ sinceMs, threadIds: [two] })).map((f) => f.messageId)).toEqual([
      'm2@example.com',
    ])
  })

  it('resolves listed thread ids that were merged into another thread', async () => {
    await index.upsertMessages('a', [message(boxes.inbox, 1), message(boxes.inbox, 2)])
    const [one, two] = [await threadOf(1), await threadOf(2)]
    // A reply to both joins the threads; one of the ids becomes an alias.
    await index.upsertMessages('a', [
      message(boxes.inbox, 3, { references: ['m1@example.com', 'm2@example.com'] }),
    ])
    const merged = await threadOf(3)
    const old = merged === one ? two : one
    const found = await facts({ sinceMs: Date.parse(hour(9)), threadIds: [old] })
    expect(found.map((f) => [f.threadId, f.messageId])).toEqual([[merged, 'm3@example.com']])
  })

  it('ignores my unsent draft reply, which Gmail also lists in All Mail', async () => {
    const draft = { from: me, to: ada, inReplyTo: ['m1@example.com'], emailId: 'd2' }
    await index.upsertMessages('a', [
      message(boxes.inbox, 1, { emailId: 'e1' }),
      message(boxes.all, 2, { ...draft, flags: ['\\Draft'] }),
      message(boxes.drafts, 2, { ...draft, flags: ['\\Draft'] }),
    ])
    const found = await facts()
    expect(found.map((f) => [f.messageId, f.fromEmail])).toEqual([
      ['m1@example.com', 'ada@example.com'],
    ])
  })

  it('counts an automated sender on the Important always list as a person', async () => {
    await index.upsertMessages('a', [
      message(boxes.inbox, 1, {
        from: [{ name: 'News', email: 'news@example.org' }],
        unsubscribe: { url: 'https://list.example/u', oneClick: true },
      }),
    ])
    expect(await facts()).toEqual([])
    const always = { ...important, always: [{ address: 'news@example.org', words: [] }] }
    const found = await facts({ important: always })
    expect(found.map((f) => [f.messageId, f.fromEmail])).toEqual([
      ['m1@example.com', 'news@example.org'],
    ])
  })

  it('treats a sender on the Important never list as automated', async () => {
    await index.upsertMessages('a', [
      sent(1),
      message(boxes.inbox, 2, { inReplyTo: ['m1@example.com'] }),
    ])
    const found = await facts({ important: { ...important, never: ['ada@example.com'] } })
    expect(found.map((f) => f.messageId)).toEqual(['m1@example.com'])
  })
})

describe('schema v5', () => {
  it('migrates a v4 file and keeps its messages', async () => {
    await index.upsertMessages('a', [message(boxes.inbox, 1)])
    await index.close()
    const db = new DatabaseSync(path)
    db.exec('DROP TABLE reminder_checks; PRAGMA user_version = 4')
    db.close()
    await open()
    expect(SCHEMA_VERSION).toBe(5)
    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 })
      expect(
        check.prepare("SELECT name FROM sqlite_master WHERE name = 'reminder_checks'").all(),
      ).toEqual([{ name: 'reminder_checks' }])
    } finally {
      check.close()
    }
    expect(await facts()).toHaveLength(1)
  })

  it('reads reminder facts and unchecked Sent mail through indexes', () => {
    const db = new DatabaseSync(path)
    registerSplitFunctions(db)
    try {
      const plan = (sql: string, params: readonly unknown[]) =>
        (
          db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...(params as never[])) as {
            detail: string
          }[]
        ).map((row) => row.detail)
      const query = reminderFactsQuery('a', {
        inboxId: boxes.inbox,
        mailboxIds: [boxes.inbox, boxes.all, boxes.sent],
        labelIds: { noReminder: boxes.noReminder, followUp: boxes.followUp },
        important: {
          kind: 'important',
          always: [{ address: 'boss@example.com', words: ['urgent'] }],
          never: ['news@example.com'],
        },
        sinceMs: 0,
        threadIds: ['t1'],
        draftsId: boxes.drafts,
      })!
      const details = [
        ...plan(query.sql, query.params),
        ...plan(ASK_CHECKS_NEEDED_SQL, ['a', boxes.sent, 0, 10]),
      ]
      expect(details.length).toBeGreaterThan(0)
      for (const detail of details) {
        expect(detail).not.toMatch(/^SCAN m\b/)
        expect(detail).not.toMatch(/^SCAN messages\b/)
        // Nor any other read of messages or the checks that is not a lookup.
        expect(detail).not.toMatch(/^SCAN (?:[rinfcxd]|ta)\b/)
      }
    } finally {
      db.close()
    }
  })
})
