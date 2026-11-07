import { describe, expect, it } from 'vitest'
import {
  conversationOpened,
  countOpens,
  recipientStatus,
  replyTimes,
  type FetchRecord,
} from '../packages/core/src/read-status'

const T = 1_700_000_000_000
const g = (s: number): FetchRecord => ({ at: T + s * 1000, source: 'google' })
const a = (s: number): FetchRecord => ({ at: T + s * 1000, source: 'apple' })
const iso = (s: number) => new Date(T + s * 1000).toISOString()

describe('countOpens', () => {
  it('merges fetches 30 s apart into one open', () => {
    expect(countOpens([g(0), g(30)]).opens).toBe(1)
  })
  it('counts 0, 59, 61 s as two opens', () => {
    const r = countOpens([g(0), g(59), g(61)])
    expect(r.opens).toBe(2)
    expect(r.firstAt).toBe(T)
    expect(r.lastAt).toBe(T + 61_000)
  })
  it('counts 0, 61, 121 s as three opens', () => {
    expect(countOpens([g(0), g(61), g(121)]).opens).toBe(3)
  })
  it('handles unsorted input', () => {
    expect(countOpens([g(121), g(0), g(61)]).opens).toBe(3)
  })
  it('never counts Apple fetches', () => {
    const r = countOpens([a(0), a(200)])
    expect(r).toEqual({ opens: 0, apple: true })
  })
  it('reports nothing for no fetches', () => {
    expect(countOpens([])).toEqual({ opens: 0, apple: false })
  })
})

describe('recipientStatus', () => {
  it('is apple for Apple-only fetches', () => {
    const s = recipientStatus('a@example.com', [a(0)])
    expect(s.state).toBe('apple')
    expect(s.opens).toBe(0)
  })
  it('is opened with Apple plus Google', () => {
    const s = recipientStatus('a@example.com', [a(0), g(5)])
    expect(s.state).toBe('opened')
    expect(s.opens).toBe(1)
    expect(s.firstAt).toBe(iso(5))
  })
  it('is none with nothing', () => {
    expect(recipientStatus('a@example.com', []).state).toBe('none')
  })
  it('is opened by a reply alone', () => {
    const s = recipientStatus('a@example.com', [], iso(100))
    expect(s.state).toBe('opened')
    expect(s.repliedAt).toBe(iso(100))
    expect(s.opens).toBe(0)
  })
  it('is opened by a reply over Apple-only fetches', () => {
    expect(recipientStatus('a@example.com', [a(0)], iso(100)).state).toBe('opened')
  })
})

describe('replyTimes', () => {
  it('ignores earlier messages, matches case-insensitively, keeps the earliest', () => {
    const m = replyTimes({ receivedAt: iso(100) }, [
      { from: [{ name: '', email: 'Bob@Example.com' }], receivedAt: iso(50) },
      { from: [{ name: '', email: 'Bob@Example.com' }], receivedAt: iso(300) },
      { from: [{ name: '', email: 'bob@example.com' }], receivedAt: iso(200) },
    ])
    expect([...m]).toEqual([['bob@example.com', iso(200)]])
  })
})

describe('conversationOpened', () => {
  it('is true when any recipient opened', () => {
    expect(
      conversationOpened([
        recipientStatus('a@example.com', []),
        recipientStatus('b@example.com', [g(0)]),
      ]),
    ).toBe(true)
    expect(conversationOpened([recipientStatus('a@example.com', [a(0)])])).toBe(false)
  })
})
