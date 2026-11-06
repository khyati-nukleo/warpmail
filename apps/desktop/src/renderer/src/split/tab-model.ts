import type { QueryClient, QueryKey } from '@tanstack/react-query'
import {
  formatRule,
  isFreeMailDomain,
  parseRule,
  parseRuleLines,
  refusalReason,
  type Account,
  type Address,
  type ImportantSettings,
  type Message,
  type Settings,
  type SplitTab,
} from '@inlark/core'

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

/** The indexes `moveTab` takes to move a user tab one place left or right, where it can go. */
export function tabMoves(tabs: { id: string }[], id: string): { left?: number; right?: number } {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return { left: undefined, right: undefined }
  return {
    left: index > 0 ? index - 1 : undefined,
    right: index < tabs.length - 1 ? index + 1 : undefined,
  }
}

/** What a user tab's menu and its commands do. */
export type TabAction = 'rules' | 'rename' | 'left' | 'right' | 'delete'

/** Replaces the tab with the same id, or adds it at the end, without changing the input. */
export function putTab(tabs: SplitTab[], tab: SplitTab): SplitTab[] {
  return tabs.some((t) => t.id === tab.id)
    ? tabs.map((t) => (t.id === tab.id ? tab : t))
    : [...tabs, tab]
}

export const tabNameMax = 60
/** The settings schema's limits, explained in the editor rather than failing the save. */
export const tabsMax = 50
export const tabRulesMax = 500

export type RuleProblem = ReturnType<typeof parseRuleLines>['problems'][number]

export interface EditorState {
  /** The rules to save, normalised and without duplicates. */
  rules: string[]
  problems: RuleProblem[]
  nameError?: string
  /** Too many tabs, or too many rules in this one. */
  limitError?: string
  canSave: boolean
}

/** What the tab editor shows and whether it can save, for a tab being made or `editingId`. */
export function editorState(
  name: string,
  rulesText: string,
  own: string[],
  existing: SplitTab[],
  editingId?: string,
): EditorState {
  const { rules, problems } = parseRuleLines(rulesText, own)
  const nameError = tabNameError(name, existing, editingId)
  const limitError =
    !editingId && existing.length >= tabsMax
      ? 'You have ' + tabsMax + ' tabs, the most there can be. Delete one to make room.'
      : rules.length > tabRulesMax
        ? 'A tab holds up to ' +
          tabRulesMax +
          ' addresses and domains. This one has ' +
          rules.length.toLocaleString() +
          '.'
        : undefined
  return {
    rules,
    problems,
    nameError,
    limitError,
    canSave: !nameError && !limitError && !problems.length,
  }
}

function tabNameError(name: string, existing: SplitTab[], editingId?: string) {
  const trimmed = name.trim()
  if (!trimmed) return 'Name the tab.'
  if (trimmed.length > tabNameMax) return 'Keep the name to 60 characters or fewer.'
  const key = trimmed.toLowerCase()
  const builtIn = ['Inbox', 'Important'].find((n) => n.toLowerCase() === key)
  if (builtIn) return builtIn + ' is a built-in tab. Choose another name.'
  const twin = existing.find((t) => t.id !== editingId && t.name.trim().toLowerCase() === key)
  if (twin) return 'You already have a tab called “' + twin.name + '”.'
}

/** The From of the newest message not sent from one of the user's own addresses. */
export function senderOf(
  messages: Pick<Message, 'from' | 'receivedAt'>[],
  own: string[],
): Address | undefined {
  const mine = new Set(own.map((e) => e.trim().toLowerCase()))
  return [...messages]
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .map((m) => m.from[0])
    .find((from) => from && !mine.has(from.email.trim().toLowerCase()))
}

/**
 * Whether the whole conversation must be fetched to find a sender: none was `found` in the
 * messages on hand, and they may be only some of them (a list summary, or the reader's
 * placeholder while the conversation loads).
 */
export function needsWholeConversation(
  known: { messages?: unknown[]; count?: number; partial?: boolean },
  found: boolean,
): boolean {
  if (found) return false
  return !known.messages || !!known.partial || (known.count ?? 0) > known.messages.length
}

export interface SenderRules {
  /** The sender's address as a rule, unless it is refused. */
  address?: string
  /** The sender's whole domain, offered only when it isn't free mail and isn't refused. */
  domain?: string
  /** Why the sender can't go in a tab. */
  refusal?: string
}

export function senderRules(email: string, own: string[]): SenderRules {
  const rule = parseRule(email)
  if (rule?.kind !== 'address') return { refusal: email + ' isn’t an address a tab can use.' }
  const refusal = refusalReason(rule, own)
  if (refusal) return { refusal }
  const host = rule.value.slice(rule.value.lastIndexOf('@') + 1)
  const domain = { kind: 'domain', value: host } as const
  return {
    address: formatRule(rule),
    ...(!isFreeMailDomain(host) && !refusalReason(domain, own)
      ? { domain: formatRule(domain) }
      : {}),
  }
}

/**
 * Adds `rule` to the tab with `target.id` (or named `target.name`), or else creates a tab named
 * `target.name` with it. `already` when the tab had the rule; an unknown id changes nothing.
 */
export function addRule(
  tabs: SplitTab[],
  target: { id?: string; name?: string },
  rule: string,
): { tabs: SplitTab[]; tabId: string; already: boolean } {
  const name = target.name?.trim() ?? ''
  const existing = target.id
    ? tabs.find((t) => t.id === target.id)
    : tabs.find((t) => t.name.trim().toLowerCase() === name.toLowerCase())
  if (existing) {
    const already = existing.rules.some((r) => r.toLowerCase() === rule.toLowerCase())
    return {
      tabs: already ? tabs : putTab(tabs, { ...existing, rules: [...existing.rules, rule] }),
      tabId: existing.id,
      already,
    }
  }
  if (target.id || !name) return { tabs, tabId: '', already: false }
  const tab = { id: crypto.randomUUID(), name, rules: [rule] }
  return { tabs: [...tabs, tab], tabId: tab.id, already: false }
}

/** A row in the add-to-tab picker: the tab editor, a tab named as typed, or an existing tab. */
export type PickerOption =
  { kind: 'new' } | { kind: 'create'; name: string } | { kind: 'tab'; tab: SplitTab }

/**
 * "New tab…" (or a tab named as typed, unless a tab has that name), then the tabs whose name
 * contains the text, those with a word starting with it first. Such a tab is highlighted;
 * otherwise the new tab is, so typing "art" makes "Art" rather than picking "Partners".
 */
export function pickerOptions(
  tabs: SplitTab[],
  text: string,
): { options: PickerOption[]; highlight: number } {
  const typed = text.trim()
  const query = typed.toLowerCase()
  if (!query) return { options: [{ kind: 'new' }, ...tabs.map(asOption)], highlight: 0 }
  const starts = (t: SplitTab) =>
    t.name
      .toLowerCase()
      .split(/[\s/._-]+/)
      .some((word) => word.startsWith(query))
  const found = tabs.filter((t) => t.name.toLowerCase().includes(query))
  const ranked = [...found.filter(starts), ...found.filter((t) => !starts(t))].map(asOption)
  if (tabs.some((t) => t.name.trim().toLowerCase() === query))
    return { options: ranked, highlight: 0 }
  return {
    options: [{ kind: 'create', name: typed }, ...ranked],
    highlight: found.some(starts) ? 1 : 0,
  }
}

const asOption = (tab: SplitTab): PickerOption => ({ kind: 'tab', tab })

/** Why a picker option can't take `rule`: too many tabs, a bad name or a full tab. */
export function pickProblem(
  option: PickerOption,
  tabs: SplitTab[],
  rule: string,
  own: string[],
): string | undefined {
  if (option.kind === 'tab') {
    const { rules, name } = option.tab
    const has = rules.some((r) => r.toLowerCase() === rule.toLowerCase())
    return !has && rules.length >= tabRulesMax
      ? '“' +
          name +
          '” already holds ' +
          tabRulesMax +
          ' addresses and domains, the most a tab can.'
      : undefined
  }
  // The editor names a tab opened from "New tab…", so only the tab limit applies to it.
  const state = editorState(option.kind === 'create' ? option.name : '', rule, own, tabs)
  return option.kind === 'create' ? (state.limitError ?? state.nameError) : state.limitError
}

export function matchCountText(n: number) {
  if (!n) return 'Matches no conversations in your inbox'
  return (
    'Matches ' +
    n.toLocaleString() +
    (n === 1 ? ' conversation' : ' conversations') +
    ' in your inbox'
  )
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

export function tabEmptyCopy(
  entry: TabEntry,
  untabbed: string[],
  unreadOnly = false,
): TabEmptyCopy {
  const copy: TabEmptyCopy = unreadOnly
    ? {
        id: entry.id,
        title: 'Nothing unread in ' + entry.name,
        description: 'You’ve read everything here.',
      }
    : {
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

/** The DOM ids that tie each tab to the list it controls. */
export const tabPanelId = 'inbox-tab-panel'
export const tabElementId = (id: string) => 'inbox-tab-' + id

/** Runs tasks one after another, so a later save never races an earlier one. */
export function serialQueue() {
  let last: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = last.then(task, task)
    last = run.catch(() => {})
    return run
  }
}

/**
 * Resolves once no query under `queryKey` is fetching. Waits a tick first so a fetch started
 * in the same render (a new list, a refresh) is seen.
 */
export function whenIdle(client: QueryClient, queryKey: QueryKey): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined
    const check = () => {
      if (client.isFetching({ queryKey })) return false
      unsubscribe?.()
      resolve()
      return true
    }
    setTimeout(() => {
      if (!check()) unsubscribe = client.getQueryCache().subscribe(check)
    })
  })
}

/** The settings schema's limits for Important's Always and Never lists. */
export const importantListMax = 500
export const wordsMax = 20
export const wordLengthMax = 100

const addressKey = (address: string) => address.trim().toLowerCase()

/** Subject words typed comma-separated: trimmed, lowercased, without empties or repeats. */
export function parseWords(text: string): string[] {
  return allWords(text).slice(0, wordsMax)
}
const allWords = (text: string) => [
  ...new Set(
    text
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean),
  ),
]

/** Why the typed words can't be saved, if they can't. */
export function wordsProblem(text: string): string | undefined {
  const words = allWords(text)
  if (words.length > wordsMax) return 'Use ' + wordsMax + ' words or fewer.'
  if (words.some((w) => w.length > wordLengthMax))
    return 'Keep each word to ' + wordLengthMax + ' characters or fewer.'
}

/** Always shows `address` in Important (only for subjects with `words`, when given). */
export function setAlways(
  important: ImportantSettings | undefined,
  address: string,
  words: string[],
): ImportantSettings {
  const key = addressKey(address)
  const entry = words.length ? { address: key, words } : { address: key }
  const always = important?.always ?? []
  const at = always.findIndex((a) => addressKey(a.address) === key)
  return {
    always: at < 0 ? [...always, entry] : always.map((a, i) => (i === at ? entry : a)),
    never: (important?.never ?? []).filter((n) => addressKey(n) !== key),
  }
}

/** Keeps `address` out of Important (`on`), or lets it back. Turning it on drops any Always. */
export function setNever(
  important: ImportantSettings | undefined,
  address: string,
  on: boolean,
): ImportantSettings {
  const key = addressKey(address)
  const always = important?.always ?? []
  const never = (important?.never ?? []).filter((n) => addressKey(n) !== key)
  if (!on) return { always, never }
  const listed = important?.never.some((n) => addressKey(n) === key)
  return {
    always: always.filter((a) => addressKey(a.address) !== key),
    never: listed ? important!.never : [...never, key],
  }
}

/** The sender's Always entry, and whether they are on Never. */
export function importantStatus(
  important: ImportantSettings | undefined,
  address: string,
): { always?: ImportantSettings['always'][number]; never: boolean } {
  const key = addressKey(address)
  const always = important?.always.find((a) => addressKey(a.address) === key)
  const never = !!important?.never.some((n) => addressKey(n) === key)
  return always ? { always, never } : { never }
}

/** Why the sender can't be added to a list that is full. */
export function importantLimit(
  important: ImportantSettings | undefined,
  address: string,
  list: 'always' | 'never',
): string | undefined {
  const key = addressKey(address)
  const keys =
    list === 'always'
      ? (important?.always ?? []).map((a) => addressKey(a.address))
      : (important?.never ?? []).map(addressKey)
  if (keys.length < importantListMax || keys.includes(key)) return
  return (
    (list === 'always' ? 'Always' : 'Never') +
    ' show in Important already lists ' +
    importantListMax +
    ' senders, the most it can.'
  )
}

/** The toast after saving an Always entry. */
export function alwaysShownText(address: string, words: string[]): string {
  if (!words.length) return address + ' will always show in Important'
  const quoted = words.map((w) => '“' + w + '”')
  const list =
    quoted.length > 1 ? quoted.slice(0, -1).join(', ') + ' or ' + quoted.at(-1) : quoted[0]
  return address + ' will show in Important when the subject contains ' + list
}

/**
 * Undoes "Never show" for one sender on the latest lists, given their `before` status: takes
 * them off Never and puts back their Always entry, unless they were on Never already or have
 * an Always entry again. Every other sender's entries stay as they are now.
 */
export function undoNever(
  important: ImportantSettings | undefined,
  address: string,
  before: ReturnType<typeof importantStatus>,
): ImportantSettings {
  const latest = { always: important?.always ?? [], never: important?.never ?? [] }
  if (before.never) return latest
  const key = addressKey(address)
  if (latest.always.some((a) => addressKey(a.address) === key)) return latest
  const never = latest.never.filter((n) => addressKey(n) !== key)
  const restore = before.always && latest.always.length < importantListMax
  return { always: restore ? [...latest.always, before.always!] : latest.always, never }
}

/** The address typed into Never show's add field, or why it can't be added. */
export function neverEntry(
  text: string,
  important: ImportantSettings | undefined,
): { address?: string; problem?: string } {
  if (!text.trim()) return {}
  const rule = parseRule(text)
  if (rule?.kind !== 'address')
    return { problem: 'Enter one email address, like someone@example.com.' }
  if (importantStatus(important, rule.value).never)
    return { problem: rule.value + ' is already on the list.' }
  const limit = importantLimit(important, rule.value, 'never')
  return limit ? { problem: limit } : { address: rule.value }
}

const counted = (n: number, one: string, many = one + 's') =>
  n.toLocaleString() + ' ' + (n === 1 ? one : many)

/** The toast after an import: what it added, and how much it left out. No addresses. */
export function importedText(result: {
  newTabs: number
  updatedTabs: number
  senders: number
  skipped: number
}): string {
  const parts = [
    result.newTabs ? counted(result.newTabs, 'tab') : '',
    result.updatedTabs ? 'new rules for ' + counted(result.updatedTabs, 'tab') : '',
    result.senders ? counted(result.senders, 'Important sender') : '',
  ].filter(Boolean)
  const skipped = result.skipped ? ' · ' + result.skipped.toLocaleString() + ' skipped' : ''
  if (!parts.length)
    return skipped
      ? 'Nothing imported' + skipped
      : 'Nothing new to import. You already have everything in this file.'
  const list = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts.at(-1) : parts[0]
  return 'Imported ' + list + skipped
}
