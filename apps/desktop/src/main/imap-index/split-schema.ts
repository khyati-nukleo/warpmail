import type { DatabaseSync } from 'node:sqlite'
import { domainKey, isAutomatedMessage } from '@inlark/core'

type Role = 'from' | 'to' | 'cc'

/** Lowercased, de-duplicated addresses with a domain key; entries without a domain are skipped. */
export function participantsOf(roles: Record<Role, readonly { email: string }[]>) {
  const rows: { address: string; domain: string; role: Role }[] = []
  const seen = new Set<string>()
  for (const role of ['from', 'to', 'cc'] as const)
    for (const { email } of roles[role]) {
      const address = String(email ?? '')
        .trim()
        .toLowerCase()
      const at = address.lastIndexOf('@')
      if (at < 0 || at === address.length - 1) continue
      if (seen.has(role + ' ' + address)) continue
      seen.add(role + ' ' + address)
      rows.push({ address, domain: domainKey(address.slice(at + 1)), role })
    }
  return rows
}

export function firstEmail(from: readonly { email: string }[]) {
  const address = String(from[0]?.email ?? '')
    .trim()
    .toLowerCase()
  return address.includes('@') ? address : null
}

/** Header values as stored: a hostile or broken header can't fill the index. */
export function storedAutomation(automation: {
  listId: string | null
  precedence: string | null
  autoSubmitted: string | null
}) {
  const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max))
  return {
    listId: clip(automation.listId, 256),
    precedence: clip(automation.precedence, 64),
    autoSubmitted: clip(automation.autoSubmitted, 64),
  }
}

export const INSERT_PARTICIPANT_SQL = `INSERT INTO participants
  (account_id, message_seq, thread_id, address, domain, role) VALUES (?, ?, ?, ?, ?, ?)`

/**
 * Functions the split inbox's SQL calls. SQLite's own `lower()` only folds ASCII, so subject
 * words (lowercased in JS) would miss "ÉCHEC" for "échec".
 */
export function registerSplitFunctions(db: DatabaseSync) {
  db.function('split_lower', { deterministic: true }, (value) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
}

/** A file from a pre-release v4 build lacks thread participants; v4 runs again for it. */
export function needsV4Again(db: DatabaseSync) {
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  const participants = columns('participants')
  return (
    participants.length > 0 &&
    (!participants.includes('thread_id') || !columns('thread_participants').length)
  )
}

export function parseAddresses(text: string): { email: string }[] {
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value.filter((a) => a && typeof a.email === 'string') : []
  } catch {
    return []
  }
}

interface Row {
  seq: number
  account_id: string
  thread_id: string
  from_addr: string
  to_addr: string
  cc_addr: string
  unsubscribe: string | null
  list_id: string | null
  precedence: string | null
  auto_submitted: string | null
}

/**
 * Each address once per thread, with how many participant rows name it there, kept in step by
 * triggers on `participants` (cascaded deletes included). Tabs read threads from its indexes,
 * which end in `thread_id`: a high-volume sender's notifications are a few thousand threads
 * but tens of thousands of participant rows. Filled after the backfill, so the bulk inserts
 * don't run the triggers.
 */
const THREAD_PARTICIPANTS = `CREATE TABLE thread_participants (
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    address TEXT NOT NULL,
    domain TEXT NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (account_id, thread_id, address)
  ) WITHOUT ROWID;
  INSERT INTO thread_participants (account_id, thread_id, address, domain, n)
    SELECT account_id, thread_id, address, min(domain), count(*) FROM participants
      GROUP BY account_id, thread_id, address;
  CREATE INDEX thread_participants_address ON thread_participants (account_id, address, thread_id);
  CREATE INDEX thread_participants_domain ON thread_participants (account_id, domain, thread_id);
  CREATE TRIGGER participants_added AFTER INSERT ON participants BEGIN
    INSERT INTO thread_participants (account_id, thread_id, address, domain, n)
      VALUES (new.account_id, new.thread_id, new.address, new.domain, 1)
      ON CONFLICT DO UPDATE SET n = n + 1;
  END;
  CREATE TRIGGER participants_removed AFTER DELETE ON participants BEGIN
    UPDATE thread_participants SET n = n - 1
      WHERE account_id = old.account_id AND thread_id = old.thread_id AND address = old.address;
    DELETE FROM thread_participants
      WHERE account_id = old.account_id AND thread_id = old.thread_id AND address = old.address
        AND n <= 0;
  END;
  CREATE TRIGGER participants_moved AFTER UPDATE OF thread_id ON participants BEGIN
    UPDATE thread_participants SET n = n - 1
      WHERE account_id = old.account_id AND thread_id = old.thread_id AND address = old.address;
    DELETE FROM thread_participants
      WHERE account_id = old.account_id AND thread_id = old.thread_id AND address = old.address
        AND n <= 0;
    INSERT INTO thread_participants (account_id, thread_id, address, domain, n)
      VALUES (new.account_id, new.thread_id, new.address, new.domain, 1)
      ON CONFLICT DO UPDATE SET n = n + 1;
  END;`

/** Written to run again over a file that already has v4, like the sources migration. */
export function migrateToV4(db: DatabaseSync) {
  const have = new Set(
    (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name),
  )
  for (const [name, type] of [
    ['from_email', 'TEXT'],
    ['list_id', 'TEXT'],
    ['precedence', 'TEXT'],
    ['auto_submitted', 'TEXT'],
    ['headers_checked', 'INTEGER NOT NULL DEFAULT 0'],
    ['automated', 'INTEGER NOT NULL DEFAULT 0'],
  ])
    if (!have.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`)
  // Rebuilt whole each time: v4 owns these tables, and a run over a v4 file starts again cleanly.
  // `thread_id` follows the message's (see `assignThread`).
  db.exec(`DROP TABLE IF EXISTS thread_participants;
    DROP TABLE IF EXISTS participants;
    CREATE TABLE participants (
      account_id TEXT NOT NULL,
      message_seq INTEGER NOT NULL REFERENCES messages (seq) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      address TEXT NOT NULL,
      domain TEXT NOT NULL,
      role TEXT NOT NULL
    );`)
  const insert = db.prepare(INSERT_PARTICIPANT_SQL)
  const update = db.prepare('UPDATE messages SET from_email = ?, automated = ? WHERE seq = ?')
  const page = db.prepare(
    `SELECT seq, account_id, thread_id, from_addr, to_addr, cc_addr, unsubscribe, list_id,
        precedence, auto_submitted
      FROM messages WHERE seq > ? ORDER BY seq LIMIT 1000`,
  )
  // Paged by seq so rows are never loaded all at once or revisited after being updated.
  let after = 0
  for (;;) {
    const rows = page.all(after) as unknown as Row[]
    if (!rows.length) break
    after = rows[rows.length - 1]!.seq
    for (const row of rows) {
      const from = parseAddresses(row.from_addr)
      const fromEmail = firstEmail(from)
      for (const p of participantsOf({
        from,
        to: parseAddresses(row.to_addr),
        cc: parseAddresses(row.cc_addr),
      }))
        insert.run(row.account_id, row.seq, row.thread_id, p.address, p.domain, p.role)
      const automated = isAutomatedMessage({
        fromEmail: fromEmail ?? undefined,
        unsubscribe: row.unsubscribe,
        listId: row.list_id,
        precedence: row.precedence,
        autoSubmitted: row.auto_submitted,
      })
      update.run(fromEmail, automated ? 1 : 0, row.seq)
    }
  }
  // Built after the backfill so the bulk inserts don't maintain them row by row.
  // `messages_mailbox_person` lets Important and the tab counts read only the index: it holds
  // the thread, date and person test of every inbox row, and `seen` and `email_id` for unread
  // counts.
  db.exec(`CREATE INDEX participants_message ON participants (message_seq);
    ${THREAD_PARTICIPANTS}
    DROP INDEX IF EXISTS messages_mailbox_sender;
    DROP INDEX IF EXISTS messages_mailbox_person;
    CREATE INDEX messages_mailbox_person ON messages
      (account_id, mailbox_id, thread_id, received_ms, automated, from_email, seen, email_id);
    CREATE INDEX IF NOT EXISTS messages_unchecked_headers
      ON messages (account_id, mailbox_id, uid) WHERE headers_checked = 0;`)
}
