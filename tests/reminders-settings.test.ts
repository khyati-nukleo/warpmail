import { describe, expect, it } from 'vitest'
import type { Settings } from '../packages/core/src'
import {
  daysFromInput,
  patchReminders,
} from '../apps/desktop/src/renderer/src/reminders/reminder-settings-model'

const base = { reminders: { followUpDays: 5 } } as Settings

describe('patchReminders', () => {
  it('saves enabled: false from the main switch, keeping other reminder settings', () => {
    expect(patchReminders(base, { enabled: false })).toEqual({
      reminders: { followUpDays: 5, enabled: false },
    })
  })
  it('works from settings with no reminders yet', () => {
    expect(patchReminders({} as Settings, { forgotToReply: false })).toEqual({
      reminders: { forgotToReply: false },
    })
  })
})

describe('daysFromInput', () => {
  it('accepts whole days from 1 to 30', () => {
    expect(daysFromInput('1', 3)).toBe(1)
    expect(daysFromInput('30', 3)).toBe(30)
    expect(daysFromInput(' 12 ', 3)).toBe(12)
  })
  it('keeps the last valid value outside 1-30 or when not a whole number', () => {
    for (const text of ['0', '31', '-2', '', 'abc', '2.5', '1e1'])
      expect(daysFromInput(text, 7)).toBe(7)
  })
})
