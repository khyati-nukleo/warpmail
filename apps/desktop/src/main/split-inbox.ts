import {
  ownAddresses,
  resolveSplitScope,
  tabApplies,
  type Account,
  type Settings,
  type SplitScope,
} from '@inlark/core'

export function resolveTab(
  settings: Settings,
  accounts: Account[],
  tab?: string,
): SplitScope | null | undefined {
  return resolveSplitScope(tab, settings, ownAddresses(accounts))
}

/** What a query's `tab` means: unchanged, empty, or restricted to a scope (IMAP only). */
export function tabPlan(
  settings: Settings,
  accounts: Account[],
  query: { view: string; tab?: string; mailboxId?: string; text?: string },
): { empty: true } | { split: SplitScope } | undefined {
  if (!query.tab || !tabApplies(query)) return undefined
  const split = resolveTab(settings, accounts, query.tab)
  if (split === null) return { empty: true }
  return split && { split }
}

export function isImap(account: Account) {
  return account.protocol === 'imap'
}

/** The scopes whose unread counts the tab row shows. */
export function countScopes(settings: Settings, accounts: Account[]): Record<string, SplitScope> {
  const scopes: Record<string, SplitScope> = {}
  for (const id of ['important', ...(settings.splitTabs ?? []).map((t) => t.id)]) {
    const scope = resolveTab(settings, accounts, id)
    if (scope) scopes[id] = scope
  }
  return scopes
}

/** The scope for rules being typed, parsed and refused exactly as a saved tab's are. */
export function rulesScope(rules: string[], accounts: Account[]): SplitScope {
  return resolveSplitScope(
    'draft',
    { splitTabs: [{ id: 'draft', name: '', rules }] } as Settings,
    ownAddresses(accounts),
  ) as SplitScope
}

export type TabCounts = Record<string, { conversations: number; unread: number }>

/** Unread per scope, summed over accounts; every scope is present even when nothing answered. */
export function sumUnread(scopes: Record<string, SplitScope>, perAccount: TabCounts[]) {
  const total: Record<string, number> = Object.fromEntries(Object.keys(scopes).map((k) => [k, 0]))
  for (const counts of perAccount)
    for (const [id, c] of Object.entries(counts)) total[id] = (total[id] ?? 0) + c.unread
  return total
}

/** Conversations matching the rules being edited, summed over accounts. */
export function sumMatches(perAccount: TabCounts[]) {
  return perAccount.reduce((n, counts) => n + (counts.draft?.conversations ?? 0), 0)
}
