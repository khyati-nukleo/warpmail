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
}
