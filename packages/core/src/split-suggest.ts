import {
  formatRule,
  isAutomatedAddress,
  isFreeMailDomain,
  parseRule,
  refusalReason,
  ruleMatches,
  type SplitRule,
} from './split'

/** An address seen in recent mail, with how many emails it was on. */
export interface AddressSeen {
  email: string
  name?: string
  count: number
}

/** A rule offered while typing in a tab's rules box: `@host` or an address. */
export interface RuleSuggestion {
  rule: string
  name?: string
}

/** How long back the rules box looks for addresses to suggest. */
export const suggestionDays = 30

/**
 * What the index is asked to match for the typed line: the text after a leading `@`, lowercased.
 * Undefined when nothing should be suggested.
 */
export function suggestionTerm(text: string): string | undefined {
  const t = text.trim().toLowerCase()
  if (!t || /\s/.test(t)) return undefined
  return t.startsWith('@') ? t.slice(1) : t
}

const hostOf = (email: string) => email.slice(email.lastIndexOf('@') + 1)
// Second-level labels under a country code (co.uk, com.au) and Canada's provinces (qc.ca): a rule
// for one would take in a whole country or province.
const REGIONAL = new Set(
  'ac co com edu gc gov gouv net org ab bc mb nb nl ns nt nu on pe qc sk yt'.split(' '),
)
const isRegional = (domain: string) => {
  const labels = domain.split('.')
  return labels.length === 2 && labels[1]!.length === 2 && REGIONAL.has(labels[0]!)
}
/** A rule the box accepts and doesn't refuse, written as the box writes it. */
function acceptable(text: string, own: string[]): SplitRule | undefined {
  const rule = parseRule(text)
  return rule && !refusalReason(rule, own) ? rule : undefined
}
/** Whether a rule already in the box covers this one. */
const covered = (rule: SplitRule, rules: SplitRule[]) =>
  rules.some((r) =>
    rule.kind === 'address'
      ? ruleMatches(r, rule.value)
      : r.kind === 'domain' && ruleMatches(r, 'x@' + rule.value),
  )
/** Whether a host label starts with `q`, e.g. "mail.client.example" for "cli". */
const labelStarts = (host: string, q: string) => ('.' + host).includes('.' + q)

/**
 * Rules for the line being typed. `@` and letters suggest domains, starting at the label typed so
 * subdomains roll up; anything else suggests people by address, name word or domain label.
 * Only rules the box accepts are offered: never own addresses and domains, free-mail domains,
 * country or province suffixes, automated senders, or what the rules in `exclude` already cover.
 * Most mail first.
 */
export function suggestRules(
  text: string,
  seen: AddressSeen[],
  own: string[],
  { exclude = [], limit = 8 }: { exclude?: string[]; limit?: number } = {},
): RuleSuggestion[] {
  const q = suggestionTerm(text)
  if (q === undefined) return []
  const present = exclude.flatMap((r) => parseRule(r) ?? [])
  const ranked = (entries: { rule: string; name?: string; count: number }[]) =>
    entries
      .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule))
      .slice(0, limit)
      .map(({ rule, name }) => (name ? { rule, name } : { rule }))

  if (text.trim().startsWith('@')) {
    const domains = new Map<string, number>()
    for (const a of seen) {
      const host = hostOf(a.email.toLowerCase())
      const at = q ? ('.' + host).indexOf('.' + q) : 0
      if (at < 0) continue
      const rule = acceptable('@' + host.slice(at), own)
      if (!rule || rule.kind !== 'domain' || covered(rule, present)) continue
      const domain = rule.value
      if (!domain.includes('.') || isFreeMailDomain(domain) || isRegional(domain)) continue
      domains.set(domain, (domains.get(domain) ?? 0) + a.count)
    }
    // A subdomain goes into its parent when both are offered: the parent's rule covers it.
    for (const domain of [...domains.keys()]) {
      const parent = [...domains.keys()].find((p) => domain.endsWith('.' + p))
      if (!parent) continue
      domains.set(parent, domains.get(parent)! + domains.get(domain)!)
      domains.delete(domain)
    }
    return ranked(
      [...domains].map(([domain, count]) => ({
        rule: formatRule({ kind: 'domain', value: domain }),
        count,
      })),
    )
  }

  const people = new Map<string, { rule: string; name?: string; count: number }>()
  for (const a of seen) {
    const email = a.email.toLowerCase()
    if (isAutomatedAddress(email)) continue
    const words = (a.name ?? '').toLowerCase().split(/\s+/)
    if (
      !email.startsWith(q) &&
      !words.some((w) => w.startsWith(q)) &&
      !labelStarts(hostOf(email), q)
    )
      continue
    const rule = acceptable(email, own)
    if (!rule || rule.kind !== 'address' || covered(rule, present)) continue
    const entry = people.get(rule.value)
    if (entry) {
      entry.count += a.count
      entry.name ||= a.name
    } else
      people.set(rule.value, { rule: formatRule(rule), name: a.name || undefined, count: a.count })
  }
  return ranked([...people.values()])
}
