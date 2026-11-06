import { constants } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type { z } from 'zod'
import {
  alwaysSenderSchema,
  inboxExport,
  ownAddresses,
  parseInboxExport,
  resolveSplitScope,
  senderSchema,
  splitLimits,
  splitTabSchema,
  suggestRules,
  tabApplies,
  type Account,
  type AddressSeen,
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

/** Suggestions for the typed line from every account's recent addresses, counted together. */
export function ruleSuggestionsFrom(
  text: string,
  exclude: string[],
  accounts: Account[],
  perAccount: AddressSeen[][],
) {
  const merged = new Map<string, AddressSeen>()
  for (const seen of perAccount)
    for (const a of seen) {
      const entry = merged.get(a.email)
      if (!entry) merged.set(a.email, { ...a })
      else {
        entry.count += a.count
        entry.name ||= a.name
      }
    }
  return suggestRules(text, [...merged.values()], ownAddresses(accounts), { exclude })
}

/** Conversations matching the rules being edited, summed over accounts. */
export function sumMatches(perAccount: TabCounts[]) {
  return perAccount.reduce((n, counts) => n + (counts.draft?.conversations ?? 0), 0)
}

/**
 * The split inbox settings as read from disk, which may have been edited by hand: tabs and
 * Important entries that settings couldn't save are dropped, and the rest kept.
 */
export function checkedSplitSettings(settings: Settings): Settings {
  /** The entries of `value` that `schema` accepts, at most `max` of them. */
  const valid = <T>(value: unknown, schema: z.ZodType<T>, max: number): T[] =>
    Array.isArray(value)
      ? value
          .flatMap((v) => {
            const parsed = schema.safeParse(v)
            return parsed.success ? [parsed.data] : []
          })
          .slice(0, max)
      : []
  const important = settings.important as { always?: unknown; never?: unknown } | undefined
  return {
    ...settings,
    splitTabs: Array.isArray(settings.splitTabs)
      ? valid(settings.splitTabs, splitTabSchema, splitLimits.tabs)
      : undefined,
    important:
      important && typeof important === 'object'
        ? {
            always: valid(important.always, alwaysSenderSchema, splitLimits.important),
            never: valid(important.never, senderSchema, splitLimits.important),
          }
        : undefined,
  }
}

const exportMaxBytes = 1024 * 1024

/** The window the dialog belongs to, so it is modal there. */
const parentWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
const showSave = (options: Electron.SaveDialogOptions) => {
  const window = parentWindow()
  return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options)
}
const showOpen = (options: Electron.OpenDialogOptions) => {
  const window = parentWindow()
  return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)
}

/** Saves the tabs and Important lists where the user picks; false when cancelled. */
export async function exportInboxFile(settings: Settings): Promise<boolean> {
  const result = await showSave({
    title: 'Export inbox tabs',
    defaultPath: 'warpmail-inbox.json',
    filters: [{ name: 'Warpmail inbox export', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return false
  await writePrivately(result.filePath, JSON.stringify(inboxExport(settings), null, 2) + '\n')
  return true
}

/**
 * Writes a new private file beside `path` and renames it over `path`, so the file is never
 * readable by others, even for a moment, and a failed write leaves any old file as it was.
 */
async function writePrivately(path: string, text: string) {
  const temporary = join(dirname(path), '.warpmail-' + randomUUID() + '.tmp')
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(text)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } catch {
    await rm(temporary, { force: true }).catch(() => {})
    // File system errors name the path, and IPC errors are logged.
    throw new Error('The file couldn’t be saved. Choose another folder and try again.')
  }
}

/** Reads an inbox export the user picks, without applying it; undefined when cancelled. */
export async function importInboxFile(): Promise<InboxExport | undefined> {
  const result = await showOpen({
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
  // Checked before opening, since opening a pipe waits for a writer; and opened without
  // blocking, in case the file was swapped for one since.
  const before = await stat(path).catch(() => {
    throw unreadable()
  })
  if (!before.isFile()) throw unreadable()
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(() => {
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
