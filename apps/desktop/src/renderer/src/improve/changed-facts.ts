/** The kinds of detail worth double-checking after a rewrite. */
export type FactKind = 'name' | 'number' | 'date' | 'link' | 'email'

/** A detail that went missing from the rewrite, or showed up in it without being in the draft. */
export interface FactChange {
  kind: FactKind
  value: string
  change: 'missing' | 'added'
}

interface Fact {
  kind: FactKind
  value: string
  index: number
}

const months =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const weekdays = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday'
const ordinal = '(?:st|nd|rd|th)?'

const emailPattern = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const linkPattern = /\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"’”]/gi
const datePattern = new RegExp(
  [
    `(?<![\\p{L}\\d])(?:\\d{1,2}${ordinal}\\s+)?(?:${months})(?![\\p{L}\\d])(?:\\s+\\d{1,2}${ordinal}(?![\\p{L}\\d]))?(?:,?\\s+\\d{4}(?!\\d))?`,
    `(?<![\\p{L}\\d])(?:${weekdays}|today|tomorrow|tonight|yesterday)(?![\\p{L}\\d])`,
    '\\d{4}-\\d{2}-\\d{2}',
    '(?<![\\w/])\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?(?![\\w/])',
  ].join('|'),
  'giu',
)
const numberPattern =
  /(?<![\p{L}\d])[$€£]?\d+(?:[,.:]\d+)*(?:%|k(?![\p{L}\d])|\s?[ap]m(?![\p{L}\d]))?/giu
const wordPattern = /\p{Lu}[\p{L}'’-]+/gu
const dateWordPattern = new RegExp(
  `^(?:${months}|${weekdays}|today|tomorrow|tonight|yesterday)$`,
  'i',
)
// Where a sentence begins: start of text, after . ! ? and spaces, or after a newline (and a list dash).
const sentenceStart = /(?:^|[.!?]\s+|\n[ \t]*(?:[-*•][ \t]+)?)$/

/** Finds every match of a pattern, then blanks it out so later kinds cannot reuse it. */
function take(
  text: string,
  pattern: RegExp,
  kind: FactKind,
  found: Fact[],
  keep: (value: string) => boolean = () => true,
): string {
  return text.replace(pattern, (value: string, ...rest: unknown[]) => {
    if (!keep(value)) return value
    const index = rest.find((r): r is number => typeof r === 'number') ?? 0
    found.push({ kind, value, index })
    return ' '.repeat(value.length)
  })
}

/** Capitalized words that look like names, with runs of adjacent ones joined ("Dana Lee"). */
function findNames(text: string, found: Fact[]): void {
  const words = [...text.matchAll(wordPattern)].filter(
    (m) => !/^I['’]/.test(m[0]) && !dateWordPattern.test(m[0]),
  )
  const initial = (m: RegExpMatchArray): boolean => sentenceStart.test(text.slice(0, m.index))
  const seenMidSentence = new Set(words.filter((m) => !initial(m)).map((m) => m[0]))
  const names = words.filter((m) => !initial(m) || seenMidSentence.has(m[0]))

  let run: RegExpMatchArray[] = []
  const close = (): void => {
    if (run.length) {
      found.push({
        kind: 'name',
        value: run.map((m) => m[0]).join(' '),
        index: run[0].index ?? 0,
      })
    }
    run = []
  }
  for (const m of names) {
    const last = run[run.length - 1]
    const gap = last ? text.slice((last.index ?? 0) + last[0].length, m.index) : ''
    if (last && !/^[ \t]$/.test(gap)) close()
    run.push(m)
  }
  close()
}

/** Pulls emails, links, dates, numbers and names out of the text, in order of appearance. */
function extract(text: string): Fact[] {
  const found: Fact[] = []
  let rest = take(text, emailPattern, 'email', found)
  rest = take(rest, linkPattern, 'link', found)
  // A lone lowercase "may" is the verb, not the month.
  rest = take(rest, datePattern, 'date', found, (v) => v !== 'may')
  rest = take(rest, numberPattern, 'number', found)
  findNames(rest, found)
  return found.sort((x, y) => x.index - y.index)
}

/** Unique facts (same kind and value counted once), in order of appearance. */
function unique(facts: Fact[]): Fact[] {
  const seen = new Set<string>()
  return facts.filter((f) => {
    const key = `${f.kind}\n${f.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when the value appears in the text as whole words, matching case. */
const mentions = (text: string, value: string): boolean =>
  new RegExp(`(?<![\\p{L}\\d])${escapeRegExp(value)}(?![\\p{L}\\d])`, 'u').test(text)

/**
 * Compares the names, numbers, dates, links and email addresses in a draft with
 * its rewrite. Anything in `before` that is not in `after` is `missing`;
 * anything in `after` that was not in `before` is `added`. A name counts as
 * added only if its word is nowhere in the draft (ignoring case), and as
 * missing only if it is nowhere in the rewrite, so a name moved to the start of
 * a sentence is not reported.
 */
export function changedFacts(before: string, after: string): FactChange[] {
  const b = unique(extract(before))
  const a = unique(extract(after))
  const afterKeys = new Set(a.map((f) => `${f.kind}\n${f.value}`))
  const beforeKeys = new Set(b.map((f) => `${f.kind}\n${f.value}`))
  const beforeWords = new Set((before.match(/[\p{L}'’-]+/gu) ?? []).map((w) => w.toLowerCase()))

  const changes: FactChange[] = []
  for (const f of b) {
    if (afterKeys.has(`${f.kind}\n${f.value}`)) continue
    if (f.kind === 'name' && mentions(after, f.value)) continue
    changes.push({ kind: f.kind, value: f.value, change: 'missing' })
  }
  for (const f of a) {
    if (beforeKeys.has(`${f.kind}\n${f.value}`)) continue
    if (f.kind === 'name') {
      const words = f.value.split(' ')
      if (words.every((w) => beforeWords.has(w.toLowerCase()))) continue
    }
    changes.push({ kind: f.kind, value: f.value, change: 'added' })
  }
  return changes
}
