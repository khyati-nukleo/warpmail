import type { DatabaseSync } from 'node:sqlite'

/**
 * Stored ask-checks of messages, keyed by Message-ID so Gmail's copies and another device's
 * copy share one answer. Rows stay when their messages go: they are small and a Message-ID is
 * stable. Written to run again over a file that already has v5, like v4.
 */
export function migrateToV5(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS reminder_checks (
    account_id TEXT NOT NULL, message_id TEXT NOT NULL, asks INTEGER NOT NULL,
    PRIMARY KEY (account_id, message_id)) WITHOUT ROWID;`)
  const columns = (
    db.prepare("PRAGMA index_info('messages_mailbox_received')").all() as { name: string }[]
  ).map((c) => c.name)
  if (columns.includes('thread_id')) return
  // With the thread, reminders find recent threads without a row read per message (18 to 4 ms
  // on a Gmail account of 28 folders); same leading columns, so its other uses still fit.
  db.exec(`DROP INDEX IF EXISTS messages_mailbox_received;
    CREATE INDEX messages_mailbox_received
      ON messages (account_id, mailbox_id, received_ms, thread_id);`)
}
