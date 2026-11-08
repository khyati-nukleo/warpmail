import type { ReminderSettings, Settings } from '@inlark/core'

/** The settings patch for a change to the Reminders section, on top of what is saved. */
export function patchReminders(
  latest: Pick<Settings, 'reminders'>,
  change: Partial<ReminderSettings>,
): Pick<Settings, 'reminders'> {
  return { reminders: { ...latest.reminders, ...change } }
}

/** Whole working days, 1 to 30, from what was typed; anything else keeps the last valid value. */
export function daysFromInput(text: string, current: number): number {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return current
  const days = Number(trimmed)
  return days >= 1 && days <= 30 ? days : current
}
