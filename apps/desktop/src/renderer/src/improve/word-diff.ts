/** One stretch of a word diff: unchanged, only in the new text, or only in the old text. */
export type DiffPart = { kind: 'same' | 'added' | 'removed'; text: string }

/** Past this many token pairs the comparison gets too heavy, so the whole text is shown as replaced. */
const maxCells = 4_000_000

/** Splits text into alternating runs of whitespace and non-whitespace. */
function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? []
}

const isSpace = (token: string): boolean => /^\s/.test(token)

/** Two tokens match when they are the same word, or both whitespace (of any kind). */
const matches = (a: string, b: string): boolean => a === b || (isSpace(a) && isSpace(b))

/** Appends a part, joining it to the previous one when they are the same kind. */
function push(parts: DiffPart[], kind: DiffPart['kind'], text: string): void {
  if (!text) return
  const last = parts[parts.length - 1]
  if (last && last.kind === kind) last.text += text
  else parts.push({ kind, text })
}

/**
 * Compares two texts word by word. Words and the whitespace between them are
 * separate tokens, matched with a longest-common-subsequence pass. Whitespace
 * that differs only in spacing (a newline for a space) counts as unchanged and
 * shows the new text's spacing. Very large inputs skip the comparison and come
 * back as one removal plus one addition.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length * b.length > maxCells) {
    const whole: DiffPart[] = []
    push(whole, 'removed', before)
    push(whole, 'added', after)
    return whole
  }

  // table[i * width + j] = length of the longest common run of a[i..] and b[j..]
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = matches(a[i], b[j])
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }

  const parts: DiffPart[] = []
  let removed = ''
  let added = ''
  const flush = (): void => {
    push(parts, 'removed', removed)
    push(parts, 'added', added)
    removed = ''
    added = ''
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (matches(a[i], b[j])) {
      flush()
      push(parts, 'same', b[j])
      i++
      j++
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      removed += a[i++]
    } else {
      added += b[j++]
    }
  }
  while (i < a.length) removed += a[i++]
  while (j < b.length) added += b[j++]
  flush()
  return parts
}
