import type { Account, Settings } from './model'

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

export function parseRule(text: string): SplitRule | undefined {
  let t = text.trim().toLowerCase()
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1).trim()
  if (t.endsWith('.')) t = t.slice(0, -1)
  if (!t || /\s/.test(t)) return undefined
  const at = t.indexOf('@')
  if (at < 0) return t.includes('.') && HOST.test(t) ? { kind: 'domain', value: t } : undefined
  if (at !== t.lastIndexOf('@')) return undefined
  const local = t.slice(0, at)
  const host = t.slice(at + 1)
  if (!HOST.test(host)) return undefined
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

export function resolveSplitScope(
  tabId: string | undefined,
  settings: Settings,
  own: string[],
): SplitScope | null | undefined {
  if (!tabId || tabId === 'inbox') return undefined
  if (tabId === 'important') {
    const important = settings.important
    return {
      kind: 'important',
      always: (important?.always ?? []).map((a) => ({
        address: a.address.trim().toLowerCase(),
        words: (a.words ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean),
      })),
      never: (important?.never ?? []).map((n) => n.trim().toLowerCase()),
    }
  }
  const tab = settings.splitTabs?.find((t) => t.id === tabId)
  if (!tab) return null
  const addresses: string[] = []
  const domains: string[] = []
  for (const text of tab.rules) {
    const rule = parseRule(text)
    if (!rule || refusalReason(rule, own)) continue
    if (rule.kind === 'address') addresses.push(rule.value)
    else domains.push(domainKey(rule.value))
  }
  return { kind: 'rules', addresses, domains }
}
