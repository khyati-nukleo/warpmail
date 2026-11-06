import { resolveSplitScope, type Account, type Settings, type SplitScope } from '@inlark/core'

/** Every address the user receives mail as, so rules never match their own mail. */
export function ownAddresses(accounts: Account[]): string[] {
  return [
    ...new Set(
      accounts
        .flatMap((a) => [a.email, ...(a.aliases ?? []).map((x) => x.email)])
        .map((e) => e.trim().toLowerCase()),
    ),
  ]
}

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
  if (!query.tab || query.view !== 'inbox' || query.mailboxId || query.text) return undefined
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
