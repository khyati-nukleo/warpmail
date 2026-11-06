import type { SQLInputValue } from 'node:sqlite'
import type { SplitScope } from '@inlark/core'
import type { ConversationFilter } from '@inlark/imap'

export interface SqlFragment {
  sql: string
  params: SQLInputValue[]
}

type Important = Extract<SplitScope, { kind: 'important' }>

const list = (values: readonly unknown[]) => JSON.stringify(values)

// Filter keys whose absence keeps every inbox row of a thread in its group. Any other key set,
// including one added later, sends Important to the EXISTS form, which is right for any filter.
const groupSafe = new Set(['mailboxIds', 'split'])

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
  const grouped = Object.entries(filter).every(
    ([key, value]) =>
      groupSafe.has(key) ||
      value === undefined ||
      (key === 'excludeMailboxIds' && Array.isArray(value) && !value.length),
  )
  if (grouped) return { having: wrap('sum(', person(scope, 'm'), ') > 0') }
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

/**
 * Threads with a participant matching the rules, or `null` without rules. Each list is one
 * parameter, so a statement's size doesn't grow with the rules. The CROSS JOINs make each rule
 * drive a lookup on its own key: without index statistics SQLite reads `p.account_id = ?` as
 * selective and would walk every participant of the account. The thread is the last column of
 * both participant indexes, so no table row is read per match (a heavy sender's 40k messages
 * cost one table lookup each before).
 */
function ruleThreads(
  scope: Extract<SplitScope, { kind: 'rules' }>,
  accountId: string,
): SqlFragment | null {
  const selects: string[] = []
  const params: SQLInputValue[] = []
  if (scope.addresses.length) {
    selects.push(`SELECT p.thread_id FROM json_each(?) r
      CROSS JOIN participants p ON p.account_id = ? AND p.address = r.value`)
    params.push(list(scope.addresses), accountId)
  }
  // Domain keys are label-reversed, so a domain is its own key and its subdomains are the key
  // range (key + '.', key + '/'): siblings such as `key-eu` sort before it. Two index ranges,
  // with no test left to run on each matching row.
  if (scope.domains.length) {
    selects.push(
      `SELECT p.thread_id FROM json_each(?) r
        CROSS JOIN participants p ON p.account_id = ? AND p.domain = r.value`,
      `SELECT p.thread_id FROM json_each(?) r
        CROSS JOIN participants p ON p.account_id = ? AND p.domain >= r.value || '.'
          AND p.domain < r.value || '/'`,
    )
    params.push(list(scope.domains), accountId, list(scope.domains), accountId)
  }
  if (!selects.length) return null
  return { sql: selects.join(' UNION ALL '), params }
}

/**
 * 1 when inbox message `alias` is from a person under the scope: not automated or on the always
 * list (with one of its words in the subject when given), and not on the never list. A message
 * without a From is a person unless its headers say otherwise. Only the subject is outside
 * `messages_mailbox_person`, so it is read by `seq`, and only for always senders with words.
 * Every list is one JSON parameter, so the expression is the same size for 1 sender or 500.
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
  const worded = always.filter((a) => a.words.length)
  if (worded.length) {
    // The IN test keeps the subject check to these senders' mail; words are lowercased in JS,
    // and `split_lower` folds the subject beyond ASCII.
    terms.push(`(${alias}.from_email IN (SELECT value FROM json_each(?)) AND EXISTS (
      SELECT 1 FROM messages x CROSS JOIN json_each(?) a CROSS JOIN json_each(a.value, '$[1]') w
      WHERE x.seq = ${alias}.seq AND a.value ->> 0 = ${alias}.from_email
        AND instr(split_lower(x.subject), w.value) > 0))`)
    params.push(list(worded.map((a) => a.address)), list(worded.map((a) => [a.address, a.words])))
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

// Unseen inbox emails, each server identity once; a location without one counts alone (`seq`
// never equals a text identity). Both are in `messages_mailbox_person`, so no table row is read.
const UNREAD = `count(DISTINCT CASE WHEN m.seen = 0 THEN coalesce(m.email_id, m.seq) END)`

/**
 * One tab's counts as `c` (conversations) and `u` (unread emails), or `null` when the scope
 * matches nothing. Threads and server identities are counted, never participant rows, so
 * Gmail's duplicate locations count once.
 *
 * A rules tab starts from its own threads and reads only their inbox entries in
 * `messages_mailbox_person`; Important is the same single grouped pass as its page. One CTE of
 * the inbox's rows shared by all tabs took 3x longer, because it read every inbox row from the
 * table.
 */
export function tabCountQuery(
  accountId: string,
  inboxId: string,
  scope: SplitScope,
): SqlFragment | null {
  const inbox = 'm.account_id = ? AND m.mailbox_id = ?'
  if (scope.kind === 'rules') {
    const threads = ruleThreads(scope, accountId)
    if (!threads) return null
    return {
      sql: `SELECT count(DISTINCT m.thread_id) AS c, ${UNREAD} AS u
        FROM messages m WHERE ${inbox} AND m.thread_id IN (${threads.sql})`,
      params: [accountId, inboxId, ...threads.params],
    }
  }
  // An email belongs to one thread, so per-thread unread counts add up without overlap.
  const test = person(scope, 'm')
  return {
    sql: `SELECT count(*) AS c, coalesce(sum(n), 0) AS u
      FROM (SELECT ${UNREAD} AS n FROM messages m WHERE ${inbox}
        GROUP BY m.thread_id HAVING sum(${test.sql}) > 0)`,
    params: [accountId, inboxId, ...test.params],
  }
}
