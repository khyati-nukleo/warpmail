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
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[‘’]/g, "'")

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const phraseRes = requestPhrases.map(
  (p) => new RegExp(`(?<![a-z0-9])${escapeRe(fold(p)).replace(/ /g, '\\s+')}(?![a-z0-9])`),
)

const isRule = (line: string): boolean => /^_{8,}\s*$/.test(line.trim())
const isHeader = (line: string): boolean => /^(from|de)\s?:/i.test(line.trim())
const isSignatureDelimiter = (line: string): boolean => /^--\s*$/.test(line)
const closingLine =
  /^(?:(?:thanks|thank you|merci|cheers|best|regards|cordialement|bonne journee)\b[\s,.!;:-]*)+$/

function isAttribution(lines: string[], i: number): boolean {
  const line = lines[i].trim()
  if (/^-{3,}\s*(original message|forwarded message)\s*-{3,}$/i.test(line)) return true
  if (isRule(line)) {
    const next = lines.slice(i + 1).find((l) => l.trim() !== '')
    return next !== undefined && isHeader(next)
  }
  // The attribution may wrap over two lines.
  const joined = `${line} ${(lines[i + 1] ?? '').trim()}`
  const on = /^On\s.+\swrote:$/i
  const le = /^Le\s.+\sa [eé]crit\s?:$/i
  return (
    on.test(line) ||
    le.test(line) ||
    (/^(On|Le)\s/i.test(line) && (on.test(joined) || le.test(joined)))
  )
}

/** The sender's own words in a plain-text body: no quoted reply, signature or plain closing. */
export function ownText(text: string): string {
  let lines = text.split(/\r?\n/)
  const marker = lines.findIndex((_, i) => isAttribution(lines, i))
  if (marker >= 0) lines = lines.slice(0, marker)
  lines = lines.filter((l) => !l.startsWith('>'))
  const sig = lines.findIndex(isSignatureDelimiter)
  if (sig >= 0) lines = lines.slice(0, sig)

  // A plain closing sits within the last few non-empty lines (closing word, then the name).
  const filled = lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim() !== '')
  const tail = filled.slice(-3)
  const closing = tail.find((x) => closingLine.test(fold(x.l.trim())))
  if (closing) lines = lines.slice(0, closing.i)
  return lines.join('\n').trim()
}

/** Whether a message asks the reader for something: a question mark, or a request phrase. */
export function askCheck(text: string): { asks: boolean; reason?: 'question' | 'phrase' } {
  const own = ownText(text)
  if (own.includes('?')) return { asks: true, reason: 'question' }
  const folded = fold(own)
  if (phraseRes.some((re) => re.test(folded))) return { asks: true, reason: 'phrase' }
  return { asks: false }
}
