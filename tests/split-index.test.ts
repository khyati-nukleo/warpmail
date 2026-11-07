import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { domainKey, type SplitScope } from '@inlark/core'
import {
  openInProcessIndex,
  SCHEMA_VERSION,
  SqliteMetadataIndex,
  UNCHECKED_HEADERS_SQL,
} from '../apps/desktop/src/main/imap-index/sqlite-index'
import { WorkerMetadataIndex, type IndexPort } from '../apps/desktop/src/main/imap-index/client'
import { registerSplitFunctions } from '../apps/desktop/src/main/imap-index/split-schema'
import {
  addressesSeenQuery,
  splitFilter,
  tabCountQuery,
} from '../apps/desktop/src/main/imap-index/split-sql'
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

// Thread participants that differ from a count of the message participants: none when in step.
const THREAD_PARTICIPANTS_OUT_OF_STEP = `SELECT count(*) AS n FROM (
    SELECT account_id, thread_id, address, count(*) AS n FROM participants GROUP BY 1, 2, 3
  ) a FULL JOIN thread_participants t USING (account_id, thread_id, address)
  WHERE a.n IS NOT t.n OR t.domain IS NULL`

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

    expect(read('PRAGMA user_version')).toEqual([{ user_version: 6 }])
    expect(SCHEMA_VERSION).toBe(6)
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
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
          AND tbl_name IN ('participants', 'thread_participants') ORDER BY name`,
      ).map((r) => r.name),
    ).toEqual(['participants_message', 'thread_participants_address', 'thread_participants_domain'])
    expect(
      read<{ name: string }>('PRAGMA index_info(thread_participants_address)').map((r) => r.name),
    ).toEqual(['account_id', 'address', 'thread_id'])
    expect(
      read<{ name: string }>('PRAGMA index_info(thread_participants_domain)').map((r) => r.name),
    ).toEqual(['account_id', 'domain', 'thread_id'])
    expect(read(THREAD_PARTICIPANTS_OUT_OF_STEP)).toEqual([{ n: 0 }])
    expect(read('SELECT count(*) AS n FROM thread_participants')).toEqual([{ n: 10 }])
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
    db.exec(`DROP TABLE thread_participants; DROP TABLE participants;
      CREATE TABLE participants (account_id TEXT NOT NULL, message_seq INTEGER NOT NULL,
        address TEXT NOT NULL, domain TEXT NOT NULL, role TEXT NOT NULL);
      DROP TABLE reminder_checks; PRAGMA user_version = 4`)
    db.close()
    const migrating: string[] = []
    new SqliteMetadataIndex(path, { onMigrate: () => migrating.push('v4') }).close()
    expect(migrating).toEqual(['v4'])
    expect(read('SELECT count(*) AS n FROM participants WHERE thread_id IS NOT NULL')).toEqual([
      { n: 2 },
    ])
    expect(read('SELECT count(*) AS n FROM thread_participants')).toEqual([{ n: 2 }])
    // Then v5.
    expect(read("SELECT name FROM sqlite_master WHERE name = 'reminder_checks'")).toHaveLength(1)
    expect(read('PRAGMA user_version')).toEqual([{ user_version: 6 }])
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

  it('keeps thread participants in step with every message change', async () => {
    const [box, archive, gone] = (
      await index.syncMailboxes('a', [folder('INBOX'), folder('Archive'), folder('Gone')])
    ).map((b) => b.id)
    const inStep = () => expect(read(THREAD_PARTICIPANTS_OUT_OF_STEP)).toEqual([{ n: 0 }])
    const ids = await index.upsertMessages('a', [
      message(box!, 1, { to: [{ name: '', email: 'ada@example.com' }] }),
      message(box!, 2, { references: ['m1@example.com'] }),
      message(archive!, 3, { from: [{ name: '', email: 'bo@other.example' }] }),
      message(gone!, 4, { references: ['m3@example.com'] }),
      message(box!, 5, { from: [{ name: '', email: 'cy@third.example' }] }),
    ])
    inStep()
    // Ada's thread and Bo's merge.
    await index.upsertMessages('a', [
      message(box!, 6, { references: ['m2@example.com', 'm3@example.com'] }),
    ])
    inStep()
    // One thread now, so one entry for Ada.
    expect(
      read("SELECT count(*) AS n FROM thread_participants WHERE address = 'ada@example.com'"),
    ).toEqual([{ n: 1 }])
    await index.removeUids('a', box!, [2])
    inStep()
    await index.removeMessages('a', [ids[4]!])
    inStep()
    await index.relocate('a', ids[0]!, { mailboxId: archive!, uidValidity: '1', uid: 9 })
    inStep()
    // A folder that disappears takes its messages with it.
    await index.syncMailboxes('a', [folder('INBOX'), folder('Archive')])
    inStep()
    await index.resetMailbox('a', archive!, '2')
    inStep()
    expect(read('SELECT count(*) AS n FROM thread_participants')).toEqual([
      read<{ n: number }>(
        'SELECT count(*) AS n FROM (SELECT DISTINCT thread_id, address FROM participants)',
      )[0],
    ])
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
        ...from('partner@elsewhere.example'),
        references: ['m30@example.com'],
      }),
      message(Archive!, 40, from('partner@elsewhere.example')),
      message(INBOX!, 50, from('x@notclient.example')),
      // Its domain key sorts inside the range of `example.client`.
      message(INBOX!, 60, from('x@client-eu.example')),
    ])
    const page = await all(
      {
        kind: 'rules',
        addresses: ['partner@elsewhere.example'],
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

describe('addresses seen for rule suggestions', () => {
  const now = Date.UTC(2026, 10, 6)
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString()
  const since = now - 30 * 86_400_000
  const person = (email: string, name = '') => [{ name, email }]

  it('counts From and To addresses of recent mail in the given folders', async () => {
    const listed = await index.syncMailboxes('a', [folder('INBOX'), folder('Sent'), folder('Junk')])
    const [INBOX, Sent, Junk] = listed.map((b) => b.id) as [string, string, string]
    await index.upsertMessages('a', [
      message(INBOX, 1, { from: person('lee@client.example', 'Lee Park'), receivedAt: ago(1) }),
      message(INBOX, 2, {
        from: person('LEE@client.example'),
        cc: person('cc@client.example'),
        receivedAt: ago(2),
      }),
      message(Sent, 3, {
        from: person('me@work.example'),
        to: person('sam@client.example', 'Sam'),
        receivedAt: ago(3),
      }),
      // Too old, in a folder not asked for, or not matching the term.
      message(INBOX, 4, { from: person('old@client.example'), receivedAt: ago(31) }),
      message(Junk, 5, { from: person('spam@client.example'), receivedAt: ago(1) }),
      message(INBOX, 6, { from: person('kim@other.example', 'Kim'), receivedAt: ago(1) }),
      // A Gmail copy of message 1 counts once.
      message(Sent, 7, {
        from: person('lee@client.example', 'Lee Park'),
        receivedAt: ago(1),
        emailId: 'g1',
      }),
      message(INBOX, 8, {
        from: person('lee@client.example', 'Lee Park'),
        receivedAt: ago(1),
        emailId: 'g1',
      }),
    ])
    const seen = await index.addressesSeen('a', [INBOX, Sent], since, 'client')
    expect(seen.sort((a, b) => a.email.localeCompare(b.email))).toEqual([
      { email: 'lee@client.example', name: 'Lee Park', count: 3 },
      { email: 'sam@client.example', name: 'Sam', count: 1 },
    ])
    // A name matches too, and an empty term lists every address.
    expect((await index.addressesSeen('a', [INBOX], since, 'kim')).map((a) => a.email)).toEqual([
      'kim@other.example',
    ])
    expect((await index.addressesSeen('a', [INBOX, Sent], since, '')).length).toBe(5)
    expect(await index.addressesSeen('a', [], since, '')).toEqual([])
  })

  it('reads recent mail through the received index', async () => {
    await index.syncMailboxes('a', [folder('INBOX')])
    const db = new DatabaseSync(path)
    registerSplitFunctions(db)
    try {
      const query = addressesSeenQuery('a', ['box1', 'box2'], since, 'cli')!
      const plan = db.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params) as {
        detail: string
      }[]
      expect(plan.map((row) => row.detail).join('\n')).toMatch(
        /SEARCH m USING INDEX messages_mailbox_received \(account_id=\? AND mailbox_id=\? AND received_ms>\?\)/,
      )
    } finally {
      db.close()
    }
  })
})

describe('updating the index after an upgrade', () => {
  function port() {
    const listeners: Record<string, ((value: any) => void)[]> = {}
    const value: IndexPort & { emit: (event: string, value: unknown) => void } = {
      on(event: string, listener: (value: any) => void) {
        ;(listeners[event] ??= []).push(listener)
        return value
      },
      emit: (event, v) => listeners[event]?.forEach((l) => l(v)),
      postMessage() {},
      async terminate() {
        return 0
      },
    }
    return value
  }

  it('says so only when the update takes a while, and when it ends', async () => {
    const calls: boolean[] = []
    const slow = port()
    new WorkerMetadataIndex(slow, { onUpdating: (on) => calls.push(on), noticeAfterMs: 10 })
    slow.emit('message', { updating: true })
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toEqual([true])
    slow.emit('message', { updating: false, ms: 1234 })
    expect(calls).toEqual([true, false])

    const quick = port()
    new WorkerMetadataIndex(quick, { onUpdating: (on) => calls.push(on), noticeAfterMs: 10 })
    quick.emit('message', { updating: true })
    quick.emit('message', { updating: false, ms: 3 })
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toEqual([true, false])

    // A worker that dies mid-update ends the notice too.
    const failing = port()
    new WorkerMetadataIndex(failing, { onUpdating: (on) => calls.push(on), noticeAfterMs: 0 })
    failing.emit('message', { updating: true })
    await new Promise((r) => setTimeout(r, 5))
    failing.emit('exit', 1)
    expect(calls).toEqual([true, false, true, false])
  })

  it('reports a schema update from the real worker', async () => {
    await inbox()
    await index.close()
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version = 3')
    db.close()
    const entry = fileURLToPath(
      new URL('../apps/desktop/src/main/imap-index/worker.ts', import.meta.url),
    )
    const shim = `
      const { registerHooks } = require('node:module')
      registerHooks({ resolve(specifier, context, next) {
        if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) specifier += '.ts'
        return next(specifier, context)
      } })
      import(${JSON.stringify(pathToFileURL(entry).href)})`
    const calls: boolean[] = []
    index = new WorkerMetadataIndex(new Worker(shim, { eval: true, workerData: { path } }), {
      onUpdating: (on) => calls.push(on),
      noticeAfterMs: 0,
    })
    expect(await index.listMailboxes('a')).toHaveLength(1)
    await vi.waitFor(() => expect(calls).toEqual([true, false]))
  })
})
