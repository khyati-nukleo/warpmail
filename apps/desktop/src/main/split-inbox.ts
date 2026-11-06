import { chmod, open, writeFile } from 'node:fs/promises'
import { dialog } from 'electron'
import {
  inboxExport,
  ownAddresses,
  parseInboxExport,
  resolveSplitScope,
  splitLimits,
  tabApplies,
  type Account,
  type InboxExport,
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

/**
 * The scopes whose unread counts the tab row shows: at most `splitLimits.tabs` tabs of
 * `splitLimits.rules` rules each, however the settings file was edited. Records here and in
 * `sumUnread` have no prototype, so a tab id such as `__proto__` is a key like any other.
 */
export function countScopes(settings: Settings, accounts: Account[]): Record<string, SplitScope> {
  const scopes: Record<string, SplitScope> = Object.create(null)
  const tabs = (settings.splitTabs ?? []).slice(0, splitLimits.tabs)
  for (const id of ['important', ...tabs.map((t) => t.id)]) {
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
  const total: Record<string, number> = Object.create(null)
  for (const id of Object.keys(scopes)) total[id] = 0
  for (const counts of perAccount)
    for (const [id, c] of Object.entries(counts)) total[id] = (total[id] ?? 0) + c.unread
  return total
}

/** Conversations matching the rules being edited, summed over accounts. */
export function sumMatches(perAccount: TabCounts[]) {
  return perAccount.reduce((n, counts) => n + (counts.draft?.conversations ?? 0), 0)
}

const exportMaxBytes = 1024 * 1024

/** Saves the tabs and Important lists where the user picks; false when cancelled. */
export async function exportInboxFile(settings: Settings): Promise<boolean> {
  const result = await dialog.showSaveDialog({
    title: 'Export inbox tabs',
    defaultPath: 'warpmail-inbox.json',
    filters: [{ name: 'Warpmail inbox export', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return false
  const text = JSON.stringify(inboxExport(settings), null, 2) + '\n'
  try {
    await writeFile(result.filePath, text, { mode: 0o600 })
    // The mode only applies to a new file; an overwritten one keeps its own.
    await chmod(result.filePath, 0o600)
  } catch {
    // File system errors name the path, and IPC errors are logged.
    throw new Error('The file couldn’t be saved. Choose another folder and try again.')
  }
  return true
}

/** Reads an inbox export the user picks, without applying it; undefined when cancelled. */
export async function importInboxFile(): Promise<InboxExport | undefined> {
  const result = await dialog.showOpenDialog({
    title: 'Import inbox tabs',
    properties: ['openFile'],
    filters: [{ name: 'Warpmail inbox export', extensions: ['json'] }],
  })
  const path = result.filePaths[0]
  if (result.canceled || !path) return undefined
  return parseInboxExport(await readSmallFile(path))
}

/** The file's text, refusing anything but a regular file of at most 1 MB before reading it. */
async function readSmallFile(path: string): Promise<string> {
  const unreadable = () => new Error('The file couldn’t be read.')
  const file = await open(path, 'r').catch(() => {
    throw unreadable()
  })
  try {
    const info = await file.stat().catch(() => {
      throw unreadable()
    })
    if (!info.isFile()) throw unreadable()
    if (info.size > exportMaxBytes)
      throw new Error('This file is too large to be a Warpmail inbox export.')
    // Read at most one byte past the limit, in case the file grew since.
    const buffer = Buffer.alloc(exportMaxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length).catch(() => {
        throw unreadable()
      })
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > exportMaxBytes)
      throw new Error('This file is too large to be a Warpmail inbox export.')
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    await file.close().catch(() => {})
  }
}
