import { z } from 'zod'
import type { Account, Settings } from './model'
import {
  importantListSchema,
  senderSchema,
  splitRulesSchema,
  splitTabNameSchema,
  splitTabsSchema,
  subjectWordsSchema,
} from './schemas'

export type SplitRule = { kind: 'address'; value: string } | { kind: 'domain'; value: string }

export interface SplitTab {
  id: string
  name: string
  rules: string[]
}

export interface ImportantSettings {
  always: { address: string; words?: string[] }[]
  never: string[]
}

/** What a tab selects. Domains are in `domainKey` form so the index can match by prefix. */
export type SplitScope =
  | { kind: 'rules'; addresses: string[]; domains: string[] }
  | { kind: 'important'; always: { address: string; words: string[] }[]; never: string[] }

const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.fr',
  'live.com',
  'live.ca',
  'msn.com',
  'yahoo.com',
  'yahoo.fr',
  'yahoo.ca',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'fastmail.com',
  'hey.com',
  'videotron.ca',
  'sympatico.ca',
])

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

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL.has(domain.toLowerCase())
}

export function domainKey(domain: string): string {
  return domain.toLowerCase().split('.').reverse().join('.')
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
// A domain name has at most 253 characters, and a saved rule at most 320.
const isHost = (host: string) => host.length <= 253 && HOST.test(host)

export function parseRule(text: string): SplitRule | undefined {
  let t = text.trim().toLowerCase()
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1).trim()
  if (t.endsWith('.')) t = t.slice(0, -1)
  if (!t || t.length > 320 || /\s/.test(t)) return undefined
  const at = t.indexOf('@')
  if (at < 0) return t.includes('.') && isHost(t) ? { kind: 'domain', value: t } : undefined
  if (at !== t.lastIndexOf('@')) return undefined
  const local = t.slice(0, at)
  const host = t.slice(at + 1)
  if (!isHost(host)) return undefined
  return local ? { kind: 'address', value: t } : { kind: 'domain', value: host }
}

export function formatRule(rule: SplitRule): string {
  return rule.kind === 'domain' ? `@${rule.value}` : rule.value
}

function hostOf(email: string) {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}

function within(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`)
}

export function refusalReason(rule: SplitRule, own: string[]): string | undefined {
  const x = formatRule(rule)
  const mine = own.map((e) => e.trim().toLowerCase())
  if (rule.kind === 'address' && mine.includes(rule.value))
    return `${x} is your own address, so every conversation would match.`
  const host = rule.kind === 'address' ? hostOf(rule.value) : rule.value
  const ownDomains = new Set(mine.map(hostOf).filter((d) => !isFreeMailDomain(d)))
  for (const d of ownDomains)
    if (within(host, d))
      return `${x} is on your own domain, so every conversation would match. Tabs are decided by the people you write with.`
  if (rule.kind === 'domain' && mine.some((e) => within(hostOf(e), rule.value)))
    return `${x} includes your own address, so every conversation would match.`
  return undefined
}

export function parseRuleLines(
  text: string,
  own: string[],
): { rules: string[]; problems: { line: number; text: string; reason: string }[] } {
  const rules: string[] = []
  const seen = new Set<string>()
  const problems: { line: number; text: string; reason: string }[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line) return
    const rule = parseRule(line)
    if (!rule) {
      problems.push({ line: i + 1, text: line, reason: `${line} is not an address or a domain.` })
      return
    }
    const reason = refusalReason(rule, own)
    if (reason) {
      problems.push({ line: i + 1, text: line, reason })
      return
    }
    const formatted = formatRule(rule)
    if (seen.has(formatted)) return
    seen.add(formatted)
    rules.push(formatted)
  })
  return { rules, problems }
}

/** No-reply and bounce senders show up in mail but can't receive it. */
export function isAutomatedAddress(email: string): boolean {
  const at = email.lastIndexOf('@')
  const local = (at < 0 ? email : email.slice(0, at)).toLowerCase()
  if (local === 'mailer-daemon' || local === 'postmaster') return true
  // Bounce and VERP addresses: bounce, bounces, bounces+id, bounce-123.
  return /^(noreply|donotreply|bounce)/.test(local.replace(/[.\-_]/g, ''))
}

export function isAutomatedMessage(m: {
  fromEmail?: string
  unsubscribe?: unknown
  listId?: string | null
  precedence?: string | null
  autoSubmitted?: string | null
}): boolean {
  if (m.fromEmail && isAutomatedAddress(m.fromEmail)) return true
  if (m.unsubscribe) return true
  if (m.listId?.trim()) return true
  const precedence = m.precedence?.trim().toLowerCase()
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true
  const auto = m.autoSubmitted?.trim().toLowerCase()
  return !!auto && auto !== 'no'
}

export function ruleMatches(rule: SplitRule, email: string): boolean {
  const e = email.trim().toLowerCase()
  return rule.kind === 'address' ? e === rule.value : within(hostOf(e), rule.value)
}

/** A tab narrows the plain inbox view and the filter fields; full-text search leaves it. */
export function tabApplies(query: { view: string; mailboxId?: string; text?: string }): boolean {
  return query.view === 'inbox' && !query.mailboxId && !query.text
}

/** The most a tab or list may hold; settings and import files are held to them. */
export const splitLimits = { tabs: 50, rules: 500, important: 500, words: 20 } as const

/** `host` or one of its parent domains is in `domains`. */
function coveredBy(host: string, domains: Set<string>) {
  for (let d = host; ; d = d.slice(d.indexOf('.') + 1)) {
    if (domains.has(d)) return true
    if (!d.includes('.')) return false
  }
}

/**
 * The scope a query or count sends to the index. Each rule goes once, and rules a domain in the
 * same tab already covers (its subdomains and addresses) are left out, so a hand-edited file
 * full of repeats costs no more than the rules it really holds. At most `splitLimits` entries.
 */
export function resolveSplitScope(
  tabId: string | undefined,
  settings: Settings,
  own: string[],
): SplitScope | null | undefined {
  if (!tabId || tabId === 'inbox') return undefined
  if (tabId === 'important') {
    const important = settings.important
    const always = new Map<string, string[]>()
    for (const a of important?.always ?? []) {
      const address = a.address.trim().toLowerCase()
      if (always.has(address)) continue
      if (always.size >= splitLimits.important) break
      const words = (a.words ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean)
      always.set(address, [...new Set(words)].slice(0, splitLimits.words))
    }
    const never = new Set((important?.never ?? []).map((n) => n.trim().toLowerCase()))
    return {
      kind: 'important',
      always: [...always].map(([address, words]) => ({ address, words })),
      never: [...never].slice(0, splitLimits.important),
    }
  }
  const tab = settings.splitTabs?.find((t) => t.id === tabId)
  if (!tab) return null
  const addresses = new Set<string>()
  const domains = new Set<string>()
  for (const text of tab.rules.slice(0, splitLimits.rules)) {
    const rule = parseRule(text)
    if (!rule || refusalReason(rule, own)) continue
    if (rule.kind === 'address') addresses.add(rule.value)
    else domains.add(rule.value)
  }
  const parent = (domain: string) => domain.slice(domain.indexOf('.') + 1)
  return {
    kind: 'rules',
    addresses: [...addresses].filter((a) => !coveredBy(hostOf(a), domains)),
    domains: [...domains]
      .filter((d) => !d.includes('.') || !coveredBy(parent(d), domains))
      .map(domainKey),
  }
}

/** The file Settings → Inbox exports and imports, as the design defines it. */
export interface InboxExport {
  version: 1
  tabs: { name: string; rules: string[] }[]
  important: { always: { sender: string; subjectWords?: string[] }[]; never: string[] }
}

// Important and its lists may be left out: a file with only tabs is still an export.
const inboxExportSchema = z.object({
  version: z.literal(1),
  tabs: splitTabsSchema(z.object({ name: splitTabNameSchema, rules: splitRulesSchema })),
  important: z
    .object({
      always: importantListSchema(
        z.object({ sender: senderSchema, subjectWords: subjectWordsSchema.optional() }),
      ).default([]),
      never: importantListSchema(senderSchema).default([]),
    })
    .default({ always: [], never: [] }),
})

/** Only the tabs (names and rules, in order) and Important lists: no ids or other settings. */
export function inboxExport(settings: Settings): InboxExport {
  return {
    version: 1,
    tabs: (settings.splitTabs ?? []).map(({ name, rules }) => ({ name, rules: [...rules] })),
    important: {
      always: (settings.important?.always ?? []).map(({ address, words }) =>
        words?.length ? { sender: address, subjectWords: [...words] } : { sender: address },
      ),
      never: [...(settings.important?.never ?? [])],
    },
  }
}

const notAnExport = 'This file isn’t a Warpmail inbox export.'

/** Reads an export file's text. Untrusted: anything but the known fields is dropped. */
export function parseInboxExport(text: string): InboxExport {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error(notAnExport)
  }
  const parsed = inboxExportSchema.safeParse(data)
  if (!parsed.success) throw new Error(notAnExport)
  return parsed.data
}

/** The settings after an import, and what it changed. */
export interface InboxImport {
  splitTabs: SplitTab[]
  important: ImportantSettings
  /** Tabs created. */
  newTabs: number
  /** Existing tabs that got rules. */
  updatedTabs: number
  /** Important senders added or changed. */
  senders: number
  /** Tabs, rules and senders left out: unreadable, own, conflicting or over a limit. */
  skipped: number
}

const tabsMax = splitLimits.tabs
const rulesMax = splitLimits.rules
const importantMax = splitLimits.important
const wordsMax = splitLimits.words
const builtInTabNames = ['inbox', 'important']
const key = (text: string) => text.trim().toLowerCase()
const senderAddress = (text: string) => {
  const rule = parseRule(text)
  return rule?.kind === 'address' ? rule.value : undefined
}

/**
 * Adds an export's tabs and Important senders to these settings. Never deletes anything: rules
 * join the tab of the same name, new tabs get fresh ids, and an entry that conflicts with these
 * lists is skipped, as are own addresses (refused as the editor refuses them) and overflow.
 */
export function mergeInboxImport(
  settings: Pick<Settings, 'splitTabs' | 'important'>,
  file: InboxExport,
  own: string[],
  newId: () => string = () => crypto.randomUUID(),
): InboxImport {
  let skipped = 0
  const tabs = (settings.splitTabs ?? []).map((tab) => ({ ...tab, rules: [...tab.rules] }))
  const created = new Set<string>()
  const updated = new Set<string>()
  for (const incoming of file.tabs) {
    const name = incoming.name.trim()
    const existing = tabs.find((t) => key(t.name) === key(name))
    if (!existing && (!name || builtInTabNames.includes(key(name)) || tabs.length >= tabsMax)) {
      skipped++
      continue
    }
    // A new tab is made only once one of its rules is taken.
    const tab = existing ?? { id: '', name, rules: [] }
    const has = new Set(tab.rules.map(key))
    for (const text of incoming.rules) {
      const rule = parseRule(text)
      const formatted = rule && formatRule(rule)
      if (!rule || !formatted || formatted.length > 320 || refusalReason(rule, own)) {
        skipped++
        continue
      }
      if (has.has(formatted)) continue
      if (tab.rules.length >= rulesMax) {
        skipped++
        continue
      }
      tab.rules.push(formatted)
      has.add(formatted)
      if (existing && !created.has(tab.id)) updated.add(tab.id)
    }
    if (existing) continue
    if (!tab.rules.length) {
      skipped++
      continue
    }
    tab.id = newId()
    tabs.push(tab)
    created.add(tab.id)
  }

  let senders = 0
  const always = [...(settings.important?.always ?? [])]
  const never = [...(settings.important?.never ?? [])]
  for (const entry of file.important.always) {
    const address = senderAddress(entry.sender)
    if (!address || never.some((n) => key(n) === address)) {
      skipped++
      continue
    }
    // Comma-separated, as typed in the editor.
    const words = [
      ...new Set(
        (entry.subjectWords ?? [])
          .flatMap((w) => w.split(','))
          .map(key)
          .filter(Boolean),
      ),
    ]
    if (words.length > wordsMax) {
      skipped++
      continue
    }
    const at = always.findIndex((a) => key(a.address) === address)
    const current = always[at]
    if (!current) {
      if (always.length >= importantMax) skipped++
      else {
        always.push(words.length ? { address, words } : { address })
        senders++
      }
      continue
    }
    // Without words a sender always shows, which covers any words.
    if (!current.words?.length) continue
    if (!words.length) {
      always[at] = { address: current.address }
      senders++
      continue
    }
    const merged = [...new Set([...current.words, ...words])]
    if (merged.length === current.words.length) continue
    if (merged.length > wordsMax) {
      skipped++
      continue
    }
    always[at] = { ...current, words: merged }
    senders++
  }
  for (const text of file.important.never) {
    const address = senderAddress(text)
    if (!address || always.some((a) => key(a.address) === address)) {
      skipped++
      continue
    }
    if (never.some((n) => key(n) === address)) continue
    if (never.length >= importantMax) {
      skipped++
      continue
    }
    never.push(address)
    senders++
  }
  return {
    splitTabs: tabs,
    important: { always, never },
    newTabs: created.size,
    updatedTabs: updated.size,
    senders,
    skipped,
  }
}
