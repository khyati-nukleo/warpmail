import type { ReminderFacts } from '@inlark/core'
import type { ReminderFactsQuery } from '@inlark/imap'
import { parseAddresses } from './split-schema'
import { person, type SqlFragment } from './split-sql'

const list = (values: readonly unknown[]) => JSON.stringify(values)

/**
 * Per thread with mail in `mailboxIds` since `sinceMs` (or listed in `threadIds`), its latest
 * message from a person under Important, with what reminders need about it. `null` without
 * mailboxes. Every list is one JSON parameter, and the CROSS JOINs make each list drive its
 * lookups: without index statistics SQLite misjudges json_each sizes.
 *
 * `recent` reads `messages_mailbox_received` once per mailbox; `latest` then reads only those
 * threads' entries in `messages_mailbox_person`, which holds the person test. With a single
 * max() aggregate, SQLite takes the bare `seq` from the row holding the max, as in
 * `conversationSource`. Gmail's copies of one email share a thread, so they make one fact.
 */
export function reminderFactsQuery(
  accountId: string,
  query: ReminderFactsQuery,
): SqlFragment | null {
  const mailboxIds = list([...new Set(query.mailboxIds)])
  if (mailboxIds === '[]') return null
  const test = person(query.important, 'm')
  // A copy with the same Message-ID in the label folder; a missing folder matches nothing.
  const labelled = (alias: string) =>
    `EXISTS (SELECT 1 FROM messages ${alias} WHERE ${alias}.account_id = ?
      AND ${alias}.message_id = m.message_id AND ${alias}.mailbox_id = ?)`
  return {
    sql: `WITH recent AS MATERIALIZED (
        SELECT t, max(listed) AS listed FROM (
          SELECT r.thread_id AS t, 0 AS listed FROM json_each(?) b
            CROSS JOIN messages r ON r.account_id = ? AND r.mailbox_id = b.value
              AND r.received_ms >= ?
          UNION ALL
          SELECT coalesce(a.thread_id, j.value), 1 FROM json_each(?) j
            LEFT JOIN thread_aliases a ON a.account_id = ? AND a.alias = j.value)
        GROUP BY t
      ), latest AS MATERIALIZED (
        SELECT g.t, g.listed, max(m.received_ms) AS ms, m.seq AS s FROM recent g
          CROSS JOIN json_each(?) b
          CROSS JOIN messages m ON m.account_id = ? AND m.mailbox_id = b.value
            AND m.thread_id = g.t
        WHERE ${test.sql}
        GROUP BY g.t
      )
      SELECT l.t AS thread_id, m.message_id, m.received_at, m.from_email, m.to_addr,
        EXISTS (SELECT 1 FROM messages i
          WHERE i.account_id = ? AND i.mailbox_id = ? AND i.thread_id = l.t) AS in_inbox,
        ${labelled('n')} AS no_reminder,
        ${labelled('f')} AS follow_up,
        (SELECT c.asks FROM reminder_checks c
          WHERE c.account_id = ? AND c.message_id = m.message_id) AS asks
      FROM latest l CROSS JOIN messages m ON m.seq = l.s
      WHERE l.ms >= ? OR l.listed
      ORDER BY l.ms DESC, l.t`,
    params: [
      mailboxIds,
      accountId,
      query.sinceMs,
      list(query.threadIds ?? []),
      accountId,
      mailboxIds,
      accountId,
      ...test.params,
      accountId,
      query.inboxId,
      accountId,
      query.labelIds.noReminder ?? null,
      accountId,
      query.labelIds.followUp ?? null,
      accountId,
      query.sinceMs,
    ],
  }
}

export interface ReminderFactsRow {
  thread_id: string
  message_id: string | null
  received_at: string
  from_email: string | null
  to_addr: string
  in_inbox: number
  no_reminder: number
  follow_up: number
  asks: number | null
}

export function toReminderFacts(row: ReminderFactsRow): ReminderFacts {
  return {
    threadId: row.thread_id,
    messageId: row.message_id,
    receivedAt: row.received_at,
    fromEmail: row.from_email,
    to: parseAddresses(row.to_addr)
      .map((a) => a.email.trim().toLowerCase())
      .filter(Boolean),
    inInbox: row.in_inbox === 1,
    labels: { noReminder: row.no_reminder === 1, followUp: row.follow_up === 1 },
    asks: row.asks === null ? null : row.asks === 1,
  }
}

/** Sent mail since a date with a Message-ID and no stored ask-check, newest first. */
export const ASK_CHECKS_NEEDED_SQL = `SELECT m.id, m.message_id AS messageId FROM messages m
  WHERE m.account_id = ? AND m.mailbox_id = ? AND m.received_ms >= ? AND m.message_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM reminder_checks c
      WHERE c.account_id = m.account_id AND c.message_id = m.message_id)
  ORDER BY m.received_ms DESC LIMIT ?`

export const SET_ASK_CHECK_SQL = `INSERT INTO reminder_checks (account_id, message_id, asks)
  VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET asks = excluded.asks`
