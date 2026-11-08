import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  conversationFromMessages,
  conversationSortKey,
  mergePages,
  type Account,
  type ImapConnectionConfig,
  type Message,
  type SplitScope,
} from '../packages/core/src'
import { ImapProvider } from '../packages/imap/src'
import {
  openInProcessIndex,
  SqliteMetadataIndex,
} from '../apps/desktop/src/main/imap-index/sqlite-index'
import type { ConversationFilter, ConversationRow, FolderListing, NewMessage } from '@inlark/imap'
import { FakeImapServer } from './support/fake-imap'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'inlark-reminders-order-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const folder = (path: string): FolderListing => ({
  path,
  name: path,
  delimiter: '/',
  parentPath: null,
  specialUse: null,
  guessedSpecialUse: null,
  noSelect: false,
})

/** `n` hours into 2024, in ms and as ISO. */
const ms = (n: number) => Date.UTC(2024, 0, 1) + n * 3600_000
const hour = (n: number) => new Date(ms(n)).toISOString()

function message(mailboxId: string, uid: number, extra: Partial<NewMessage> = {}): NewMessage {
  return {
    mailboxId,
    uidValidity: '1',
    uid,
    messageId: 'm' + uid + '@example.com',
    inReplyTo: [],
    references: [],
    subject: 'Subject ' + uid,
    from: [{ name: 'Ada', email: 'ada@example.com' }],
    to: [{ name: '', email: 'me@example.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    receivedAt: hour(uid),
    size: 1000 + uid,
    flags: ['\\Seen'],
    hasAttachment: false,
    preview: 'Preview ' + uid,
    ...extra,
  }
}

const uids = (rows: ConversationRow[]) => rows.map((r) => r.latest.uid)
/** `from` down to `to`, both included. */
const range = (from: number, to: number) =>
  Array.from({ length: from - to + 1 }, (_, n) => from - n)

describe('inbox order with due reminders (index)', () => {
  let index: SqliteMetadataIndex
  let inbox: string
  /** Thread id by uid: one message per thread. */
  let thread: Map<number, string>
  // The three oldest threads, due after everything else: 2, then 3, then 1.
  let boost: { threadId: string; sortMs: number }[]

  beforeEach(() => {
    index = new SqliteMetadataIndex(join(directory, 'index.sqlite'))
    inbox = index.syncMailboxes('a', [folder('INBOX')])[0]!.id
    const batch: NewMessage[] = []
    for (let uid = 1; uid <= 120; uid++)
      batch.push(
        message(inbox, uid, {
          // Every fifth is automated mail (left out of Important), and uid 2 is unread.
          ...(uid % 5 === 0 ? { from: [{ name: '', email: 'no-reply@example.com' }] } : {}),
          ...(uid === 2 ? { flags: [] } : {}),
        }),
      )
    index.upsertMessages('a', batch)
    const all = index.conversations('a', { mailboxIds: [inbox] }, { limit: 200 })
    thread = new Map(all.items.map((r) => [r.latest.uid, r.threadId]))
    boost = [
      { threadId: thread.get(1)!, sortMs: ms(200) },
      { threadId: thread.get(2)!, sortMs: ms(202) },
      { threadId: thread.get(3)!, sortMs: ms(201) },
    ]
  })
  afterEach(() => index.close())

  const filter = (extra: Partial<ConversationFilter> = {}): ConversationFilter => ({
    mailboxIds: [inbox],
    boost,
    ...extra,
  })

  it('puts boosted threads first, in due order, without changing the total', () => {
    const page = index.conversations('a', filter(), { limit: 50 })
    expect(page.total).toBe(120)
    expect(uids(page.items).slice(0, 4)).toEqual([2, 3, 1, 120])
    expect(page.items.slice(0, 3).map((r) => r.sortMs)).toEqual([ms(202), ms(201), ms(200)])
    expect(page.items[3]!.sortMs).toBeUndefined()
  })

  it('walks keyset pages: every thread once, boosted ones only on the first page', () => {
    const seen: number[][] = []
    let after: { receivedAt: string; threadId: string; sortMs?: number } | undefined
    for (;;) {
      const page = index.conversations('a', filter(), { limit: 50, ...(after ? { after } : {}) })
      expect(page.total).toBe(120)
      if (!page.items.length) break
      seen.push(uids(page.items))
      const last = page.items.at(-1)!
      after = {
        receivedAt: last.latest.receivedAt,
        threadId: last.threadId,
        ...(last.sortMs !== undefined ? { sortMs: last.sortMs } : {}),
      }
    }
    expect(seen.map((p) => p.length)).toEqual([50, 50, 20])
    expect(new Set(seen.flat()).size).toBe(120)
    expect(seen[0]!.slice(0, 3)).toEqual([2, 3, 1])
    for (const page of seen.slice(1)) for (const uid of [1, 2, 3]) expect(page).not.toContain(uid)
  })

  it('continues a keyset page from a boosted row', () => {
    const first = index.conversations('a', filter(), { limit: 2 })
    const last = first.items.at(-1)!
    expect(last.sortMs).toBe(ms(201))
    const next = index.conversations('a', filter(), {
      limit: 2,
      after: { receivedAt: last.latest.receivedAt, threadId: last.threadId, sortMs: last.sortMs },
    })
    expect(uids(next.items)).toEqual([1, 120])
  })

  it('gives the same order with offset paging', () => {
    const keyset: number[] = []
    let after: { receivedAt: string; threadId: string; sortMs?: number } | undefined
    for (let n = 0; n < 3; n++) {
      const page = index.conversations('a', filter(), { limit: 50, ...(after ? { after } : {}) })
      keyset.push(...uids(page.items))
      const last = page.items.at(-1)!
      after = { receivedAt: last.latest.receivedAt, threadId: last.threadId, sortMs: last.sortMs }
    }
    const offset = [0, 50, 100].flatMap((o) =>
      uids(index.conversations('a', filter(), { limit: 50, offset: o }).items),
    )
    expect(offset).toEqual(keyset)
    expect(offset).toHaveLength(120)
  })

  it('lands a thread due mid-list on a later page, with keyset and offset paging across it', () => {
    // Thread 10, due between threads 71 and 70: the fourth row of the second page.
    const mid = { threadId: thread.get(10)!, sortMs: ms(70) + 1800_000 }
    const due = [...boost, mid]
    const order = [2, 3, 1, ...range(120, 71), 10, ...range(70, 11), ...range(9, 4)]
    const keyset: number[][] = []
    let after: { receivedAt: string; threadId: string; sortMs?: number } | undefined
    for (;;) {
      const page = index.conversations('a', filter({ boost: due }), {
        limit: 50,
        ...(after ? { after } : {}),
      })
      expect(page.total).toBe(120)
      if (!page.items.length) break
      keyset.push(uids(page.items))
      const last = page.items.at(-1)!
      after = { receivedAt: last.latest.receivedAt, threadId: last.threadId, sortMs: last.sortMs }
    }
    expect(keyset.flat()).toEqual(order)
    expect(keyset[1]!.slice(0, 5)).toEqual([73, 72, 71, 10, 70])
    const offset = [0, 50, 100].flatMap((o) =>
      uids(index.conversations('a', filter({ boost: due }), { limit: 50, offset: o }).items),
    )
    expect(offset).toEqual(order)
    // Pages of two that start just before it, on it, and just after it.
    const row = (uid: number) =>
      index
        .conversations('a', filter({ boost: due }), { limit: 120 })
        .items.find((r) => r.latest.uid === uid)!
    const from = (uid: number) => {
      const r = row(uid)
      const cursor = { receivedAt: r.latest.receivedAt, threadId: r.threadId, sortMs: r.sortMs }
      return uids(
        index.conversations('a', filter({ boost: due }), { limit: 2, after: cursor }).items,
      )
    }
    expect(row(10).sortMs).toBe(mid.sortMs)
    expect(from(72)).toEqual([71, 10])
    expect(from(71)).toEqual([10, 70])
    expect(from(10)).toEqual([70, 69])
    const at = order.indexOf(10)
    expect(
      uids(index.conversations('a', filter({ boost: due }), { limit: 2, offset: at - 1 }).items),
    ).toEqual([71, 10])
  })

  it('never adds a boosted thread the filter leaves out', () => {
    const unread = index.conversations('a', filter({ unseen: true }), { limit: 50 })
    expect(uids(unread.items)).toEqual([2])
    expect(unread.total).toBe(1)
    const none = index.conversations('a', filter({ ids: [] }), { limit: 50 })
    expect(none).toEqual({ items: [], total: 0 })
  })

  it('boosts within an Important tab, which keeps only its own threads', () => {
    const important: SplitScope = { kind: 'important', always: [], never: [] }
    const robot = { threadId: thread.get(5)!, sortMs: ms(300) }
    const page = index.conversations('a', filter({ split: important, boost: [...boost, robot] }), {
      limit: 50,
    })
    expect(page.total).toBe(96)
    expect(uids(page.items).slice(0, 4)).toEqual([2, 3, 1, 119])
    expect(uids(page.items)).not.toContain(5)
    expect(uids(page.items).some((uid) => uid % 5 === 0)).toBe(false)
  })

  it('never sinks a thread whose due time is older than its latest message', () => {
    const early = [...boost, { threadId: thread.get(60)!, sortMs: ms(59) }]
    const plain = index.conversations('a', { mailboxIds: [inbox] }, { limit: 120 })
    const page = index.conversations('a', filter({ boost: early }), { limit: 120 })
    const natural = uids(plain.items).filter((uid) => uid > 3)
    expect(uids(page.items)).toEqual([2, 3, 1, ...natural])
    expect(page.items.find((r) => r.latest.uid === 60)!.sortMs).toBeUndefined()
    // Keyset pages around it, and offset pages, agree.
    const at = uids(page.items).indexOf(60)
    const before = page.items[at - 1]!
    const next = index.conversations('a', filter({ boost: early }), {
      limit: 2,
      after: { receivedAt: before.latest.receivedAt, threadId: before.threadId },
    })
    expect(uids(next.items)).toEqual([60, 59])
    const offset = index.conversations('a', filter({ boost: early }), { limit: 2, offset: at })
    expect(uids(offset.items)).toEqual([60, 59])
  })

  it('takes a thread listed twice once, at its latest due time', () => {
    const twice = [...boost, { threadId: thread.get(1)!, sortMs: ms(250) }]
    const page = index.conversations('a', filter({ boost: twice }), { limit: 50 })
    expect(page.total).toBe(120)
    expect(uids(page.items).slice(0, 4)).toEqual([1, 2, 3, 120])
    expect(new Set(uids(page.items)).size).toBe(50)
  })

  it('runs exactly the plain inbox statement without a boost', () => {
    const prepared: string[] = []
    const prepare = DatabaseSync.prototype.prepare
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      prepared.push(sql)
      return prepare.call(this, sql)
    })
    const pageSql = () => prepared.filter((sql) => sql.startsWith('WITH g AS MATERIALIZED'))
    try {
      // A fresh index, so every statement is prepared (and seen) again.
      index.close()
      index = new SqliteMetadataIndex(join(directory, 'index.sqlite'))
      const after = { receivedAt: hour(60), threadId: thread.get(60)! }
      const plain = [
        index.conversations('a', { mailboxIds: [inbox] }, { limit: 50 }),
        index.conversations('a', { mailboxIds: [inbox] }, { limit: 50, after }),
      ]
      expect(pageSql()).toEqual(TODAY)
      const empty = [
        index.conversations('a', { mailboxIds: [inbox], boost: [] }, { limit: 50 }),
        index.conversations('a', { mailboxIds: [inbox], boost: [] }, { limit: 50, after }),
      ]
      // Cached by text: the same statements, not new ones.
      expect(pageSql()).toEqual(TODAY)
      expect(empty).toEqual(plain)
    } finally {
      spy.mockRestore()
    }
    expect(index.explainConversations('a', { mailboxIds: [inbox], boost: [] }, {})).toEqual(
      index.explainConversations('a', { mailboxIds: [inbox] }, {}),
    )
  })

  it('reads a boosted page through indexes', () => {
    const after = { receivedAt: hour(60), threadId: thread.get(60)!, sortMs: ms(60) }
    const plans = [
      index.explainConversations('a', filter(), {}),
      index.explainConversations('a', filter(), { after }),
      index.explainConversations(
        'a',
        filter({ split: { kind: 'important', always: [], never: [] } }),
        {},
      ),
    ]
    for (const plan of plans) {
      expect(plan.length).toBeGreaterThan(0)
      for (const detail of plan) expect(detail).not.toMatch(/^SCAN m\b/)
    }
    // The boosted statement differs from the plain one only outside the grouped set.
    expect(plans[0]).not.toEqual(index.explainConversations('a', { mailboxIds: [inbox] }, {}))
    const important: SplitScope = { kind: 'important', always: [], never: [] }
    for (const split of [undefined, important])
      expect(index.explainConversations('a', filter({ split }))).toEqual(
        index.explainConversations('a', { mailboxIds: [inbox], split }),
      )
  })
})

// The page statements as they were before reminders: a plain inbox page, then a keyset page.
const TODAY = [
  'WITH g AS MATERIALIZED (SELECT m.thread_id AS t, max(m.received_ms) AS r, m.seq AS s FROM messages m\n        WHERE m.account_id = ? AND m.mailbox_id = ? GROUP BY m.thread_id\n        )\n        SELECT (SELECT count(*) FROM g) AS total,\n          (SELECT json_group_array(json_array(t, s) ORDER BY r DESC, t) FROM (\n            SELECT t, r, s FROM g  ORDER BY r DESC, t LIMIT ? OFFSET ?)) AS page',
  'WITH g AS MATERIALIZED (SELECT m.thread_id AS t, max(m.received_ms) AS r, m.seq AS s FROM messages m\n        WHERE m.account_id = ? AND m.mailbox_id = ? GROUP BY m.thread_id\n        )\n        SELECT (SELECT count(*) FROM g) AS total,\n          (SELECT json_group_array(json_array(t, s) ORDER BY r DESC, t) FROM (\n            SELECT t, r, s FROM g WHERE r < ? OR (r = ? AND t > ?) ORDER BY r DESC, t LIMIT ? OFFSET ?)) AS page',
]

describe('merging accounts with due reminders', () => {
  const sample = (accountId: string, threadId: string, receivedAt: string): Message => ({
    id: accountId + '-' + threadId,
    accountId,
    threadId,
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    from: [{ name: 'Ada', email: 'ada@example.com' }],
    to: [{ name: 'Me', email: 'me@example.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Subject',
    preview: 'Preview',
    receivedAt,
    size: 100,
    hasAttachment: false,
  })
  const conv = (accountId: string, threadId: string, receivedAt: string) =>
    conversationFromMessages(accountId, threadId, [sample(accountId, threadId, receivedAt)])

  it('sorts by the due time when there is one', () => {
    const plain = conv('a', 'a1', '2026-09-23T11:00:00.000Z')
    const due = {
      ...conv('b', 'b1', '2026-09-20T08:00:00.000Z'),
      reminder: { kind: 'reply' as const, dueAt: '2026-09-23T12:00:00.000Z', messageId: 'x' },
    }
    expect(conversationSortKey(plain)).toBe(plain.receivedAt)
    expect(conversationSortKey(due)).toBe('2026-09-23T12:00:00.000Z')
    const page = mergePages(
      [
        {
          accountId: 'a',
          position: 0,
          page: { items: [plain, conv('a', 'a2', '2026-09-23T09:00:00.000Z')], total: 2, next: 2 },
        },
        {
          accountId: 'b',
          position: 0,
          page: { items: [due, conv('b', 'b2', '2026-09-23T10:00:00.000Z')], total: 2 },
        },
      ],
      2,
    )
    expect(page.items.map((c) => c.id)).toEqual(['b1', 'a1'])
    // One consumed from each: the next page starts after them, skipping nothing.
    expect(page.next).toEqual({ a: 1, b: 1 })
    expect(page.total).toBe(4)
  })

  it('never sorts a conversation below its latest message', () => {
    const early = {
      ...conv('b', 'b1', '2026-09-23T12:00:00.000Z'),
      reminder: { kind: 'reply' as const, dueAt: '2026-09-23T08:00:00.000Z', messageId: 'x' },
    }
    expect(conversationSortKey(early)).toBe('2026-09-23T12:00:00.000Z')
    const page = mergePages(
      [
        {
          accountId: 'a',
          position: 0,
          page: { items: [conv('a', 'a1', '2026-09-23T11:00:00.000Z')], total: 1 },
        },
        { accountId: 'b', position: 0, page: { items: [early], total: 1 } },
      ],
      2,
    )
    expect(page.items.map((c) => c.id)).toEqual(['b1', 'a1'])
  })
})

describe('inbox order with due reminders (provider)', () => {
  const config: ImapConnectionConfig = {
    protocol: 'imap',
    email: 'me@example.com',
    incoming: { host: 'imap.example.com', port: 993, security: 'tls', username: 'me' },
    outgoing: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'me' },
    outgoingSameCredentials: true,
  }
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString()
  let server: FakeImapServer
  let p: ImapProvider
  let account: Account

  beforeEach(async () => {
    server = new FakeImapServer()
    for (let i = 0; i < 6; i++)
      server.deliver('INBOX', { messageId: 'm' + i + '@x', subject: 'M' + i, date: at(i) })
    server.deliver('Sent', { messageId: 's1@x', subject: 'S1', date: at(1) })
    server.deliver('Sent', { messageId: 's2@x', subject: 'S2', date: at(2) })
    p = new ImapProvider({
      connectionId: 'c1',
      name: 'Work',
      config,
      password: 'disposable',
      index: openInProcessIndex(join(directory, 'provider.sqlite')),
      readAttachment: async () => new TextEncoder().encode('attached'),
      background: false,
      ports: server.port,
      timing: { sentCopyGraceMs: 0, initialBatch: 50, historicalBatch: 50, previews: 0 },
    })
    ;[account] = await p.connect()
    await (p as any).syncPass('all')
    while (await (p as any).historicalBatch());
  })
  afterEach(async () => {
    await p.close()
  })

  it('puts a due conversation first in the inbox, with its reminder', async () => {
    const plain = await p.query(account, { view: 'inbox' })
    expect(plain.items.map((c) => c.subject)).toEqual(['M5', 'M4', 'M3', 'M2', 'M1', 'M0'])
    const old = plain.items.find((c) => c.subject === 'M1')!
    const reminder = { kind: 'reply' as const, dueAt: at(30), messageId: 'm1@x' }
    const reminders = [{ threadId: old.id, ...reminder }]
    const boosted = await p.query(account, { view: 'inbox', reminders })
    expect(boosted.items.map((c) => c.subject)).toEqual(['M1', 'M5', 'M4', 'M3', 'M2', 'M0'])
    expect(boosted.total).toBe(6)
    expect(boosted.items[0]!.reminder).toEqual(reminder)
    expect(boosted.items[0]!.receivedAt).toBe(at(1))
    expect(boosted.items.slice(1).some((c) => c.reminder)).toBe(false)
    // Keyset pages continue after the boosted row.
    const first = await p.query(account, { view: 'inbox', reminders }, 0, 2)
    const second = await p.query(account, { view: 'inbox', reminders }, first.next!, 2)
    expect([...first.items, ...second.items].map((c) => c.subject)).toEqual([
      'M1',
      'M5',
      'M4',
      'M3',
    ])
  })

  it('ignores reminders outside the inbox', async () => {
    const sent = await p.query(account, { view: 'sent' })
    const old = sent.items.find((c) => c.subject === 'S1')!
    const reminders = [
      { threadId: old.id, kind: 'followUp' as const, dueAt: at(30), messageId: 's1@x' },
    ]
    const again = await p.query(account, { view: 'sent', reminders })
    expect(again.items.map((c) => c.subject)).toEqual(['S2', 'S1'])
    expect(again.items.some((c) => c.reminder)).toBe(false)
    const sentBox = (await p.mailboxes(account)).find((b) => b.role === 'sent')!
    const folder = await p.query(account, { view: 'inbox', mailboxId: sentBox.id, reminders })
    expect(folder.items.some((c) => c.reminder)).toBe(false)
  })
})
