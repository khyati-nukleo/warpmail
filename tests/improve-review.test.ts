import { describe, expect, it } from 'vitest'
import { changedFacts } from '../apps/desktop/src/renderer/src/improve/changed-facts'
import { wordDiff, type DiffPart } from '../apps/desktop/src/renderer/src/improve/word-diff'

const before =
  'Hi Sam,\n\nThe invoice for $1,200 is due on November 6. Send it to billing@example.com.\n\nThanks,'

const join = (parts: DiffPart[], ...kinds: DiffPart['kind'][]): string =>
  parts
    .filter((p) => kinds.includes(p.kind))
    .map((p) => p.text)
    .join('')

describe('changedFacts', () => {
  it('passes a faithful rewrite', () => {
    const after =
      'Hi Sam,\n\nThe $1,200 invoice is due on November 6. Please send it to billing@example.com.\n\nThanks,'
    expect(changedFacts(before, after)).toEqual([])
  })

  it('flags a changed number, date and address', () => {
    const after =
      'Hi Sam,\n\nThe $1,500 invoice is due on November 7. Please send it to bill@example.com.\n\nThanks,'
    const result = changedFacts(before, after)
    expect(result).toContainEqual({ kind: 'number', value: '$1,200', change: 'missing' })
    expect(result).toContainEqual({ kind: 'number', value: '$1,500', change: 'added' })
    expect(result).toContainEqual({ kind: 'date', value: 'November 6', change: 'missing' })
    expect(result).toContainEqual({ kind: 'date', value: 'November 7', change: 'added' })
    expect(result).toContainEqual({
      kind: 'email',
      value: 'billing@example.com',
      change: 'missing',
    })
    expect(result).toContainEqual({ kind: 'email', value: 'bill@example.com', change: 'added' })
  })

  it('flags a missing link and a missing name', () => {
    const result = changedFacts(
      'Hi Priya, Sam and Lee can join at https://example.com/meet.',
      'Hi Priya, everyone can join at the link.',
    )
    expect(result).toContainEqual({ kind: 'name', value: 'Sam', change: 'missing' })
    expect(result).toContainEqual({ kind: 'name', value: 'Lee', change: 'missing' })
    expect(result).toContainEqual({
      kind: 'link',
      value: 'https://example.com/meet',
      change: 'missing',
    })
    expect(result.find((f) => f.value === 'Priya')).toBeUndefined()
  })

  it('does not treat sentence starts as names', () => {
    const result = changedFacts('Thanks for this. Could we talk?', 'Thank you. Can we talk?')
    expect(result.filter((f) => f.kind === 'name')).toEqual([])
  })

  it('counts a sentence-initial word as a name when it also appears mid-sentence', () => {
    const result = changedFacts('Priya will call. Please ask Priya.', 'Please call the team.')
    expect(result).toContainEqual({ kind: 'name', value: 'Priya', change: 'missing' })
  })

  it('flags times and percentages', () => {
    const result = changedFacts('Call at 3pm, 15% off', 'Call at 4pm, 15% off')
    expect(result).toEqual([
      { kind: 'number', value: '3pm', change: 'missing' },
      { kind: 'number', value: '4pm', change: 'added' },
    ])
  })

  it('flags an added name only when the word is new', () => {
    const result = changedFacts('Ask sam about it.', 'Ask Sam and Dana about it.')
    expect(result).toEqual([{ kind: 'name', value: 'Dana', change: 'added' }])
  })

  it('does not read a name, number or date inside an email or link', () => {
    const text = 'Write to Dana.Lee2@example.com or see www.example.com/Mon-5.'
    const result = changedFacts(text, text)
    expect(result).toEqual([])
  })

  it('removes duplicates and keeps the order of appearance', () => {
    const result = changedFacts('Pay 5 now, 9 later, 5 again.', 'Done.')
    expect(result.map((f) => f.value)).toEqual(['5', '9'])
  })

  it('treats weekdays and relative days as dates', () => {
    const result = changedFacts('See you Monday or tomorrow.', 'See you soon.')
    expect(result).toEqual([
      { kind: 'date', value: 'Monday', change: 'missing' },
      { kind: 'date', value: 'tomorrow', change: 'missing' },
    ])
  })
})

describe('changedFacts false alarms', () => {
  const names = (a: string, b: string) => changedFacts(a, b).filter((f) => f.kind === 'name')

  it('treats words after a colon, quote, bracket or dash as sentence starts', () => {
    expect(names('Quick question: Can you send it?', 'Quick question: Could you send it?')).toEqual(
      [],
    )
    expect(names('Note: Please reply. "Thanks" he said.', 'Note: reply soon, he said.')).toEqual([])
    expect(names('Done (Finally) today.', 'Done today.')).toEqual([])
    expect(names('Done - Finally, it works.', 'It works.')).toEqual([])
    expect(names('Done \u2014 Finally it works.', 'It works.')).toEqual([])
  })

  it('still reads a name after a title abbreviation', () => {
    expect(names('Please ask Dr. Smith about it.', 'Please ask the doctor.')).toEqual([
      { kind: 'name', value: 'Smith', change: 'missing' },
    ])
    expect(names('We met. Dr. Smith agreed.', 'We met and agreed.')).toEqual([
      { kind: 'name', value: 'Smith', change: 'missing' },
    ])
  })

  it('ignores spacing, case and ordinal suffixes', () => {
    expect(changedFacts('Call at 3 pm', 'Call at 3pm')).toEqual([])
    expect(changedFacts('Call at 3 PM', 'Call at 3pm')).toEqual([])
    expect(changedFacts('Call at 3:30 pm', 'Call at 3:30pm')).toEqual([])
    expect(changedFacts('Due March 3rd.', 'Due March 3.')).toEqual([])
    expect(changedFacts('Call at 3pm', 'Call at 4pm')).toHaveLength(2)
  })

  it('reads May as a date only with a day or year', () => {
    expect(changedFacts('May I join the call?', 'Can I join the call?')).toEqual([])
    expect(changedFacts('See you on May 6', 'See you on May 7')).toEqual([
      { kind: 'date', value: 'May 6', change: 'missing' },
      { kind: 'date', value: 'May 7', change: 'added' },
    ])
    expect(changedFacts('Due 6 May.', 'Due soon.')).toEqual([
      { kind: 'date', value: '6 May', change: 'missing' },
    ])
  })
})

describe('wordDiff', () => {
  it('diffs word by word', () => {
    const a = 'The report is ready'
    const b = 'The final report is ready now'
    const parts = wordDiff(a, b)
    expect(parts).toEqual([
      { kind: 'same', text: 'The ' },
      { kind: 'added', text: 'final ' },
      { kind: 'same', text: 'report is ready' },
      { kind: 'added', text: ' now' },
    ])
    expect(join(parts, 'same', 'added')).toBe(b)
    expect(join(parts, 'same', 'removed')).toBe(a)
  })

  it('keeps both texts recoverable from any diff', () => {
    const pairs: [string, string][] = [
      ['Hi Sam,\n\nCan we meet on Friday?', 'Hi Sam,\n\nCould we meet Friday morning?'],
      ['one two three four', 'four three two one'],
      ['- apples\n- pears\n\nThanks', '- pears\n- apples\n\nThanks a lot'],
    ]
    for (const [a, b] of pairs) {
      const parts = wordDiff(a, b)
      expect(join(parts, 'same', 'removed')).toBe(a)
      expect(join(parts, 'same', 'added')).toBe(b)
    }
  })

  it('merges adjacent parts of the same kind', () => {
    const parts = wordDiff('a b c d', 'a x y d')
    for (let i = 1; i < parts.length; i++) expect(parts[i].kind).not.toBe(parts[i - 1].kind)
  })

  it('counts a whitespace-only change between equal words as the same', () => {
    expect(wordDiff('Hello  world', 'Hello\nworld')).toEqual([
      { kind: 'same', text: 'Hello\nworld' },
    ])
  })

  it('handles empty texts', () => {
    expect(wordDiff('', '')).toEqual([])
    expect(wordDiff('', 'new')).toEqual([{ kind: 'added', text: 'new' }])
    expect(wordDiff('old', '')).toEqual([{ kind: 'removed', text: 'old' }])
  })

  it('falls back to a whole replacement for huge texts', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join(' ')
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join(' ')
    expect(wordDiff(a, b)).toEqual([
      { kind: 'removed', text: a },
      { kind: 'added', text: b },
    ])
  })
})
