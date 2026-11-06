import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { domainKey, type SplitScope } from '@inlark/core'
import {
  openInProcessIndex,
  SCHEMA_VERSION,
  SqliteMetadataIndex,
} from '../apps/desktop/src/main/imap-index/sqlite-index'
import { tabCountsQuery } from '../apps/desktop/src/main/imap-index/split-sql'
import type { FolderListing, MetadataIndex, NewMessage } from '@inlark/imap'

let directory: string
let path: string
let index: MetadataIndex

const folder = (path: string): FolderListing => ({
  path,
  name: path,
  delimiter: '/',
  parentPath: null,
  specialUse: null,
  guessedSpecialUse: null,
  noSelect: false,
})

const day = (n: number) => new Date(Date.UTC(2024, 0, 1) + n * 3600_000).toISOString()

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
    to: [{ name: '', email: 'me@example.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    receivedAt: day(uid),
    size: 1000 + uid,
    flags: [],
    hasAttachment: false,
    preview: 'Preview ' + uid,
    ...extra,
  }
}

async function inbox() {
  const [box] = await index.syncMailboxes('a', [folder('INBOX')])
  return box!.id
}

function read<T>(sql: string): T[] {
  const db = new DatabaseSync(path)
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'inlark-split-'))
  path = join(directory, 'index', 'imap.sqlite')
  index = openInProcessIndex(path)
})
afterEach(async () => {
  await index.close()
  await rm(directory, { recursive: true, force: true })
})

describe('schema v4', () => {
  it('migrates a v3 index and backfills participants', async () => {
    const box = await inbox()
    await index.upsertMessages('a', [
      message(box, 1, { from: [] }),
      message(box, 2, { from: [{ name: '', email: 'not-an-address' }] }),
      message(box, 3, {
        to: [
          { name: '', email: 'me@example.com' },
          { name: '', email: 'Bob@Mail.clientb.example' },
        ],
        cc: [{ name: '', email: 'cc@example.org' }],
      }),
      message(box, 4, { unsubscribe: { url: 'https://x.example/u', oneClick: false } }),
      message(box, 5, { from: [{ name: '', email: 'no-reply@asana.com' }] }),
    ])
    await index.close()
    const db = new DatabaseSync(path)
    db.exec(`DROP TABLE participants; DROP INDEX messages_mailbox_person;
      ALTER TABLE messages DROP COLUMN from_email;
      ALTER TABLE messages DROP COLUMN list_id;
      ALTER TABLE messages DROP COLUMN precedence;
      ALTER TABLE messages DROP COLUMN auto_submitted;
      ALTER TABLE messages DROP COLUMN headers_checked;
      ALTER TABLE messages DROP COLUMN automated;
      PRAGMA user_version = 3`)
    db.close()
    index = openInProcessIndex(path)
    await index.close()

    expect(read('PRAGMA user_version')).toEqual([{ user_version: 4 }])
    expect(SCHEMA_VERSION).toBe(4)
    expect(
      read<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'messages_mailbox_%' ORDER BY name",
      ).map((r) => r.name),
    ).toEqual(['messages_mailbox_person', 'messages_mailbox_received', 'messages_mailbox_thread'])
    const rows = read<{ uid: number; seq: number; automated: number; headers_checked: number }>(
      'SELECT uid, seq, automated, headers_checked FROM messages ORDER BY uid',
    )
    expect(rows.map((r) => r.automated)).toEqual([0, 0, 0, 1, 1])
    expect(rows.every((r) => r.headers_checked === 0)).toBe(true)
    const seqOf = (uid: number) => rows.find((r) => r.uid === uid)!.seq
    const people = (uid: number) =>
      read<{ address: string; domain: string; role: string }>(
        `SELECT address, domain, role FROM participants WHERE message_seq = ${seqOf(uid)}
          ORDER BY role, address`,
      )
    expect(people(1)).toEqual([{ address: 'me@example.com', domain: 'com.example', role: 'to' }])
    expect(people(2)).toEqual([{ address: 'me@example.com', domain: 'com.example', role: 'to' }])
    expect(people(3)).toEqual(
      [
        { address: 'ada@example.com', domain: 'com.example', role: 'from' },
        { address: 'cc@example.org', domain: 'org.example', role: 'cc' },
        { address: 'bob@mail.clientb.example', domain: 'example.clientb.mail', role: 'to' },
        { address: 'me@example.com', domain: 'com.example', role: 'to' },
      ].sort((a, b) => (a.role + a.address < b.role + b.address ? -1 : 1)),
    )
    expect(read('SELECT from_email FROM messages ORDER BY uid')).toEqual([
      { from_email: null },
      { from_email: null },
      { from_email: 'ada@example.com' },
      { from_email: 'ada@example.com' },
      { from_email: 'no-reply@asana.com' },
    ])
  })

  it('treats malformed address JSON as empty during migration', async () => {
    const box = await inbox()
    await index.upsertMessages('a', [message(box, 1)])
    await index.close()
    const db = new DatabaseSync(path)
    db.exec(`DROP TABLE participants; DROP INDEX messages_mailbox_person;
      ALTER TABLE messages DROP COLUMN from_email;
      ALTER TABLE messages DROP COLUMN list_id;
      ALTER TABLE messages DROP COLUMN precedence;
      ALTER TABLE messages DROP COLUMN auto_submitted;
      ALTER TABLE messages DROP COLUMN headers_checked;
      ALTER TABLE messages DROP COLUMN automated;
      UPDATE messages SET from_addr = '{oops';
      PRAGMA user_version = 3`)
    db.close()
    index = openInProcessIndex(path)
    await index.close()
    expect(read("SELECT count(*) AS n FROM participants WHERE role = 'from'")).toEqual([{ n: 0 }])
    expect(read('SELECT count(*) AS n FROM participants')).toEqual([{ n: 1 }])
  })

  it('keeps header-derived automation when v4 runs again', async () => {
    const box = await inbox()
    await index.upsertMessages('a', [message(box, 1)])
    await index.upsertMessages('a', [
      message(box, 1, { automation: { listId: null, precedence: 'bulk', autoSubmitted: null } }),
    ])
    await index.close()
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version = 3')
    db.close()
    index = openInProcessIndex(path)
    await index.close()
    expect(read('SELECT automated, headers_checked FROM messages')).toEqual([
      { automated: 1, headers_checked: 1 },
    ])
  })

  it('writes one participant per address and role and skips empty domains', async () => {
    const box = await inbox()
    await index.upsertMessages('a', [
      message(box, 1, {
        to: [
          { name: '', email: 'Me@example.com' },
          { name: '', email: 'me@example.com' },
          { name: '', email: 'broken@' },
        ],
      }),
    ])
    await index.close()
    expect(read('SELECT address, role, domain FROM participants ORDER BY role')).toEqual([
      { address: 'ada@example.com', role: 'from', domain: 'com.example' },
      { address: 'me@example.com', role: 'to', domain: 'com.example' },
    ])
  })

  it('stores participants and automation for new mail', async () => {
    const box = await inbox()
    await index.upsertMessages('a', [
      message(box, 1, { automation: { listId: '<x>', precedence: null, autoSubmitted: null } }),
      message(box, 2),
    ])
    await index.close()
    expect(
      read('SELECT uid, headers_checked, automated, list_id FROM messages ORDER BY uid'),
    ).toEqual([
      { uid: 1, headers_checked: 1, automated: 1, list_id: '<x>' },
      { uid: 2, headers_checked: 0, automated: 0, list_id: null },
    ])
    expect(read('SELECT address, role FROM participants ORDER BY message_seq, role')).toEqual([
      { address: 'ada@example.com', role: 'from' },
      { address: 'me@example.com', role: 'to' },
      { address: 'ada@example.com', role: 'from' },
      { address: 'me@example.com', role: 'to' },
    ])
  })

  it('fills automation on an existing location once', async () => {
    const box = await inbox()
    await index.upsertMessages('a', [message(box, 1)])
    await index.upsertMessages('a', [
      message(box, 1, { automation: { listId: null, precedence: 'bulk', autoSubmitted: null } }),
    ])
    await index.upsertMessages('a', [
      message(box, 1, { automation: { listId: '<later>', precedence: null, autoSubmitted: null } }),
    ])
    await index.close()
    expect(read('SELECT headers_checked, automated, list_id, precedence FROM messages')).toEqual([
      { headers_checked: 1, automated: 1, list_id: null, precedence: 'bulk' },
    ])
    expect(read('SELECT count(*) AS n FROM participants')).toEqual([{ n: 2 }])
  })

  it('lists unchecked headers newest first and stores fetched ones', async () => {
    const box = await inbox()
    await index.upsertMessages('a', [
      message(box, 1),
      message(box, 2),
      message(box, 3),
      message(box, 4, { automation: { listId: null, precedence: null, autoSubmitted: null } }),
    ])
    expect(await index.uncheckedHeaders('a', box, 2)).toEqual([
      { uid: 3, uidValidity: '1' },
      { uid: 2, uidValidity: '1' },
    ])
    await index.setAutomationHeaders('a', box, [
      { uid: 3, listId: '<news.example>', precedence: null, autoSubmitted: null },
      { uid: 2, listId: null, precedence: null, autoSubmitted: null },
    ])
    expect(await index.uncheckedHeaders('a', box, 10)).toEqual([{ uid: 1, uidValidity: '1' }])
    await index.close()
    expect(
      read('SELECT uid, headers_checked, automated, list_id FROM messages ORDER BY uid'),
    ).toEqual([
      { uid: 1, headers_checked: 0, automated: 0, list_id: null },
      { uid: 2, headers_checked: 1, automated: 0, list_id: null },
      { uid: 3, headers_checked: 1, automated: 1, list_id: '<news.example>' },
      { uid: 4, headers_checked: 1, automated: 0, list_id: null },
    ])
  })

  it('drops participants with their message', async () => {
    const box = await inbox()
    await index.upsertMessages('a', [message(box, 1), message(box, 2), message(box, 3)])
    await index.removeUids('a', box, [1])
    await index.resetMailbox('a', box, '2')
    await index.close()
    expect(
      read(
        'SELECT count(*) AS n FROM participants WHERE message_seq NOT IN (SELECT seq FROM messages)',
      ),
    ).toEqual([{ n: 0 }])
    expect(read('SELECT count(*) AS n FROM participants')).toEqual([{ n: 0 }])
  })
})

describe('tab filter', () => {
  async function boxes(...paths: string[]) {
    const listed = await index.syncMailboxes('a', paths.map(folder))
    return Object.fromEntries(listed.map((b) => [b.path, b.id])) as Record<string, string>
  }
  const from = (email: string) => ({ from: [{ name: '', email }] })
  const uids = (rows: { latest: { uid: number } }[]) => rows.map((r) => r.latest.uid).sort()
  const all = (split: SplitScope, mailboxId: string) =>
    index.conversations('a', { mailboxIds: [mailboxId], split }, { limit: 500 })
  const important = (always: { address: string; words: string[] }[] = [], never: string[] = []) =>
    ({ kind: 'important', always, never }) as const

  it('rules tab matches any participant on any message of the thread', async () => {
    const { INBOX, Archive } = await boxes('INBOX', 'Archive', 'Sent')
    await index.upsertMessages('a', [
      message(INBOX!, 10, from('julia@client.example')),
      message(INBOX!, 20, {
        ...from('colleague@work.example'),
        cc: [{ name: '', email: 'julia@mail.client.example' }],
      }),
      message(INBOX!, 30, from('colleague@work.example')),
      message(Archive!, 31, {
        ...from('client.person@gmail.com'),
        references: ['m30@example.com'],
      }),
      message(Archive!, 40, from('client.person@gmail.com')),
      message(INBOX!, 50, from('x@notclient.example')),
      // Its domain key sorts inside the range of `example.client`.
      message(INBOX!, 60, from('x@client-eu.example')),
    ])
    const page = await all(
      {
        kind: 'rules',
        addresses: ['client.person@gmail.com'],
        domains: [domainKey('client.example')],
      },
      INBOX!,
    )
    expect(uids(page.items)).toEqual([10, 20, 30])
    expect(page.total).toBe(3)
  })

  it('Gmail duplicates count once', async () => {
    const { INBOX, '[Gmail]/All Mail': allMail } = await boxes('INBOX', '[Gmail]/All Mail')
    await index.upsertMessages('a', [
      message(INBOX!, 1, { emailId: 'e1' }),
      message(allMail!, 7, { emailId: 'e1' }),
    ])
    const scope: SplitScope = { kind: 'rules', addresses: ['ada@example.com'], domains: [] }
    expect(await index.tabCounts('a', INBOX!, { x: scope })).toEqual({
      x: { conversations: 1, unread: 1 },
    })
    expect((await all(scope, INBOX!)).total).toBe(1)
  })

  it('important leaves out automated mail and honours always and never', async () => {
    const { INBOX } = await boxes('INBOX', 'Archive', 'Sent')
    const alerts = {
      ...from('alerts@crashlytics.com'),
      automation: { listId: '<alerts.crashlytics.com>', precedence: null, autoSubmitted: null },
    }
    await index.upsertMessages('a', [
      message(INBOX!, 1, from('friend@example.org')),
      message(INBOX!, 2, from('no-reply@asana.com')),
      message(INBOX!, 3, {
        ...from('news@shop.example'),
        unsubscribe: { url: 'https://shop.example/u', oneClick: true },
      }),
      message(INBOX!, 4, { ...alerts, subject: 'New crash in app' }),
      message(INBOX!, 5, { ...alerts, subject: 'Weekly digest' }),
      message(INBOX!, 6, from('colleague@work.example')),
    ])
    const page = await all(
      important(
        [{ address: 'alerts@crashlytics.com', words: ['crash', 'failure'] }],
        ['colleague@work.example'],
      ),
      INBOX!,
    )
    expect(uids(page.items)).toEqual([1, 4])
  })

  it('important keeps all mail from an always address without words', async () => {
    const { INBOX } = await boxes('INBOX')
    await index.upsertMessages('a', [
      message(INBOX!, 1, from('no-reply@asana.com')),
      message(INBOX!, 2, from('no-reply@other.example')),
    ])
    const page = await all(important([{ address: 'no-reply@asana.com', words: [] }]), INBOX!)
    expect(uids(page.items)).toEqual([1])
  })

  it('important looks only at inbox messages', async () => {
    const { INBOX, Sent } = await boxes('INBOX', 'Archive', 'Sent')
    await index.upsertMessages('a', [
      message(INBOX!, 1, from('no-reply@robot.example')),
      message(Sent!, 2, { ...from('me@work.example'), references: ['m1@example.com'] }),
      message(INBOX!, 3, from('friend@example.org')),
    ])
    const page = await all(important(), INBOX!)
    expect(uids(page.items)).toEqual([3])
    expect(page.total).toBe(1)
  })

  it('pages a tab with keyset and offset', async () => {
    const { INBOX } = await boxes('INBOX', 'Archive', 'Sent')
    const batch: NewMessage[] = []
    for (let uid = 1; uid <= 150; uid++)
      batch.push(message(INBOX!, uid, uid % 5 === 0 ? from('other@else.example') : {}))
    // 120 matching threads: the rest are from someone else.
    expect(batch.filter((m) => m.from[0]!.email === 'Ada@Example.com')).toHaveLength(120)
    await index.upsertMessages('a', batch)
    const split: SplitScope = { kind: 'rules', addresses: ['ada@example.com'], domains: [] }
    const filter = { mailboxIds: [INBOX!], split }
    const first = await index.conversations('a', filter, { limit: 50 })
    const last = first.items.at(-1)!
    const second = await index.conversations('a', filter, {
      limit: 50,
      after: { receivedAt: last.latest.receivedAt, threadId: last.threadId },
    })
    const third = await index.conversations('a', filter, { limit: 50, offset: 100 })
    expect([first.total, second.total, third.total]).toEqual([120, 120, 120])
    expect([first.items.length, second.items.length, third.items.length]).toEqual([50, 50, 20])
    const seen = [...first.items, ...second.items, ...third.items].map((r) => r.threadId)
    expect(new Set(seen).size).toBe(120)
  })

  it('pages Important with keyset and offset', async () => {
    const { INBOX } = await boxes('INBOX', 'Archive', 'Sent')
    const batch: NewMessage[] = []
    for (let uid = 1; uid <= 150; uid++)
      batch.push(message(INBOX!, uid, uid % 5 === 0 ? from('no-reply@robot.example') : {}))
    await index.upsertMessages('a', batch)
    const filter = { mailboxIds: [INBOX!], split: important() }
    const first = await index.conversations('a', filter, { limit: 50 })
    const last = first.items.at(-1)!
    const second = await index.conversations('a', filter, {
      limit: 50,
      after: { receivedAt: last.latest.receivedAt, threadId: last.threadId },
    })
    const third = await index.conversations('a', filter, { limit: 50, offset: 100 })
    expect([first.total, second.total, third.total]).toEqual([120, 120, 120])
    expect([first.items.length, second.items.length, third.items.length]).toEqual([50, 50, 20])
    const rows = [...first.items, ...second.items, ...third.items]
    expect(new Set(rows.map((r) => r.threadId)).size).toBe(120)
    expect(rows.some((r) => r.latest.uid % 5 === 0)).toBe(false)
    expect(rows.map((r) => r.latest.uid)).toEqual(
      [...rows.map((r) => r.latest.uid)].sort((a, b) => b - a),
    )
  })

  it('important with another filter still judges the whole inbox thread', async () => {
    const { INBOX } = await boxes('INBOX')
    await index.upsertMessages('a', [
      message(INBOX!, 1, { ...from('friend@example.org'), flags: ['\\Seen'] }),
      message(INBOX!, 2, { ...from('no-reply@robot.example'), references: ['m1@example.com'] }),
      message(INBOX!, 3, from('no-reply@robot.example')),
    ])
    const page = await index.conversations(
      'a',
      { mailboxIds: [INBOX!], split: important(), unseen: true },
      { limit: 10 },
    )
    // The thread is Important through its seen message; its unseen one represents it.
    expect(uids(page.items)).toEqual([2])
    expect(page.total).toBe(1)
  })

  it('an empty rules scope matches nothing', async () => {
    const { INBOX } = await boxes('INBOX')
    await index.upsertMessages('a', [message(INBOX!, 1)])
    const empty: SplitScope = { kind: 'rules', addresses: [], domains: [] }
    expect(await all(empty, INBOX!)).toEqual({ items: [], total: 0 })
    expect(await index.tabCounts('a', INBOX!, { empty })).toEqual({
      empty: { conversations: 0, unread: 0 },
    })
    expect(await index.tabCounts('a', INBOX!, {})).toEqual({})
  })

  it('tab counts in one call', async () => {
    const { INBOX, Archive } = await boxes('INBOX', 'Archive')
    await index.upsertMessages('a', [
      message(INBOX!, 1, from('a@one.example')),
      message(INBOX!, 2, { ...from('a@one.example'), references: ['m1@example.com'] }),
      message(INBOX!, 3, { ...from('b@two.example'), flags: ['\\Seen'] }),
      message(INBOX!, 4, from('no-reply@two.example')),
      message(INBOX!, 5, from('c@three.example')),
      message(Archive!, 6, { ...from('a@one.example'), references: ['m5@example.com'] }),
    ])
    const scopes: Record<string, SplitScope> = {
      one: { kind: 'rules', addresses: ['a@one.example'], domains: [] },
      two: { kind: 'rules', addresses: [], domains: [domainKey('two.example')] },
      important: important(),
    }
    const counts = await index.tabCounts('a', INBOX!, scopes)
    expect(counts).toEqual({
      one: { conversations: 2, unread: 3 },
      two: { conversations: 2, unread: 1 },
      important: { conversations: 3, unread: 3 },
    })
    for (const [key, split] of Object.entries(scopes))
      expect(counts[key]!.conversations).toBe((await all(split, INBOX!)).total)
  })

  it('split needs the inbox scope', async () => {
    const { INBOX, Archive } = await boxes('INBOX', 'Archive')
    const split = important()
    await expect(index.conversations('a', { split }, { limit: 5 })).rejects.toThrow(
      'A tab needs the inbox scope.',
    )
    await expect(
      index.conversations('a', { mailboxIds: [INBOX!, Archive!], split }, { limit: 5 }),
    ).rejects.toThrow('A tab needs the inbox scope.')
  })

  it('tab queries stay indexed on a large mailbox', () => {
    const sync = new SqliteMetadataIndex(join(directory, 'large.sqlite'))
    const [inboxBox, archive, sent] = sync.syncMailboxes('a', [
      folder('INBOX'),
      folder('Archive'),
      folder('Sent'),
    ])
    const sender = (n: number) => `u${n % 2000}@d${n % 200}.example`
    for (let start = 0; start < 50_000; start += 500) {
      const batch: NewMessage[] = []
      for (let uid = start + 1; uid <= start + 500; uid++)
        batch.push(
          message(uid % 5 < 2 ? inboxBox!.id : uid % 5 < 4 ? archive!.id : sent!.id, uid, {
            ...from(sender(uid)),
            references: uid % 5 ? ['m' + (uid - (uid % 5)) + '@example.com'] : [],
            flags: uid % 7 ? ['\\Seen'] : [],
            ...(uid % 3 ? {} : { unsubscribe: { url: 'https://x.example/u', oneClick: false } }),
          }),
        )
      sync.upsertMessages('a', batch)
    }
    const inbox = inboxBox!.id
    const rules: SplitScope = {
      kind: 'rules',
      addresses: [sender(1), sender(2), sender(3)],
      domains: [domainKey('d10.example'), domainKey('d11.example')],
    }
    const imp = important([{ address: sender(4), words: ['subject'] }], [sender(5)])
    const counted = tabCountsQuery('a', inbox, { rules, important: imp })!
    const db = new DatabaseSync(join(directory, 'large.sqlite'))
    const plans = {
      rules: sync.explainConversations('a', { mailboxIds: [inbox], split: rules }),
      important: sync.explainConversations('a', { mailboxIds: [inbox], split: imp }),
      importantUnseen: sync.explainConversations('a', {
        mailboxIds: [inbox],
        split: imp,
        unseen: true,
      }),
      tabCounts: (
        db.prepare('EXPLAIN QUERY PLAN ' + counted.sql).all(...counted.params) as {
          detail: string
        }[]
      ).map((r) => r.detail),
    }
    for (const details of Object.values(plans))
      for (const detail of details) expect(detail).not.toMatch(/^SCAN [pmt]\b/)
    // Important is one pass over the inbox index, without reading table rows.
    expect(plans.important.join('\n')).toMatch(
      /SEARCH m USING COVERING INDEX messages_mailbox_person \(account_id=\? AND mailbox_id=\?\)/,
    )
    expect(plans.tabCounts.join('\n')).toMatch(
      /SEARCH m USING COVERING INDEX messages_mailbox_person \(account_id=\? AND mailbox_id=\?\)/,
    )
    // No walk of the whole inbox that reads table rows.
    for (const detail of [...plans.important, ...plans.tabCounts])
      expect(detail).not.toMatch(/USING INDEX \w+ \(account_id=\? AND mailbox_id=\?\)$/)
    // Each rule is a lookup on its own key, never a walk of the account's participants.
    const lookups = plans.rules.filter((d) => /participants_(address|domain)/.test(d))
    expect(lookups.some((d) => d.includes('address=?'))).toBe(true)
    expect(lookups.some((d) => /domain[=>]/.test(d))).toBe(true)
    for (const detail of lookups) expect(detail).toMatch(/account_id=\? AND (address|domain)/)
    // A plain-JS reading of both scopes over the stored rows, to check counts and totals.
    type Row = {
      seq: number
      thread_id: string
      mailbox_id: string
      seen: number
      e: string
      automated: number
      from_email: string | null
      subject: string
    }
    const rows = db
      .prepare(
        `SELECT seq, thread_id, mailbox_id, seen, coalesce(email_id, id) AS e, automated,
          from_email, subject FROM messages`,
      )
      .all() as unknown as Row[]
    const people = db.prepare('SELECT message_seq, address, domain FROM participants').all() as {
      message_seq: number
      address: string
      domain: string
    }[]
    db.close()
    const threadOf = new Map(rows.map((r) => [r.seq, r.thread_id]))
    const inRules = new Set(
      people
        .filter(
          (p) =>
            rules.addresses.includes(p.address) ||
            rules.domains.some((d) => p.domain === d || p.domain.startsWith(d + '.')),
        )
        .map((p) => threadOf.get(p.message_seq)!),
    )
    const inboxRows = rows.filter((r) => r.mailbox_id === inbox)
    const inImportant = new Set(
      inboxRows
        .filter(
          (r) =>
            (r.automated === 0 ||
              (r.from_email === sender(4) && r.subject.toLowerCase().includes('subject'))) &&
            r.from_email !== sender(5),
        )
        .map((r) => r.thread_id),
    )
    const expected = (threads: Set<string>) => {
      const mine = inboxRows.filter((r) => threads.has(r.thread_id))
      return {
        conversations: new Set(mine.map((r) => r.thread_id)).size,
        unread: new Set(mine.filter((r) => !r.seen).map((r) => r.e)).size,
      }
    }
    const counts = sync.tabCounts('a', inbox, { rules, important: imp })
    expect(counts).toEqual({ rules: expected(inRules), important: expected(inImportant) })
    for (const [key, split] of [
      ['rules', rules],
      ['important', imp],
    ] as const) {
      const page = sync.conversations('a', { mailboxIds: [inbox], split }, { limit: 50 })
      expect(page.items).toHaveLength(50)
      expect(counts[key]!.conversations).toBe(page.total)
    }
    sync.close()
  }, 60_000)
})
