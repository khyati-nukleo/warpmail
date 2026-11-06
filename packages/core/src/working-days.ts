/** Hour of day (local) that snoozed mail comes back. */
export const reminderMorningHour = 9

const isWeekend = (d: Date): boolean => d.getDay() === 0 || d.getDay() === 6

/** Moves `days` working days on, keeping the local wall-clock time. Uses the process time zone. */
export function addWorkingDays(ms: number, days: number): number {
  const d = new Date(ms)
  if (isWeekend(d)) {
    d.setDate(d.getDate() + (d.getDay() === 6 ? 2 : 1))
    d.setHours(0, 0, 0, 0)
  }
  // setDate (not +24 h) so a clock change doesn't shift the time of day.
  for (let n = 0; n < days; n++) {
    do d.setDate(d.getDate() + 1)
    while (isWeekend(d))
  }
  return d.getTime()
}

/** 9:00 local on the given calendar date (month is 1-12). */
export function snoozeAt(date: { year: number; month: number; day: number }): number {
  return new Date(date.year, date.month - 1, date.day, reminderMorningHour).getTime()
}

export function snoozePresets(
  now: number,
): { id: 'tomorrow' | 'monday' | 'nextWeek'; label: string; until: number }[] {
  const today = new Date(now)
  const on = (offset: number) =>
    snoozeAt({
      year: today.getFullYear(),
      month: today.getMonth() + 1,
      day: today.getDate() + offset,
    })
  // Next Monday strictly after today: on a Monday that is seven days out.
  const toMonday = (8 - today.getDay()) % 7 || 7
  return [
    { id: 'tomorrow', label: 'Tomorrow morning', until: on(1) },
    { id: 'monday', label: 'Monday morning', until: on(toMonday) },
    { id: 'nextWeek', label: 'Next week', until: on(7) },
  ]
}
