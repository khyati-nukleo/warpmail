import type { Account, Settings, SplitTab } from '@inlark/core'

export interface TabEntry {
  id: string
  name: string
  /** False for the built-in Inbox and Important tabs. */
  user: boolean
}

export function tabEntries(settings: Settings): TabEntry[] {
  return [
    { id: 'inbox', name: 'Inbox', user: false },
    { id: 'important', name: 'Important', user: false },
    ...(settings.splitTabs ?? []).map(({ id, name }) => ({ id, name, user: true })),
  ]
}

/** The route's tab if it still exists, otherwise Inbox. */
export const activeTabId = (routeTab: string | undefined, entries: TabEntry[]) =>
  routeTab && entries.some((entry) => entry.id === routeTab) ? routeTab : 'inbox'

/** The tab behind Mod+1…9, or nothing past the last tab. */
export const tabForShortcut = (n: number, entries: TabEntry[]): string | undefined =>
  entries[n - 1]?.id

export function adjacentTab(current: string, entries: TabEntry[], step: 1 | -1): string {
  const index = entries.findIndex((entry) => entry.id === current)
  const from = index < 0 ? 0 : index
  return entries[(from + step + entries.length) % entries.length].id
}

/** Moves a user tab to `toIndex` among the user tabs (clamped), without changing the input. */
export function moveTab(tabs: SplitTab[], id: string, toIndex: number): SplitTab[] {
  const from = tabs.findIndex((tab) => tab.id === id)
  if (from < 0) return tabs
  const next = tabs.filter((tab) => tab.id !== id)
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, tabs[from])
  return next
}

/** Where focus goes in the tab row for a key, or nothing for keys the row doesn't handle. */
export function rovingTarget(index: number, count: number, key: string): number | undefined {
  if (key === 'ArrowRight') return (index + 1) % count
  if (key === 'ArrowLeft') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
}

/**
 * The `moveTab` index for a user tab dropped before or `after` the user tab at `overIndex`,
 * or nothing when it would stay where it is.
 */
export function dropIndex(
  fromIndex: number,
  overIndex: number,
  after: boolean,
): number | undefined {
  const before = after ? overIndex + 1 : overIndex
  const to = before > fromIndex ? before - 1 : before
  return to === fromIndex ? undefined : to
}

/** Accounts in scope whose mail tabs don't cover yet: JMAP, including records saved before IMAP. */
export function untabbedAccounts(accounts: Account[], accountId?: string): Account[] {
  const scope = accounts.some((a) => a.id === accountId)
    ? accounts.filter((a) => a.id === accountId)
    : accounts
  return scope.filter((a) => (a.protocol ?? 'jmap') === 'jmap')
}

export interface TabEmptyCopy {
  id: string
  title: string
  description: string
  /** Names the accounts tabs leave out, so their mail isn't thought lost. */
  note?: string
}

export function tabEmptyCopy(entry: TabEntry, untabbed: string[]): TabEmptyCopy {
  const copy: TabEmptyCopy = {
    id: entry.id,
    title: 'Nothing in ' + entry.name,
    description:
      entry.id === 'important'
        ? 'Mail from people in your inbox shows here.'
        : 'Conversations in your inbox from this tab’s people show here.',
  }
  if (untabbed.length)
    copy.note =
      untabbed.join(' and ') +
      (untabbed.length > 1
        ? ' aren’t included in tabs yet. Their mail is in Inbox.'
        : ' isn’t included in tabs yet. Its mail is in Inbox.')
  return copy
}
