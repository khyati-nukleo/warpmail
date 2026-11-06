import { describe, expect, it } from 'vitest'
import { suggestRules, suggestionTerm, type AddressSeen } from '@inlark/core'
import {
  completeRuleLine,
  ruleLineAt,
  shownProblems,
} from '../apps/desktop/src/renderer/src/split/tab-model'

const seen: AddressSeen[] = [
  { email: 'lee@client.example', name: 'Lee Park', count: 9 },
  { email: 'sam@mail.client.example', name: 'Sam Ortiz', count: 4 },
  { email: 'ops@clientele.example', count: 2 },
  { email: 'noreply@client.example', count: 30 },
  { email: 'friend@gmail.com', name: 'Robin', count: 5 },
  { email: 'boss@work.example', name: 'Kim Lee', count: 7 },
  { email: 'me@work.example', name: 'Me', count: 50 },
]
const own = ['me@work.example']

describe('rule suggestions', () => {
  it('suggests domains for an @ prefix, most mail first', () => {
    // Domains count every address on them, automated ones included.
    expect(suggestRules('@cli', seen, own).map((s) => s.rule)).toEqual([
      '@client.example',
      '@clientele.example',
    ])
  })

  it('offers the domain from the label typed, so subdomains roll up', () => {
    expect(suggestRules('@mail', seen, own).map((s) => s.rule)).toEqual(['@mail.client.example'])
    expect(suggestRules('@client.ex', seen, own).map((s) => s.rule)).toEqual(['@client.example'])
  })

  it('never suggests a bare top-level label, free mail, or the own domain', () => {
    expect(suggestRules('@exam', seen, own)).toEqual([])
    expect(suggestRules('@gmail', seen, own)).toEqual([])
    expect(suggestRules('@work', seen, own)).toEqual([])
  })

  it('lists the most mailed domains for a lone @, folding subdomains into their parent', () => {
    expect(suggestRules('@', seen, own).map((s) => s.rule)).toEqual([
      '@client.example',
      '@clientele.example',
    ])
  })

  it('suggests people by address, name word or domain label', () => {
    // Kim Lee is on the own domain, which a rule may not match.
    expect(suggestRules('lee', seen, own).map((s) => s.rule)).toEqual(['lee@client.example'])
    expect(suggestRules('ort', seen, own)).toEqual([
      { rule: 'sam@mail.client.example', name: 'Sam Ortiz' },
    ])
    expect(suggestRules('client', seen, own).map((s) => s.rule)).toEqual([
      'lee@client.example',
      'sam@mail.client.example',
      'ops@clientele.example',
    ])
  })

  it('leaves out automated senders and the own address from people', () => {
    expect(suggestRules('noreply', seen, own)).toEqual([])
    expect(suggestRules('me', seen, own)).toEqual([])
  })

  it('leaves out rules already in the box and stops at the limit', () => {
    expect(
      suggestRules('@cli', seen, own, { exclude: ['@client.example'] }).map((s) => s.rule),
    ).toEqual(['@clientele.example'])
    expect(suggestRules('@', seen, own, { limit: 1 })).toHaveLength(1)
  })

  it('never offers a country or province suffix as a domain', () => {
    const regional: AddressSeen[] = [
      { email: 'a@firm.qc.ca', count: 3 },
      { email: 'b@shop.co.uk', count: 2 },
      { email: 'c@store.com.au', count: 1 },
    ]
    expect(suggestRules('@qc', regional, own)).toEqual([])
    expect(suggestRules('@co', regional, own)).toEqual([])
    expect(suggestRules('@com', regional, own)).toEqual([])
    expect(suggestRules('@firm', regional, own).map((s) => s.rule)).toEqual(['@firm.qc.ca'])
    expect(suggestRules('@', regional, own).map((s) => s.rule)).toEqual([
      '@firm.qc.ca',
      '@shop.co.uk',
      '@store.com.au',
    ])
  })

  it('offers only addresses and domains the box accepts', () => {
    const odd: AddressSeen[] = [
      { email: 'a@b@client.example', count: 9 },
      { email: 'x y@client.example', count: 8 },
      { email: 'ok@client.example', count: 1 },
    ]
    expect(suggestRules('a', odd, own)).toEqual([])
    expect(suggestRules('ok', odd, own)).toEqual([{ rule: 'ok@client.example' }])
  })

  it('leaves out what a domain already in the box covers', () => {
    const exclude = ['@client.example']
    expect(suggestRules('lee', seen, own, { exclude })).toEqual([])
    expect(suggestRules('@mail', seen, own, { exclude })).toEqual([])
    expect(suggestRules('@cli', seen, own, { exclude }).map((s) => s.rule)).toEqual([
      '@clientele.example',
    ])
  })

  it('suggests nothing for an empty line or text with spaces', () => {
    expect(suggestRules('', seen, own)).toEqual([])
    expect(suggestRules('   ', seen, own)).toEqual([])
    expect(suggestRules('lee park', seen, own)).toEqual([])
  })

  it('narrows the index search by what follows the @', () => {
    expect(suggestionTerm('@Cli')).toBe('cli')
    expect(suggestionTerm('  Lee ')).toBe('lee')
    expect(suggestionTerm('@')).toBe('')
    expect(suggestionTerm('a b')).toBeUndefined()
    expect(suggestionTerm('')).toBeUndefined()
  })
})

describe('the rules box line being typed', () => {
  it('finds the line around the caret', () => {
    const text = 'lee@client.example\n@cli\nlast'
    expect(ruleLineAt(text, 23)).toEqual({ start: 19, end: 23, text: '@cli' })
    expect(ruleLineAt(text, 0)).toEqual({ start: 0, end: 18, text: 'lee@client.example' })
    expect(ruleLineAt('', 0)).toEqual({ start: 0, end: 0, text: '' })
  })

  it('replaces only that line and puts the caret after the rule', () => {
    const text = 'lee@client.example\n@cli\nlast'
    expect(completeRuleLine(text, 21, '@client.example')).toEqual({
      text: 'lee@client.example\n@client.example\nlast',
      caret: 34,
    })
    // The last line gains a new line so the next rule can be typed straight away.
    expect(completeRuleLine('@cli', 4, '@client.example')).toEqual({
      text: '@client.example\n',
      caret: 16,
    })
  })

  it('waits for the line being typed to be finished before calling it unreadable', () => {
    const problems = [
      { line: 1, text: 'len', reason: 'len is not an address or a domain.' },
      { line: 2, text: '@work.example', reason: 'own domain' },
      { line: 3, text: 'sam', reason: 'sam is not an address or a domain.' },
    ]
    expect(shownProblems(problems, 1).map((p) => p.line)).toEqual([2, 3])
    // A refused rule says why straight away.
    expect(shownProblems(problems, 2).map((p) => p.line)).toEqual([1, 2, 3])
    expect(shownProblems(problems, undefined)).toEqual(problems)
  })
})
