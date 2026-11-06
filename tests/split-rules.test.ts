import { describe, it, expect } from 'vitest'
import {
  defaultSettings,
  domainKey,
  isAutomatedAddress,
  isAutomatedMessage,
  parseRule,
  parseRuleLines,
  querySchema,
  refusalReason,
  resolveSplitScope,
  ruleMatches,
  settingsSchema,
  superhumanTabs,
} from '@inlark/core'

const own = ['me@work.example', 'me@gmail.com']

describe('split rules', () => {
  it('parses addresses and domains', () => {
    expect(parseRule('  someone@Gmail.COM ')).toEqual({ kind: 'address', value: 'someone@gmail.com' })
    expect(parseRule('<k@clientc.example>')).toEqual({ kind: 'address', value: 'k@clientc.example' })
    expect(parseRule('@client.example.')).toEqual({
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
    const r = parseRuleLines('someone@gmail.com\n\n@work.example\nhello\nsomeone@gmail.com', own)
    expect(r.rules).toEqual(['someone@gmail.com'])
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
    expect(domainKey('mail.clientb.example')).toBe('example.clientb.mail')
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
    expect(isAutomatedAddress('someone@gmail.com')).toBe(false)
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
        { id: 't1', name: 'Client A', rules: ['someone@gmail.com', '@work.example', '@clientc.example'] },
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
      addresses: ['someone@gmail.com'],
      domains: ['example.clientc'],
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
      splitImportOffered: true,
    })
    expect(parsed.splitTabs).toHaveLength(1)
    expect(parsed.splitImportOffered).toBe(true)
  })
  it('builds the Superhuman tabs', () => {
    expect(superhumanTabs().map((t) => [t.name, t.rules])).toEqual([
      ['Client A', ['client.person@gmail.com', 'k@clientc.example']],
      ['Client B', ['@client.example']],
      ['GitHub', ['notifications@github.com', '@noreply.github.com']],
      ['Asana', ['no-reply@asana.com']],
    ])
  })
})
