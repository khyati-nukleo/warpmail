import { describe, expect, it } from 'vitest'
import { addWorkingDays, snoozeAt, snoozePresets } from '@inlark/core'

// Set before any Date is created in this file; vitest gives each file its own worker.
process.env.TZ = 'America/Toronto'

const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime()

describe('addWorkingDays (America/Toronto)', () => {
  it('adds one day midweek', () =>
    expect(addWorkingDays(at(2026, 11, 4, 10), 1)).toBe(at(2026, 11, 5, 10)))
  it('skips the weekend from a Friday', () =>
    expect(addWorkingDays(at(2026, 11, 6, 15), 1)).toBe(at(2026, 11, 9, 15)))
  it('counts only working days across a weekend', () =>
    expect(addWorkingDays(at(2026, 11, 5, 15), 3)).toBe(at(2026, 11, 10, 15)))
  it('starts from Monday 00:00 when given a Saturday', () =>
    expect(addWorkingDays(at(2026, 11, 7, 10), 1)).toBe(at(2026, 11, 10, 0)))
  it('starts from Monday 00:00 when given a Sunday', () =>
    expect(addWorkingDays(at(2026, 11, 8, 10), 1)).toBe(at(2026, 11, 10, 0)))
  it('keeps wall-clock time across a clock change', () => {
    const result = addWorkingDays(at(2026, 10, 30, 15), 1)
    expect(result).toBe(at(2026, 11, 2, 15))
    expect(result - at(2026, 10, 30, 15)).not.toBe(3 * 24 * 3600 * 1000)
  })
})

describe('snoozePresets', () => {
  it('from a Monday, Monday morning is next week', () => {
    const p = snoozePresets(at(2026, 11, 9, 14))
    expect(p.map((x) => [x.id, x.until])).toEqual([
      ['tomorrow', at(2026, 11, 10, 9)],
      ['monday', at(2026, 11, 16, 9)],
      ['nextWeek', at(2026, 11, 16, 9)],
    ])
  })
  it('from a Friday', () => {
    const p = snoozePresets(at(2026, 11, 6, 14))
    expect(p.find((x) => x.id === 'monday')?.until).toBe(at(2026, 11, 9, 9))
    expect(p.find((x) => x.id === 'nextWeek')?.until).toBe(at(2026, 11, 13, 9))
  })
  it('gives every preset a label', () =>
    expect(snoozePresets(at(2026, 11, 6, 14)).every((x) => x.label.length > 0)).toBe(true))
})

describe('snoozeAt', () => {
  it('is 9:00 local on the date', () =>
    expect(snoozeAt({ year: 2026, month: 11, day: 20 })).toBe(at(2026, 11, 20, 9)))
})
