import { describe, it, expect } from 'vitest'
import type { Account } from '@inlark/core'
import {
  defaultSettings,
  domainKey,
  inboxExport,
  mergeInboxImport,
  parseInboxExport,
  isAutomatedAddress,
  isAutomatedMessage,
  ownAddresses,
  parseRule,
  parseRuleLines,
  querySchema,
  refusalReason,
  resolveSplitScope,
  ruleMatches,
  settingsSchema,
} from '@inlark/core'

const own = ['me@work.example', 'me@gmail.com']

describe('split rules', () => {
  it('lists every address the user receives mail as, once', () => {
    const accounts = [
      { email: ' Me@Work.example ', aliases: [{ email: 'Team@work.example' }] },
      { email: 'me@gmail.com' },
      { email: 'me@work.example', aliases: [{ email: 'team@WORK.example' }] },
    ] as Account[]
    expect(ownAddresses(accounts)).toEqual(['me@work.example', 'team@work.example', 'me@gmail.com'])
  })

  it('parses addresses and domains', () => {
    expect(parseRule('  Client.Person@Gmail.COM ')).toEqual({
      kind: 'address',
      value: 'client.person@gmail.com',
    })
    expect(parseRule('<k@client.example>')).toEqual({ kind: 'address', value: 'k@client.example' })
    expect(parseRule('@Client.Example.')).toEqual({
      kind: 'domain',
      value: 'client.example',
    })
    expect(parseRule('client.example')).toEqual({
      kind: 'domain',
      value: 'client.example',
    })
    expect(parseRule('hello')).toBeUndefined()
    expect(parseRule('a@')).toBeUndefined()
  })
  it('reports problems line by line', () => {
    const r = parseRuleLines(
      'client.person@gmail.com\n\n@work.example\nhello\nCLIENT.PERSON@gmail.com',
      own,
    )
    expect(r.rules).toEqual(['client.person@gmail.com'])
    expect(r.problems.map((p) => p.line)).toEqual([3, 4])
  })
  it('refuses own addresses and domains but allows free-mail clients', () => {
    expect(refusalReason(parseRule('me@work.example')!, own)).toMatch(/your own address/)
    expect(refusalReason(parseRule('ana@work.example')!, own)).toMatch(/own domain/)
    expect(refusalReason(parseRule('@eu.work.example')!, own)).toMatch(/own domain/)
    expect(refusalReason(parseRule('@gmail.com')!, own)).toMatch(/includes your own address/)
    expect(refusalReason(parseRule('client.person@gmail.com')!, own)).toBeUndefined()
  })
  it('matches domains and subdomains only', () => {
    const d = parseRule('@github.com')!
    expect(ruleMatches(d, 'x@github.com')).toBe(true)
    expect(ruleMatches(d, 'x@noreply.GitHub.com')).toBe(true)
    expect(ruleMatches(d, 'x@notgithub.com')).toBe(false)
    expect(domainKey('mail.Client.example')).toBe('example.client.mail')
  })
  it('detects automated senders', () => {
    for (const e of [
      'no-reply@asana.com',
      'no_reply@x.com',
      'do.not.reply@x.com',
      'bounces+1@x.com',
      'MAILER-DAEMON@x.com',
      'postmaster@x.com',
    ])
      expect(isAutomatedAddress(e)).toBe(true)
    expect(isAutomatedAddress('client.person@gmail.com')).toBe(false)
    expect(isAutomatedMessage({ fromEmail: 'a@b.com', listId: '<list.b.com>' })).toBe(true)
    expect(isAutomatedMessage({ fromEmail: 'a@b.com', precedence: 'Bulk' })).toBe(true)
    expect(isAutomatedMessage({ fromEmail: 'a@b.com', autoSubmitted: 'no' })).toBe(false)
    expect(isAutomatedMessage({ fromEmail: 'a@b.com', autoSubmitted: 'auto-generated' })).toBe(true)
    expect(
      isAutomatedMessage({ fromEmail: 'a@b.com', unsubscribe: { url: 'x', oneClick: false } }),
    ).toBe(true)
    expect(isAutomatedMessage({ fromEmail: 'a@b.com' })).toBe(false)
  })
  it('resolves tabs from settings', () => {
    const settings = {
      ...defaultSettings,
      splitTabs: [
        {
          id: 't1',
          name: 'Client A',
          rules: ['Client.Person@gmail.com', '@work.example', '@Client.example'],
        },
      ],
      important: {
        always: [{ address: 'Alerts@X.com', words: [' Crash ', ''] }],
        never: ['Bot@Y.com'],
      },
    }
    expect(resolveSplitScope(undefined, settings, own)).toBeUndefined()
    expect(resolveSplitScope('inbox', settings, own)).toBeUndefined()
    expect(resolveSplitScope('gone', settings, own)).toBeNull()
    expect(resolveSplitScope('t1', settings, own)).toEqual({
      kind: 'rules',
      addresses: ['client.person@gmail.com'],
      domains: ['example.client'],
    })
    expect(resolveSplitScope('important', settings, own)).toEqual({
      kind: 'important',
      always: [{ address: 'alerts@x.com', words: ['crash'] }],
      never: ['bot@y.com'],
    })
  })
  it('keeps the new settings and query fields through the schemas', () => {
    expect(querySchema.parse({ view: 'inbox', tab: 'important' }).tab).toBe('important')
    const parsed = settingsSchema.parse({
      ...defaultSettings,
      splitTabs: [{ id: 't', name: 'A', rules: ['@a.com'] }],
      important: { always: [], never: [] },
    })
    expect(parsed.splitTabs).toHaveLength(1)
    expect(parsed.important).toEqual({ always: [], never: [] })
  })
})

describe('inbox export and import', () => {
  const settings = {
    ...defaultSettings,
    theme: 'light' as const,
    signatures: { a: 'Private signature' },
    splitTabs: [
      { id: 't1', name: 'Client A', rules: ['@client.example', 'lee@partner.example'] },
      { id: 't2', name: 'Tools', rules: ['notifications@tools.example'] },
    ],
    important: {
      always: [
        { address: 'alerts@x.example', words: ['crash', 'failure'] },
        { address: 'b@x.example' },
      ],
      never: ['bot@y.example'],
    },
  }

  it('writes only tabs and Important lists, in the design’s format', () => {
    expect(inboxExport(settings)).toEqual({
      version: 1,
      tabs: [
        { name: 'Client A', rules: ['@client.example', 'lee@partner.example'] },
        { name: 'Tools', rules: ['notifications@tools.example'] },
      ],
      important: {
        always: [
          { sender: 'alerts@x.example', subjectWords: ['crash', 'failure'] },
          { sender: 'b@x.example' },
        ],
        never: ['bot@y.example'],
      },
    })
    expect(inboxExport(defaultSettings)).toEqual({
      version: 1,
      tabs: [],
      important: { always: [], never: [] },
    })
  })

  it('reads back what it writes', () => {
    const file = inboxExport(settings)
    expect(parseInboxExport(JSON.stringify(file, null, 2))).toEqual(file)
    expect(parseInboxExport('﻿' + JSON.stringify(file))).toEqual(file)
  })

  it('reads the design’s example file', () => {
    const text = JSON.stringify({
      version: 1,
      tabs: [
        { name: 'GitHub', rules: ['notifications@github.example', '@noreply.github.example'] },
      ],
      important: {
        always: [{ sender: 'alerts@example.com', subjectWords: ['crash'] }],
        never: [],
      },
    })
    expect(parseInboxExport(text).tabs[0]!.rules).toHaveLength(2)
    expect(parseInboxExport(text).important.always).toEqual([
      { sender: 'alerts@example.com', subjectWords: ['crash'] },
    ])
  })

  it('refuses anything that isn’t an export', () => {
    const refused = 'This file isn’t a Warpmail inbox export.'
    const ok = { version: 1, tabs: [], important: { always: [], never: [] } }
    for (const text of [
      '',
      'not json',
      '{',
      'null',
      '[]',
      '"text"',
      '{}',
      JSON.stringify({ ...ok, version: 2 }),
      JSON.stringify({ ...ok, version: '1' }),
      JSON.stringify({ ...ok, tabs: 'x' }),
      JSON.stringify({ ...ok, tabs: [{ name: '', rules: [] }] }),
      JSON.stringify({ ...ok, tabs: [{ name: 'x'.repeat(61), rules: [] }] }),
      JSON.stringify({ ...ok, tabs: [{ name: 'A', rules: [5] }] }),
      JSON.stringify({ ...ok, tabs: [{ name: 'A', rules: ['x'.repeat(321)] }] }),
      JSON.stringify({ ...ok, tabs: [{ name: 'A', rules: Array(501).fill('@a.example') }] }),
      JSON.stringify({ ...ok, tabs: Array(51).fill({ name: 'A', rules: [] }) }),
      JSON.stringify({ ...ok, important: { always: [{ sender: 1 }], never: [] } }),
      JSON.stringify({
        ...ok,
        important: {
          always: [{ sender: 'a@b.example', subjectWords: Array(21).fill('w') }],
          never: [],
        },
      }),
      JSON.stringify({ ...ok, important: { always: [], never: Array(501).fill('a@b.example') } }),
    ])
      expect(() => parseInboxExport(text), text.slice(0, 60)).toThrow(refused)
  })

  it('keeps only known fields, so a file can’t carry ids or other settings', () => {
    const parsed = parseInboxExport(
      JSON.stringify({
        version: 1,
        theme: 'light',
        tabs: [{ id: 'inbox', name: 'A', rules: [], extra: true }],
        important: { always: [], never: [], other: 1 },
      }),
    )
    expect(parsed).toEqual({
      version: 1,
      tabs: [{ name: 'A', rules: [] }],
      important: { always: [], never: [] },
    })
  })

  const file = (
    tabs: { name: string; rules: string[] }[],
    important = { always: [], never: [] } as any,
  ) => ({ version: 1 as const, tabs, important })
  let n = 0
  const newId = () => 'new' + ++n

  it('adds new tabs with fresh ids and merges rules into a tab of the same name', () => {
    n = 0
    const result = mergeInboxImport(
      settings,
      file([
        { name: ' client a ', rules: ['@CLIENT.example', 'ceo@client2.example', 'not a rule'] },
        { name: 'Projects', rules: ['@p.example', '@P.example'] },
        { name: 'Inbox', rules: ['@x.example'] },
        { name: 'Projects', rules: ['@q.example'] },
      ]),
      own,
      newId,
    )
    expect(result.splitTabs).toEqual([
      {
        id: 't1',
        name: 'Client A',
        rules: ['@client.example', 'lee@partner.example', 'ceo@client2.example'],
      },
      { id: 't2', name: 'Tools', rules: ['notifications@tools.example'] },
      { id: 'new1', name: 'Projects', rules: ['@p.example', '@q.example'] },
    ])
    expect(result).toMatchObject({ newTabs: 1, updatedTabs: 1, senders: 0 })
    // "not a rule" and the tab called Inbox, which can never be shown.
    expect(result.skipped).toBe(2)
    expect(result.important).toEqual(settings.important)
  })

  it('never takes an id from the file and never deletes anything', () => {
    n = 0
    const result = mergeInboxImport(settings, file([]), own, newId)
    expect(result.splitTabs).toEqual(settings.splitTabs)
    expect(result.important).toEqual(settings.important)
    expect(result).toMatchObject({ newTabs: 0, updatedTabs: 0, senders: 0, skipped: 0 })
  })

  it('keeps own addresses and domains out, as the editor does', () => {
    n = 0
    const result = mergeInboxImport(
      { splitTabs: [] },
      file([{ name: 'Mixed', rules: ['me@work.example', '@work.example', '@client.example'] }]),
      own,
      newId,
    )
    expect(result.splitTabs).toEqual([{ id: 'new1', name: 'Mixed', rules: ['@client.example'] }])
    expect(result.skipped).toBe(2)
  })

  it('stops at the tab and rule limits and counts what didn’t fit', () => {
    n = 0
    const full = Array.from({ length: 50 }, (_, i) => ({ id: 'id' + i, name: 'T' + i, rules: [] }))
    const result = mergeInboxImport(
      { splitTabs: full },
      file([{ name: 'One more', rules: [] }]),
      own,
      newId,
    )
    expect(result.splitTabs).toHaveLength(50)
    expect(result.skipped).toBe(1)
    const big = [
      { id: 'b', name: 'Big', rules: Array.from({ length: 499 }, (_, i) => `p${i}@a.example`) },
    ]
    const more = mergeInboxImport(
      { splitTabs: big },
      file([{ name: 'big', rules: ['x@a.example', 'y@a.example', 'z@a.example'] }]),
      own,
      newId,
    )
    expect(more.splitTabs[0]!.rules).toHaveLength(500)
    expect(more.splitTabs[0]!.rules.at(-1)).toBe('x@a.example')
    expect(more).toMatchObject({ updatedTabs: 1, skipped: 2 })
  })

  it('merges Important senders, skipping ones that conflict with this computer’s lists', () => {
    const result = mergeInboxImport(
      settings,
      file([], {
        always: [
          // Words join the existing words.
          { sender: 'Alerts@X.example', subjectWords: ['Failure', 'outage'] },
          // Already always shown, without words: stays that way.
          { sender: 'b@x.example', subjectWords: ['only'] },
          // On Never here: skipped.
          { sender: 'bot@y.example' },
          { sender: 'new@z.example', subjectWords: [' Deploy ', ''] },
          { sender: 'not an address' },
        ],
        never: ['B@x.example', 'spam@z.example', 'bot@y.example', '@domain.example'],
      }),
      own,
      newId,
    )
    expect(result.important).toEqual({
      always: [
        { address: 'alerts@x.example', words: ['crash', 'failure', 'outage'] },
        { address: 'b@x.example' },
        { address: 'new@z.example', words: ['deploy'] },
      ],
      never: ['bot@y.example', 'spam@z.example'],
    })
    // Changed alerts@, added new@ and spam@.
    expect(result.senders).toBe(3)
    // bot@ on Always, not an address, B@ on Never, @domain on Never.
    expect(result.skipped).toBe(4)
  })

  it('an Always entry without words wins over one with words', () => {
    const result = mergeInboxImport(
      { important: { always: [{ address: 'a@x.example', words: ['crash'] }], never: [] } },
      file([], { always: [{ sender: 'a@x.example' }], never: [] }),
      own,
      newId,
    )
    expect(result.important.always).toEqual([{ address: 'a@x.example' }])
    expect(result.senders).toBe(1)
  })
})
