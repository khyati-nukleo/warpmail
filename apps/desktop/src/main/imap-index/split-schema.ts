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

function parseAddresses(text: string): { email: string }[] {
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
  from_addr: string
  to_addr: string
  cc_addr: string
  unsubscribe: string | null
  list_id: string | null
  precedence: string | null
  auto_submitted: string | null
}

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
  db.exec(`CREATE TABLE IF NOT EXISTS participants (
      account_id TEXT NOT NULL,
      message_seq INTEGER NOT NULL REFERENCES messages (seq) ON DELETE CASCADE,
      address TEXT NOT NULL,
      domain TEXT NOT NULL,
      role TEXT NOT NULL
    );
    DELETE FROM participants;
    CREATE INDEX IF NOT EXISTS participants_message ON participants (message_seq);`)
  const insert = db.prepare(
    'INSERT INTO participants (account_id, message_seq, address, domain, role) VALUES (?, ?, ?, ?, ?)',
  )
  const update = db.prepare('UPDATE messages SET from_email = ?, automated = ? WHERE seq = ?')
  const page = db.prepare(
    `SELECT seq, account_id, from_addr, to_addr, cc_addr, unsubscribe, list_id, precedence,
        auto_submitted
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
        insert.run(row.account_id, row.seq, p.address, p.domain, p.role)
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
  db.exec(`CREATE INDEX IF NOT EXISTS participants_address ON participants (account_id, address);
    CREATE INDEX IF NOT EXISTS participants_domain ON participants (account_id, domain);
    CREATE INDEX IF NOT EXISTS messages_mailbox_sender
      ON messages (account_id, mailbox_id, from_email);`)
}
