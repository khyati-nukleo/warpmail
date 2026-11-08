import { describe, expect, it } from 'vitest'
import type { HeldSend } from '../packages/core/src'
import { heldRows, secondsLeft } from '../apps/desktop/src/renderer/src/undo-send/held-text'

const now = Date.parse('2026-11-07T10:00:00.000Z')
const held = (draftId: string, inMs: number, more: Partial<HeldSend> = {}): HeldSend => ({
  draftId,
  accountId: 'work',
  subject: 'Plans',
  dueAt: new Date(now + inMs).toISOString(),
  state: 'waiting',
  ...more,
})
const accounts = [
  { id: 'work', name: 'Work' },
  { id: 'home', name: 'Home' },
]

describe('Undo send bar', () => {
  it('counts down in whole seconds, never below one while it can still be undone', () => {
    expect(secondsLeft(held('a', 10_000), now)).toBe(10)
    expect(secondsLeft(held('a', 9_001), now)).toBe(10)
    expect(secondsLeft(held('a', 9_000), now)).toBe(9)
    expect(secondsLeft(held('a', 0), now)).toBe(1)
    expect(secondsLeft(held('a', -500), now)).toBe(1)
  })
  it('reads "Sending in 10s" for one email, with Undo', () => {
    expect(heldRows([held('a', 10_000)], now, [accounts[0]])).toEqual({
      rows: [{ draftId: 'a', text: 'Sending in 10s', undo: true }],
      more: 0,
    })
  })
  it('shows "Sending…" without Undo once the countdown is over', () => {
    expect(heldRows([held('a', -100, { state: 'sending' })], now, [accounts[0]]).rows).toEqual([
      { draftId: 'a', text: 'Sending…', undo: false },
    ])
  })
  it('names each email by subject when several are pending, and the account with several', () => {
    const sends = [
      held('a', 3_000),
      held('b', 8_000, { accountId: 'home', subject: 'Dinner' }),
      held('c', 9_000, { subject: '' }),
    ]
    expect(heldRows(sends, now, [accounts[0]]).rows.map((r) => r.text)).toEqual([
      '“Plans” · Sending in 3s',
      '“Dinner” · Sending in 8s',
      '“(No subject)” · Sending in 9s',
    ])
    expect(heldRows(sends, now, accounts).rows.map((r) => r.text)).toEqual([
      'Work · “Plans” · Sending in 3s',
      'Home · “Dinner” · Sending in 8s',
      'Work · “(No subject)” · Sending in 9s',
    ])
  })
  it('shows the three newest, newest last, and counts the rest', () => {
    const sends = ['a', 'b', 'c', 'd', 'e'].map((id, i) => held(id, 1_000 * (i + 1)))
    const { rows, more } = heldRows(sends, now, [accounts[0]])
    expect(rows.map((r) => r.draftId)).toEqual(['c', 'd', 'e'])
    expect(more).toBe(2)
  })
})
