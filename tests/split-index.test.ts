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
  UNCHECKED_HEADERS_SQL,
} from '../apps/desktop/src/main/imap-index/sqlite-index'
import { registerSplitFunctions } from '../apps/desktop/src/main/imap-index/split-schema'
import { splitFilter, tabCountQuery } from '../apps/desktop/src/main/imap-index/split-sql'
import type { ConversationFilter, FolderListing, MetadataIndex, NewMessage } from '@inlark/imap'

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
          { name: '', email: 'Bob@Mail.Client.example' },
        ],
        cc: [{ name: '', email: 'cc@example.org' }],
      }),
      message(box, 4, { unsubscribe: { url: 'https://x.example/u', oneClick: false } }),
      message(box, 5, { from: [{ name: '', email: 'no-reply@asana.com' }] }),
    ])
    await index.close()
    const db = new DatabaseSync(path)
    db.exec(`DROP TABLE participants; DROP INDEX messages_mailbox_person; DROP INDEX messages_unchecked_headers;
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
        { address: 'bob@mail.client.example', domain: 'example.client.mail', role: 'to' },
        { address: 'me@example.com', domain: 'com.example', role: 'to' },
      ].sort((a, b) => (a.role + a.address < b.role + b.address ? -1 : 1)),
    )
    expect(
      read(`SELECT count(*) AS n FROM participants p JOIN messages m ON m.seq = p.message_seq
        WHERE p.thread_id <> m.thread_id`),
    ).toEqual([{ n: 0 }])
    expect(
      read<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'participants' ORDER BY name",
      ).map((r) => r.name),
    ).toEqual(['participants_address', 'participants_domain', 'participants_message'])
    expect(
      read<{ name: string }>('PRAGMA index_info(participants_address)').map((r) => r.name),
    ).toEqual(['account_id', 'address', 'thread_id'])
    expect(
      read<{ name: string }>('PRAGMA index_info(participants_domain)').map((r) => r.name),
    ).toEqual(['account_id', 'domain', 'thread_id'])
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
    db.exec(`DROP TABLE participants; DROP INDEX messages_mailbox_person; DROP INDEX messages_unchecked_headers;
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
    await index.setAutomationHeaders('a', box, '1', [
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

  it('only stores headers for the stated UIDVALIDITY', async () => {
    const box = await inbox()
    await index.upsertMessages('a', [message(box, 1)])
    await index.setAutomationHeaders('a', box, '2', [
      { uid: 1, listId: '<x>', precedence: null, autoSubmitted: null },
    ])
    expect(await index.uncheckedHeaders('a', box, 10)).toEqual([{ uid: 1, uidValidity: '1' }])
  })

  it('reads unchecked headers through a partial index', async () => {
    const box = await inbox()
    await index.upsertMessages('a', [message(box, 1)])
    await index.close()
    const db = new DatabaseSync(path)
    try {
      const plan = db.prepare('EXPLAIN QUERY PLAN ' + UNCHECKED_HEADERS_SQL).all('a', box, 10) as {
        detail: string
      }[]
      expect(plan.map((row) => row.detail).join('\n')).toMatch(
        /USING (COVERING )?INDEX messages_unchecked_headers/,
      )
    } finally {
      db.close()
    }
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
  it('runs v4 again over a file from a pre-release v4 build', async () => {
    const box = await inbox()
    await index.upsertMessages('a', [message(box, 1)])
    await index.close()
    const db = new DatabaseSync(path)
    db.exec(`DROP TABLE participants;
      CREATE TABLE participants (account_id TEXT NOT NULL, message_seq INTEGER NOT NULL,
        address TEXT NOT NULL, domain TEXT NOT NULL, role TEXT NOT NULL)`)
    db.close()
    const migrating: string[] = []
    new SqliteMetadataIndex(path, { onMigrate: () => migrating.push('v4') }).close()
    expect(migrating).toEqual(['v4'])
    expect(read('SELECT count(*) AS n FROM participants WHERE thread_id IS NOT NULL')).toEqual([
      { n: 2 },
    ])
    // A current file opens without migrating.
    new SqliteMetadataIndex(path, { onMigrate: () => migrating.push('again') }).close()
    expect(migrating).toEqual(['v4'])
    index = openInProcessIndex(path)
  })

  it('keeps participants on their thread when threads merge', async () => {
    const box = await inbox()
    const [, archive] = await index.syncMailboxes('a', [folder('INBOX'), folder('Archive')])
    await index.upsertMessages('a', [
      message(box, 1, { from: [{ name: '', email: 'one@first.example' }] }),
      message(box, 2, { from: [{ name: '', email: 'two@second.example' }] }),
      // A copy without Message-ID, joined to the first only once its server identity is known.
      message(archive!.id, 3, {
        messageId: undefined,
        from: [{ name: '', email: 'three@third.example' }],
      }),
    ])
    // Links the first two threads, then the copy to the first.
    await index.upsertMessages('a', [
      message(box, 4, { references: ['m1@example.com', 'm2@example.com'] }),
    ])
    await index.upsertMessages('a', [message(box, 1, { emailId: 'e1' })])
    await index.upsertMessages('a', [
      message(archive!.id, 3, {
        messageId: undefined,
        emailId: 'e1',
        from: [{ name: '', email: 'three@third.example' }],
      }),
    ])
    expect(
      read(`SELECT count(*) AS n FROM participants p JOIN messages m ON m.seq = p.message_seq
        WHERE p.thread_id <> m.thread_id`),
    ).toEqual([{ n: 0 }])
    expect(read('SELECT count(DISTINCT thread_id) AS n FROM messages')).toEqual([{ n: 1 }])
    for (const address of ['two@second.example', 'three@third.example']) {
      const split: SplitScope = { kind: 'rules', addresses: [address], domains: [] }
      const page = await index.conversations('a', { mailboxIds: [box], split }, { limit: 10 })
      expect(page.total).toBe(1)
    }
  })

  it('keeps at most 256 characters of List-Id and 64 of the other headers', async () => {
    const box = await inbox()
    const long = { listId: 'l'.repeat(5000), precedence: 'p'.repeat(500), autoSubmitted: null }
    await index.upsertMessages('a', [message(box, 1, { automation: long }), message(box, 2)])
    await index.setAutomationHeaders('a', box, '1', [
      { uid: 2, listId: null, precedence: null, autoSubmitted: 'a'.repeat(500) },
    ])
    await index.close()
    expect(
      read(`SELECT length(list_id) AS l, length(precedence) AS p, length(auto_submitted) AS a
        FROM messages ORDER BY uid`),
    ).toEqual([
      { l: 256, p: 64, a: null },
      { l: null, p: null, a: 64 },
    ])
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

  it('counts every tab', async () => {
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

  it('matches subject words beyond ASCII whatever their case', async () => {
    const { INBOX } = await boxes('INBOX')
    const alerts = {
      ...from('alerts@crashlytics.com'),
      automation: { listId: '<alerts.crashlytics.com>', precedence: null, autoSubmitted: null },
    }
    await index.upsertMessages('a', [
      message(INBOX!, 1, { ...alerts, subject: 'ÉCHEC du déploiement' }),
      message(INBOX!, 2, { ...alerts, subject: 'Rapport hebdomadaire' }),
    ])
    const scope = important([{ address: 'alerts@crashlytics.com', words: ['échec'] }])
    expect(uids((await all(scope, INBOX!)).items)).toEqual([1])
    const unseen = await index.conversations(
      'a',
      { mailboxIds: [INBOX!], split: scope, unseen: true },
      { limit: 10 },
    )
    expect(uids(unseen.items)).toEqual([1])
  })

  it('counts and pages the largest tabs and Important lists settings allow', async () => {
    const { INBOX } = await boxes('INBOX')
    await index.upsertMessages('a', [
      message(INBOX!, 1, from('a@d7.example')),
      message(INBOX!, 2, { ...from('s499@robot.example'), subject: 'w19 in here' }),
      message(INBOX!, 3, from('no-reply@robot.example')),
    ])
    const domains = (t: number) =>
      Array.from({ length: 500 }, (_, n) => domainKey(`d${t * 500 + n}.example`))
    const scopes: Record<string, SplitScope> = {}
    for (let t = 0; t < 50; t++)
      scopes['t' + t] = { kind: 'rules', addresses: [], domains: domains(t) }
    const imp = important(
      Array.from({ length: 500 }, (_, n) => ({
        address: `s${n}@robot.example`,
        words: Array.from({ length: 20 }, (_, w) => 'w' + w),
      })),
      Array.from({ length: 500 }, (_, n) => `never${n}@robot.example`),
    )
    const counts = await index.tabCounts('a', INBOX!, { ...scopes, important: imp })
    expect(counts.t0).toEqual({ conversations: 1, unread: 1 })
    expect(counts.t1).toEqual({ conversations: 0, unread: 0 })
    expect(counts.important).toEqual({ conversations: 2, unread: 2 })
    expect((await all(scopes.t0!, INBOX!)).total).toBe(1)
    const unseen = await index.conversations(
      'a',
      { mailboxIds: [INBOX!], split: imp, unseen: true },
      { limit: 10 },
    )
    expect(uids(unseen.items)).toEqual([1, 2])
  })

  it('counts a tab whatever its id', async () => {
    const { INBOX } = await boxes('INBOX')
    await index.upsertMessages('a', [message(INBOX!, 1)])
    const scope: SplitScope = { kind: 'rules', addresses: ['ada@example.com'], domains: [] }
    const scopes = Object.fromEntries([
      ['__proto__', scope],
      ['constructor', scope],
    ]) as Record<string, SplitScope>
    const counts = await index.tabCounts('a', INBOX!, scopes)
    expect(Object.keys(counts).sort()).toEqual(['__proto__', 'constructor'])
    expect(Object.getOwnPropertyDescriptor(counts, 'constructor')?.value).toEqual({
      conversations: 1,
      unread: 1,
    })
    expect(Object.getOwnPropertyDescriptor(counts, '__proto__')?.value).toEqual({
      conversations: 1,
      unread: 1,
    })
  })

  it('judges Important in the group only when no other filter is set', () => {
    const scope = important()
    expect(splitFilter(scope, 'a', 'i', { mailboxIds: ['i'], split: scope })).toHaveProperty(
      'having',
    )
    expect(
      splitFilter(scope, 'a', 'i', { mailboxIds: ['i'], split: scope, unseen: undefined }),
    ).toHaveProperty('having')
    // A filter key this code doesn't know may drop rows from the group, so it isn't trusted.
    const future = { mailboxIds: ['i'], split: scope, unknownKey: true } as ConversationFilter
    const filter = splitFilter(scope, 'a', 'i', future)
    expect(filter).toHaveProperty('where')
    expect(filter).not.toHaveProperty('having')
    expect(filter!.where!.sql).toMatch(/EXISTS/)
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
    const counted = [tabCountQuery('a', inbox, rules)!, tabCountQuery('a', inbox, imp)!]
    const db = new DatabaseSync(join(directory, 'large.sqlite'))
    registerSplitFunctions(db)
    const plans = {
      rules: sync.explainConversations('a', { mailboxIds: [inbox], split: rules }),
      important: sync.explainConversations('a', { mailboxIds: [inbox], split: imp }),
      importantUnseen: sync.explainConversations('a', {
        mailboxIds: [inbox],
        split: imp,
        unseen: true,
      }),
      tabCounts: counted.flatMap((query) =>
        (
          db.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params) as {
            detail: string
          }[]
        ).map((r) => r.detail),
      ),
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
    // The thread comes from the participant index itself, never a table row per match.
    for (const detail of lookups) expect(detail).toMatch(/USING COVERING INDEX/)
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
