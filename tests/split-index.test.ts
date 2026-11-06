import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  openInProcessIndex,
  SCHEMA_VERSION,
} from '../apps/desktop/src/main/imap-index/sqlite-index'
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
    db.exec(`DROP TABLE participants; DROP INDEX messages_mailbox_sender;
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
    db.exec(`DROP TABLE participants; DROP INDEX messages_mailbox_sender;
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
