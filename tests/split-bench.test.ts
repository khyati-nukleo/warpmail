import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { domainKey, type SplitScope } from '@inlark/core'
import { SqliteMetadataIndex } from '../apps/desktop/src/main/imap-index/sqlite-index'
import type { FolderListing, NewMessage } from '@inlark/imap'

// Run with INLARK_BENCH=1. Prints timings only: never addresses or subjects.
const RUNS = 20
// Long synchronous stretches starve vitest's worker RPC, so the slow loops yield between steps.
const tick = () => new Promise((resolve) => setImmediate(resolve))
const MESSAGES = 100_000
const MIGRATION_RUNS = 6

const folder = (path: string): FolderListing => ({
  path,
  name: path,
  delimiter: '/',
  parentPath: null,
  specialUse: null,
  guessedSpecialUse: null,
  noSelect: false,
})

const sender = (n: number) => `person${n % 2000}@d${n % 200}.example`

function message(mailboxId: string, uid: number): NewMessage {
  const automated = uid % 5 === 1
  return {
    mailboxId,
    uidValidity: '1',
    uid,
    emailId: 'e' + uid,
    messageId: 'm' + uid + '@example.com',
    inReplyTo: [],
    // Threads of five messages, spread across the mailboxes.
    references: uid % 5 ? ['m' + (uid - (uid % 5)) + '@example.com'] : [],
    subject: 'A subject line of ordinary length, number ' + uid,
    from: [{ name: 'Someone ' + (uid % 2000), email: sender(uid) }],
    to: [
      { name: 'Me', email: 'me@example.com' },
      { name: 'Other', email: sender(uid * 7 + 3) },
    ],
    cc: uid % 4 ? [] : [{ name: 'Cc', email: sender(uid * 13 + 1) }],
    bcc: [],
    replyTo: [],
    receivedAt: new Date(Date.UTC(2020, 0, 1) + uid * 600_000).toISOString(),
    size: 4000 + (uid % 5000),
    flags: uid % 9 ? ['\\Seen'] : [],
    hasAttachment: uid % 11 === 0,
    preview: 'Preview text '.repeat(16),
    bodyStructure: {
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: 'quoted-printable', size: 2000 },
        { part: '2', type: 'text/html', encoding: 'quoted-printable', size: 9000 },
      ],
    },
    ...(automated ? { unsubscribe: { url: 'https://list.example/u/' + uid, oneClick: true } } : {}),
  }
}

function median(fn: () => unknown) {
  fn()
  const times: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now()
    fn()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return Math.round(((times[RUNS / 2 - 1]! + times[RUNS / 2]!) / 2) * 100) / 100
}

/** A v3 copy of an index file: what the v4 migration starts from. */
function v3Copy(directory: string, name: string) {
  const v3 = join(directory, 'v3-' + name)
  copyFileSync(join(directory, name), v3)
  const db = new DatabaseSync(v3)
  db.exec(`DROP TABLE participants; DROP INDEX messages_mailbox_person;
    DROP INDEX messages_unchecked_headers;
    ALTER TABLE messages DROP COLUMN from_email;
    ALTER TABLE messages DROP COLUMN list_id;
    ALTER TABLE messages DROP COLUMN precedence;
    ALTER TABLE messages DROP COLUMN auto_submitted;
    ALTER TABLE messages DROP COLUMN headers_checked;
    ALTER TABLE messages DROP COLUMN automated;
    PRAGMA user_version = 3;
    VACUUM`)
  db.close()
  return v3
}

/** The v3 to v4 migration, timed on fresh copies of a v3 copy of `name` (closed meanwhile). */
async function migrationMedian(directory: string, name: string) {
  const v3 = v3Copy(directory, name)
  const times: number[] = []
  for (let n = 0; n < MIGRATION_RUNS; n++) {
    await tick()
    const copy = join(directory, `migrate-${n}.sqlite`)
    copyFileSync(v3, copy)
    const start = performance.now()
    new SqliteMetadataIndex(copy).close()
    times.push(performance.now() - start)
    for (const suffix of ['', '-wal', '-shm']) rmSync(copy + suffix, { force: true })
  }
  times.sort((a, b) => a - b)
  return Math.round((times[MIGRATION_RUNS / 2 - 1]! + times[MIGRATION_RUNS / 2]!) / 2)
}

describe.skipIf(!process.env.INLARK_BENCH)('split inbox bench', () => {
  let directory: string
  let index: SqliteMetadataIndex
  let inbox: string

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'inlark-bench-'))
    index = new SqliteMetadataIndex(join(directory, 'bench.sqlite'))
    const [i, archive, sent] = index.syncMailboxes('a', [
      folder('INBOX'),
      folder('Archive'),
      folder('Sent'),
    ])
    inbox = i!.id
    for (let start = 0; start < MESSAGES; start += 1000) {
      const batch: NewMessage[] = []
      for (let uid = start + 1; uid <= start + 1000; uid++)
        batch.push(message(uid % 5 < 2 ? inbox : uid % 5 < 4 ? archive!.id : sent!.id, uid))
      index.upsertMessages('a', batch)
      await tick()
    }
  }, 600_000)
  afterAll(async () => {
    index?.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('times tab pages, counts and the v4 migration', async () => {
    const tabs: Record<string, SplitScope> = {}
    for (let n = 0; n < 7; n++)
      tabs['tab' + n] = {
        kind: 'rules',
        addresses: [sender(n * 3), sender(n * 3 + 1)],
        domains: [domainKey(`d${100 + n}.example`)],
      }
    const rules = tabs.tab0!
    const important: SplitScope = {
      kind: 'important',
      always: [{ address: sender(1), words: ['subject'] }],
      never: [sender(2)],
    }
    const page = (split?: SplitScope, after?: { receivedAt: string; threadId: string }) =>
      index.conversations('a', { mailboxIds: [inbox], split }, { limit: 50, after })
    const deep = (split?: SplitScope) => {
      const at = index.conversations(
        'a',
        { mailboxIds: [inbox], split },
        { limit: 1, offset: 5000 },
      )
      const last = at.items[0]!
      return { receivedAt: last.latest.receivedAt, threadId: last.threadId }
    }
    expect(page().total).toBeGreaterThan(5000)
    const inboxDeep = deep()
    const importantDeep = deep(important)
    const results: Record<string, number> = {
      inboxPage: median(() => page()),
      rulesPage: median(() => page(rules)),
      importantPage: median(() => page(important)),
      inboxDeepKeyset: median(() => page(undefined, inboxDeep)),
      importantDeepKeyset: median(() => page(important, importantDeep)),
      tabCounts: median(() => index.tabCounts('a', inbox, { ...tabs, important })),
    }
    const counts = index.tabCounts('a', inbox, { ...tabs, important })
    expect(counts.tab0!.conversations).toBe(page(rules).total)
    expect(counts.important!.conversations).toBe(page(important).total)
    index.close()
    results.migrationV3toV4 = await migrationMedian(directory, 'bench.sqlite')
    index = new SqliteMetadataIndex(join(directory, 'bench.sqlite'))
    console.log(`split bench (median ms over ${RUNS} runs):`, JSON.stringify(results))
  }, 600_000)
})

// 40% of the mail from one notification sender, and every inbox email also in All Mail under
// the same server identity, as Gmail stores it.
const HEAVY = 'notifications@alerts.heavy.example'

function heavyMessage(mailboxId: string, uid: number): NewMessage {
  const base = message(mailboxId, uid)
  // Whole threads (of five) from the sender, two in five of them.
  if (Math.floor(uid / 5) % 5 >= 2) return base
  return {
    ...base,
    from: [{ name: 'Alerts', email: HEAVY }],
    unsubscribe: { url: 'https://list.example/u/' + uid, oneClick: true },
  }
}

describe.skipIf(!process.env.INLARK_BENCH)('split inbox bench: a heavy sender', () => {
  let directory: string
  let index: SqliteMetadataIndex
  let inbox: string

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'inlark-bench-'))
    index = new SqliteMetadataIndex(join(directory, 'heavy.sqlite'))
    const [i, archive, all] = index.syncMailboxes('a', [
      folder('INBOX'),
      folder('Archive'),
      folder('All Mail'),
    ])
    inbox = i!.id
    for (let start = 0; start < MESSAGES; start += 1000) {
      const batch: NewMessage[] = []
      for (let uid = start + 1; uid <= start + 1000; uid++) {
        const inInbox = uid % 5 < 2
        batch.push(heavyMessage(inInbox ? inbox : archive!.id, uid))
        if (inInbox) batch.push({ ...heavyMessage(all!.id, uid), uid: MESSAGES + uid })
      }
      index.upsertMessages('a', batch)
      await tick()
    }
  }, 600_000)
  afterAll(async () => {
    index?.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps heavy sender tabs and counts near the inbox', async () => {
    const address: SplitScope = { kind: 'rules', addresses: [HEAVY], domains: [] }
    const domain: SplitScope = {
      kind: 'rules',
      addresses: [],
      domains: [domainKey('heavy.example')],
    }
    const important: SplitScope = {
      kind: 'important',
      always: [{ address: sender(1), words: ['subject'] }],
      never: [sender(2)],
    }
    const tabs: Record<string, SplitScope> = {
      address,
      domain,
      subdomain: { kind: 'rules', addresses: [], domains: [domainKey('alerts.heavy.example')] },
      mixed: { kind: 'rules', addresses: [HEAVY, sender(5)], domains: [domainKey('d7.example')] },
      important,
    }
    const page = (split?: SplitScope) =>
      index.conversations('a', { mailboxIds: [inbox], split }, { limit: 50 })
    expect(page(address).total).toBeGreaterThan(1000)
    const counts = index.tabCounts('a', inbox, tabs)
    expect(counts.address!.conversations).toBe(page(address).total)
    expect(counts.domain!.conversations).toBe(page(domain).total)
    const results: Record<string, number> = {
      inboxPage: median(() => page()),
      addressTabPage: median(() => page(address)),
      domainTabPage: median(() => page(domain)),
      importantPage: median(() => page(important)),
      tabCounts: median(() => index.tabCounts('a', inbox, tabs)),
    }
    index.close()
    results.migrationV3toV4 = await migrationMedian(directory, 'heavy.sqlite')
    index = new SqliteMetadataIndex(join(directory, 'heavy.sqlite'))
    console.log(`heavy sender bench (median ms over ${RUNS} runs):`, JSON.stringify(results))
  }, 600_000)
})
