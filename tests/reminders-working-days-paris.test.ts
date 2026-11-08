import { describe, expect, it } from 'vitest'
import { addWorkingDays, snoozeAt } from '@inlark/core'

// Separate file so the zone is fixed for the whole worker.
process.env.TZ = 'Europe/Paris'

describe('working days follow the process zone (Europe/Paris)', () => {
  it('skips the weekend from a Friday', () => {
    const friday = new Date(2026, 10, 6, 15).getTime()
    expect(addWorkingDays(friday, 1)).toBe(Date.UTC(2026, 10, 9, 14)) // 15:00 CET = 14:00 UTC
  })
  it('puts 9:00 on the Paris wall clock', () =>
    expect(snoozeAt({ year: 2026, month: 11, day: 20 })).toBe(Date.UTC(2026, 10, 20, 8)))
})
