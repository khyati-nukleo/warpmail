import { describe, expect, it } from 'vitest'
import { defaultReminderSettings } from '../packages/core/src'
import { reminderLabelOf } from '../apps/desktop/src/renderer/src/reminders/reminder-label-model'
import { listRows } from '../apps/desktop/src/renderer/src/list-rows'
import {
  dateInputToUntil,
  moveActive,
  snoozeOptions,
  tomorrowInput,
} from '../apps/desktop/src/renderer/src/snooze/snooze-model'

// Wed 4 Nov 2026, 15:30 local
const now = new Date(2026, 10, 4, 15, 30).getTime()
const at = (m: number, d: number) => new Date(2026, m - 1, d, 9).getTime()

describe('reminder label', () => {
  const reminder = (kind: 'followUp' | 'reply') => ({
    kind,
    dueAt: '2026-11-04T10:00:00Z',
    messageId: 'm',
  })
  it('is empty without a reminder', () => {
    expect(reminderLabelOf(undefined, defaultReminderSettings)).toBeUndefined()
  })
  it('names both kinds and singular days', () => {
    expect(reminderLabelOf(reminder('reply'), defaultReminderSettings)).toBe('Waiting on you')
    expect(
      reminderLabelOf(reminder('followUp'), { ...defaultReminderSettings, followUpDays: 3 }),
    ).toBe('No reply in 3 days')
    expect(
      reminderLabelOf(reminder('followUp'), { ...defaultReminderSettings, followUpDays: 1 }),
    ).toBe('No reply in 1 day')
  })
})

describe('snooze picker model', () => {
  it('lists three presets at 9:00 with day and time text', () => {
    const options = snoozeOptions(now)
    expect(options.map((o) => o.until)).toEqual([at(11, 5), at(11, 9), at(11, 11)])
    expect(options.map((o) => o.label)).toEqual(['Tomorrow morning', 'Monday morning', 'Next week'])
    for (const o of options) expect(o.detail).toMatch(/9:00/)
  })
  it('ArrowDown then Enter picks the second', () => {
    const options = snoozeOptions(now)
    expect(options[moveActive(0, 4, 'ArrowDown')].until).toBe(at(11, 9))
    expect(moveActive(0, 4, 'ArrowUp')).toBe(3)
    expect(moveActive(3, 4, 'ArrowDown')).toBe(0)
    expect(moveActive(1, 4, 'x')).toBe(1)
  })
  it('turns a date into 9:00 of that date, from tomorrow on', () => {
    expect(tomorrowInput(now)).toBe('2026-11-05')
    expect(dateInputToUntil('2026-11-20', now)).toBe(at(11, 20))
    expect(dateInputToUntil('2026-11-04', now)).toBeUndefined()
    expect(dateInputToUntil('', now)).toBeUndefined()
  })
})

describe('list day headers', () => {
  const conv = (key: string, receivedAt: string, dueAt?: string) =>
    ({ key, receivedAt, reminder: dueAt && { kind: 'reply', dueAt, messageId: 'm' } }) as never
  it('groups a raised conversation by when it came due', () => {
    const t = (d: number) => new Date(2026, 10, d, 12).toISOString()
    const rows = listRows([conv('a', t(1), t(3)), conv('b', t(3)), conv('c', t(1))])
    expect(rows.map((r) => ('group' in r ? 'H' : r.conversation.key))).toEqual([
      'H',
      'a',
      'b',
      'H',
      'c',
    ])
  })
})
