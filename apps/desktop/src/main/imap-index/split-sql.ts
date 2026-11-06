import type { SQLInputValue } from 'node:sqlite'
import type { SplitScope } from '@inlark/core'

export interface SqlFragment {
  sql: string
  params: SQLInputValue[]
}

const list = (values: readonly unknown[]) => JSON.stringify(values)

/**
 * A condition on `threadColumn` that holds for the tab's threads, or `null` when the scope
 * cannot match anything. Rules look at every participant of every message of the thread, in any
 * mailbox; Important looks only at the thread's inbox messages.
 */
export function splitCondition(
  scope: SplitScope,
  threadColumn: string,
  accountId: string,
  inboxId: string,
): SqlFragment | null {
  if (scope.kind === 'rules') {
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
    return { sql: `${threadColumn} IN (${terms.map(select).join(' UNION ALL ')})`, params }
  }
  // Correlated EXISTS rather than `IN (every person message of the inbox)`: both read each inbox
  // row's `automated` from the table, but this probes only the thread's own inbox messages and
  // stops at the first person: about 135 ms against 157 ms for a first page in
  // tests/split-bench.test.ts (100k messages, 40k in the inbox; the plain Inbox takes 20 ms).
  const person = personTest(scope)
  return {
    sql: `EXISTS (SELECT 1 FROM messages t
      WHERE t.account_id = ? AND t.mailbox_id = ? AND t.thread_id = ${threadColumn}
        AND ${person.sql})`,
    params: [accountId, inboxId, ...person.params],
  }
}

/** Whether inbox message `t` is from a person under an Important scope. */
function personTest(scope: Extract<SplitScope, { kind: 'important' }>): SqlFragment {
  const params: SQLInputValue[] = []
  const person = ['t.automated = 0']
  // An empty word would match every subject (`instr(s, '')` is 1).
  const always = scope.always.map((a) => ({ address: a.address, words: a.words.filter(Boolean) }))
  const plain = always.filter((a) => !a.words.length).map((a) => a.address)
  if (plain.length) {
    person.push('t.from_email IN (SELECT value FROM json_each(?))')
    params.push(list(plain))
  }
  for (const { address, words } of always) {
    if (!words.length) continue
    person.push(
      `(t.from_email = ? AND (${words.map(() => 'instr(lower(t.subject), ?) > 0').join(' OR ')}))`,
    )
    params.push(address, ...words)
  }
  let sql = `(${person.join(' OR ')})`
  // A message without a From is a person unless its headers say otherwise.
  if (scope.never.length) {
    sql += ' AND (t.from_email IS NULL OR t.from_email NOT IN (SELECT value FROM json_each(?)))'
    params.push(list(scope.never))
  }
  return { sql: `(${sql})`, params }
}

/**
 * One statement for every tab's counts: a `UNION ALL` of one `SELECT` per scope over the inbox's
 * rows, read once. Threads and server identities are counted, never participant rows, so Gmail's
 * duplicate locations count once. `keys[k]` names row `k`; scopes that match nothing get no row.
 */
export function tabCountsQuery(
  accountId: string,
  inboxId: string,
  scopes: Record<string, SplitScope>,
): (SqlFragment & { keys: string[] }) | null {
  const keys: string[] = []
  const selects: string[] = []
  const params: SQLInputValue[] = [accountId, inboxId]
  for (const [key, scope] of Object.entries(scopes)) {
    let condition: SqlFragment | null
    if (scope.kind === 'important') {
      // The inbox rows are already in `i`, so Important reads them there, not from the table.
      const person = personTest(scope)
      condition = {
        sql: `i.thread_id IN (SELECT t.thread_id FROM i t WHERE ${person.sql})`,
        params: person.params,
      }
    } else condition = splitCondition(scope, 'i.thread_id', accountId, inboxId)
    if (!condition) continue
    selects.push(`SELECT ${keys.length} AS k, count(DISTINCT i.thread_id) AS c,
      count(DISTINCT CASE WHEN i.seen = 0 THEN i.e END) AS u FROM i WHERE ${condition.sql}`)
    keys.push(key)
    params.push(...condition.params)
  }
  if (!selects.length) return null
  return {
    sql: `WITH i AS MATERIALIZED (SELECT thread_id, seen, coalesce(email_id, id) AS e,
          automated, from_email, subject
        FROM messages WHERE account_id = ? AND mailbox_id = ?)
      ${selects.join(' UNION ALL ')}`,
    params,
    keys,
  }
}
