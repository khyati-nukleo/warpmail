import type { SQLInputValue } from 'node:sqlite'
import type { SplitScope } from '@inlark/core'
import type { ConversationFilter } from '@inlark/imap'

export interface SqlFragment {
  sql: string
  params: SQLInputValue[]
}

type Important = Extract<SplitScope, { kind: 'important' }>

const list = (values: readonly unknown[]) => JSON.stringify(values)

/**
 * The tab as conditions on the inbox messages `m` of a query grouped by `m.thread_id`, or
 * `null` when the scope cannot match anything. Rules look at every participant of every message
 * of the thread, in any mailbox; Important looks only at the thread's inbox messages.
 */
export function splitFilter(
  scope: SplitScope,
  accountId: string,
  inboxId: string,
  filter: ConversationFilter,
): { where?: SqlFragment; having?: SqlFragment } | null {
  if (scope.kind === 'rules') {
    const threads = ruleThreads(scope, accountId)
    return threads && { where: { sql: `m.thread_id IN (${threads.sql})`, params: threads.params } }
  }
  // Without other row filters every inbox row of the thread is in the group, so Important is
  // decided there: one pass over `messages_mailbox_person`, never the table. 27 ms against 157 ms
  // for an IN subquery and 135 ms for a correlated EXISTS before that index (100k messages, 40k
  // in the inbox, Inbox page 17 ms). `sum`, not `max`, so the bare `m.seq` still comes from
  // the row with the latest date.
  if (
    !filter.ids &&
    !filter.excludeMailboxIds?.length &&
    filter.flagged === undefined &&
    filter.unseen === undefined &&
    filter.hasAttachment === undefined &&
    filter.after === undefined &&
    filter.before === undefined
  )
    return { having: wrap('sum(', person(scope, 'm'), ') > 0') }
  // Other filters drop rows from the group, so the thread's whole inbox is checked instead.
  return {
    where: wrap(
      `EXISTS (SELECT 1 FROM messages t
        WHERE t.account_id = ? AND t.mailbox_id = ? AND t.thread_id = m.thread_id AND `,
      person(scope, 't'),
      ')',
      [accountId, inboxId],
    ),
  }
}

/** Threads with a participant matching the rules, or `null` without rules. */
function ruleThreads(
  scope: Extract<SplitScope, { kind: 'rules' }>,
  accountId: string,
): SqlFragment | null {
  const terms: string[] = []
  const params: SQLInputValue[] = []
  if (scope.addresses.length) {
    terms.push('p.address IN (SELECT value FROM json_each(?))')
    params.push(accountId, list(scope.addresses))
  }
  // Domain keys are label-reversed, so a domain and its subdomains are the one key range
  // [key, key + '/'); the last test drops siblings such as `key-eu` that sort inside it.
  for (const domain of scope.domains) {
    terms.push('p.domain >= ? AND p.domain < ? AND (p.domain = ? OR substr(p.domain, ?, 1) = ?)')
    params.push(accountId, domain, domain + '/', domain, domain.length + 1, '.')
  }
  if (!terms.length) return null
  // One SELECT per rule, not one OR: without index statistics SQLite reads `p.account_id = ?`
  // as selective and walks every participant of the account (about 7x slower than the inbox
  // page at 100k messages). Each SELECT here is a lookup on its own address or domain range.
  // A correlated EXISTS per inbox row measured slower still.
  const select = (term: string) => `SELECT t.thread_id FROM participants p
      JOIN messages t ON t.seq = p.message_seq WHERE p.account_id = ? AND ${term}`
  return { sql: terms.map(select).join(' UNION ALL '), params }
}

/**
 * 1 when inbox message `alias` is from a person under the scope: not automated or on the always
 * list (with one of its words in the subject when given), and not on the never list. A message
 * without a From is a person unless its headers say otherwise. Only the subject is outside
 * `messages_mailbox_person`, so it is read by `seq`, and only for always senders with words.
 */
function person(scope: Important, alias: string): SqlFragment {
  const params: SQLInputValue[] = []
  const terms = [`${alias}.automated = 0`]
  // An empty word would match every subject (`instr(s, '')` is 1).
  const always = scope.always.map((a) => ({ address: a.address, words: a.words.filter(Boolean) }))
  const plain = always.filter((a) => !a.words.length).map((a) => a.address)
  if (plain.length) {
    terms.push(`${alias}.from_email IN (SELECT value FROM json_each(?))`)
    params.push(list(plain))
  }
  for (const { address, words } of always) {
    if (!words.length) continue
    const found = words.map(() => 'instr(lower(x.subject), ?) > 0').join(' OR ')
    terms.push(`(${alias}.from_email = ? AND
      (SELECT ${found} FROM messages x WHERE x.seq = ${alias}.seq))`)
    params.push(address, ...words)
  }
  let sql = `(${terms.join(' OR ')})`
  if (scope.never.length) {
    sql += ` AND (${alias}.from_email IS NULL
      OR ${alias}.from_email NOT IN (SELECT value FROM json_each(?)))`
    params.push(list(scope.never))
  }
  return { sql: `(${sql})`, params }
}

function wrap(
  before: string,
  inner: SqlFragment,
  after: string,
  leading: SQLInputValue[] = [],
): SqlFragment {
  return { sql: before + inner.sql + after, params: [...leading, ...inner.params] }
}

// Unseen inbox emails, each server identity once. `seen` is in the index, so the table is read
// only for unseen rows.
const UNREAD = `count(DISTINCT CASE WHEN m.seen = 0
  THEN (SELECT coalesce(x.email_id, x.id) FROM messages x WHERE x.seq = m.seq) END)`

/**
 * One statement for every tab's counts: a `UNION ALL` of one `SELECT` per scope. Threads and
 * server identities are counted, never participant rows, so Gmail's duplicate locations count
 * once. `keys[k]` names row `k`; scopes that match nothing get no row.
 *
 * A rules tab starts from its own threads and reads only their inbox entries in
 * `messages_mailbox_person`; Important is the same single grouped pass as its page. At 100k
 * messages (40k in the inbox) 7 rules tabs and Important take about 100 ms; one CTE of the
 * inbox's rows shared by all tabs took 334 ms, because it read every inbox row from the table.
 */
export function tabCountsQuery(
  accountId: string,
  inboxId: string,
  scopes: Record<string, SplitScope>,
): (SqlFragment & { keys: string[] }) | null {
  const keys: string[] = []
  const selects: string[] = []
  const params: SQLInputValue[] = []
  const inbox = 'm.account_id = ? AND m.mailbox_id = ?'
  for (const [key, scope] of Object.entries(scopes)) {
    if (scope.kind === 'rules') {
      const threads = ruleThreads(scope, accountId)
      if (!threads) continue
      selects.push(`SELECT ${keys.length} AS k, count(DISTINCT m.thread_id) AS c, ${UNREAD} AS u
        FROM messages m WHERE ${inbox} AND m.thread_id IN (${threads.sql})`)
      params.push(accountId, inboxId, ...threads.params)
    } else {
      // An email belongs to one thread, so per-thread unread counts add up without overlap.
      const test = person(scope, 'm')
      selects.push(`SELECT ${keys.length} AS k, count(*) AS c, coalesce(sum(n), 0) AS u
        FROM (SELECT ${UNREAD} AS n FROM messages m WHERE ${inbox}
          GROUP BY m.thread_id HAVING sum(${test.sql}) > 0)`)
      params.push(accountId, inboxId, ...test.params)
    }
    keys.push(key)
  }
  if (!selects.length) return null
  return { sql: selects.join(' UNION ALL '), params, keys }
}
