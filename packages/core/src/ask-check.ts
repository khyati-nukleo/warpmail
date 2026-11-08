/** Phrases that ask the reader for something (English and French). Matched case- and accent-insensitively. */
export const requestPhrases: readonly string[] = [
  'let me know',
  'can you',
  'could you',
  'would you',
  'please confirm',
  'please advise',
  'please send',
  'please review',
  'please let',
  'any update',
  'any news',
  'when can',
  'when could',
  'when will you',
  'thanks in advance',
  'thank you in advance',
  'looking forward to hearing',
  'pouvez-vous',
  'pourriez-vous',
  'peux-tu',
  'pourrais-tu',
  'merci de confirmer',
  'merci de me',
  'tenez-moi au courant',
  'tiens-moi au courant',
  "merci d'avance",
  "d'avance merci",
  "j'attends votre retour",
  "dans l'attente de votre retour",
  "qu'en pensez-vous",
  'des nouvelles',
]

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A hyphen or space in a phrase matches either ("pouvez vous", "peux-tu").
const phraseRes = requestPhrases.map(
  (p) => new RegExp(`(?<![a-z0-9])${escapeRe(fold(p)).replace(/[ -]/g, '[\\s-]+')}(?![a-z0-9])`),
)
const hasPhrase = (text: string): boolean => {
  const folded = fold(text)
  return phraseRes.some((re) => re.test(folded))
}

const isRule = (line: string): boolean => /^_{8,}\s*$/.test(line.trim())
const isHeader = (line: string): boolean => /^(from|de)\s?:/i.test(line.trim())
const isSignatureDelimiter = (line: string): boolean => /^--\s*$/.test(line)
const closingLine =
  /^(?:(?:thanks|thank you|merci|cheers|best|regards|cordialement|bonne journee)\b[\s,.!;:-]*)+$/

function isAttribution(lines: string[], i: number): boolean {
  const line = fold(lines[i].trim())
  if (/^-{3,}\s*(original message|forwarded message|message d'origine)\s*-{3,}$/.test(line))
    return true
  if (isRule(line)) {
    const next = lines.slice(i + 1).find((l) => l.trim() !== '')
    return next !== undefined && isHeader(next)
  }
  // The attribution may wrap over two lines.
  const joined = `${line} ${fold((lines[i + 1] ?? '').trim())}`
  const on = /^on\s.+\swrote:$/
  const le = /^le\s.+\sa\secrit\s?:$/
  return (
    on.test(line) ||
    le.test(line) ||
    (/^(on|le)\s/.test(line) && (on.test(joined) || le.test(joined)))
  )
}

/** What follows a closing looks like a name: a couple of short lines that ask for nothing. */
const isNameBlock = (rest: string[]): boolean =>
  rest.length <= 2 && rest.every((l) => l.trim().length <= 40 && !l.includes('?') && !hasPhrase(l))

/** The sender's own words in a plain-text body: no quoted reply, signature or plain closing. */
export function ownText(text: string): string {
  let lines = text.split(/\r?\n/)
  const marker = lines.findIndex((_, i) => isAttribution(lines, i))
  if (marker >= 0) lines = lines.slice(0, marker)
  lines = lines.filter((l) => !l.startsWith('>'))
  const sig = lines.findIndex(isSignatureDelimiter)
  if (sig >= 0) lines = lines.slice(0, sig)

  // A plain closing sits near the end, followed only by a name block.
  const filled = lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim() !== '')
  const closing = filled
    .slice(-3)
    .find(
      (x) =>
        closingLine.test(fold(x.l.trim())) &&
        isNameBlock(filled.slice(filled.indexOf(x) + 1).map((y) => y.l)),
    )
  if (closing) lines = lines.slice(0, closing.i)
  return lines.join('\n').trim()
}

/** Whether a message asks the reader for something: a question mark, or a request phrase. */
export function askCheck(text: string): { asks: boolean; reason?: 'question' | 'phrase' } {
  const own = ownText(text)
  // A "?" in a link is not a question.
  if (own.replace(/(?:https?:\/\/|www\.)\S+/gi, '').includes('?'))
    return { asks: true, reason: 'question' }
  if (hasPhrase(own)) return { asks: true, reason: 'phrase' }
  return { asks: false }
}
