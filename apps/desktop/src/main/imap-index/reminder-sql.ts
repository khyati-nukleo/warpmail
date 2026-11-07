import type { SQLInputValue } from 'node:sqlite'
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
 * `recent` reads `messages_mailbox_received` once per mailbox; `latest` then reads those
 * threads' entries in `messages_mailbox_person`, which holds the person test (an always sender
 * with subject words also reads that message's row). With a single max() aggregate, SQLite
 * takes the bare `seq` from the row holding the max, as in `conversationSource`. Gmail's copies
 * of one email share a thread, so they make one fact.
 *
 * Gmail also lists drafts in All Mail, so an email with a copy in Drafts is unsent and never
 * the fact. Drafts are few: the list is read once from the index and probed per row.
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
          SELECT coalesce(ta.thread_id, j.value), 1 FROM json_each(?) j
            LEFT JOIN thread_aliases ta ON ta.account_id = ? AND ta.alias = j.value)
        GROUP BY t
      ), latest AS MATERIALIZED (
        SELECT g.t, g.listed, max(m.received_ms) AS ms, m.seq AS s FROM recent g
          CROSS JOIN json_each(?) b
          CROSS JOIN messages m ON m.account_id = ? AND m.mailbox_id = b.value
            AND m.thread_id = g.t
        WHERE ${test.sql} AND (m.email_id IS NULL OR m.email_id NOT IN (
          SELECT d.email_id FROM messages d
          WHERE d.account_id = ? AND d.mailbox_id = ? AND d.email_id IS NOT NULL))
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
      query.draftsId ?? null,
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

/** Each boosted thread once, at its latest time; `null` when none is usable. */
export function boostTimes(boost: { threadId: string; sortMs: number }[] | undefined) {
  const times = new Map<string, number>()
  for (const { threadId, sortMs } of boost ?? [])
    if (Number.isFinite(sortMs))
      times.set(threadId, Math.max(sortMs, times.get(threadId) ?? sortMs))
  return times.size ? times : null
}

/**
 * The `conversations` page with due reminders on top: boosted threads sort by their time `k`
 * instead of their latest message `r`, never below it (a reminder only raises a thread). `g` is the plain grouped set, so filters, tabs and totals
 * are unchanged; `x` is the same set read for the boosted threads alone (`boosted`, through the
 * thread index), so a boost never adds a thread. Giving every thread of `g` a `k` costs each of
 * them a lookup (at 100k messages, five times the plain page with a LEFT JOIN, a fifth more with
 * `IN`); instead the plain top rows by `r`, padded by the boosted count and then rid of boosted
 * threads, merge with `x`.
 * Each page entry is `[thread, seq, k]`, with `k` null where it equals `r`; the keyset cursor is
 * the last row's `k` and thread.
 */
export function boostedConversationPage(
  source: { sql: string; params: SQLInputValue[] },
  boosted: { sql: string; params: SQLInputValue[] },
  boost: Map<string, number>,
  page: { limit: number; offset: number; after?: { k: number; threadId: string } },
) {
  const params: SQLInputValue[] = [...source.params, list([...boost]), ...boosted.params]
  let keysetK = '',
    keysetR = ''
  if (page.after) {
    const { k, threadId } = page.after
    keysetK = 'WHERE k < ? OR (k = ? AND t > ?)'
    keysetR = 'WHERE r < ? OR (r = ? AND t > ?)'
    params.push(k, k, threadId, k, k, threadId)
  }
  params.push(page.limit + page.offset, page.limit, page.offset)
  return {
    sql: `WITH g AS MATERIALIZED (${source.sql}),
        b AS MATERIALIZED (SELECT value ->> 0 AS t, value ->> 1 AS k FROM json_each(?)),
        x AS MATERIALIZED (SELECT q.t, q.r, q.s, max(b.k, q.r) AS k FROM (${boosted.sql}) q
          JOIN b ON b.t = q.t),
        h AS (SELECT t, r, s, k FROM x ${keysetK}
          UNION ALL
          SELECT t, r, s, r FROM (
            SELECT t, r, s FROM g ${keysetR} ORDER BY r DESC, t LIMIT ? + (SELECT count(*) FROM x))
          WHERE t NOT IN (SELECT t FROM x))
        SELECT (SELECT count(*) FROM g) AS total,
          (SELECT json_group_array(json_array(t, s, nullif(k, r)) ORDER BY k DESC, t) FROM (
            SELECT t, r, s, k FROM h ORDER BY k DESC, t LIMIT ? OFFSET ?)) AS page`,
    params,
  }
}
