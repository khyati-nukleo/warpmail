import { snoozeAt, snoozePresets } from '@inlark/core'
import { shortDate } from '../mail-date'

export interface SnoozeOption {
  id: string
  label: string
  /** The day and time it returns, e.g. “Nov 7, 9:00 AM”. */
  detail: string
  until: number
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

const detailOf = (until: number) =>
  shortDate(new Date(until).toISOString()) + ', ' + timeFormatter.format(new Date(until))

export function snoozeOptions(now: number): SnoozeOption[] {
  return snoozePresets(now).map((p) => ({ ...p, detail: detailOf(p.until) }))
}

/** `<input type="date">` value (yyyy-mm-dd) for the local day after `now`. */
export function tomorrowInput(now: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 9:00 local on the chosen date, or undefined if empty, malformed or before tomorrow. */
export function dateInputToUntil(value: string, now: number): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m || value < tomorrowInput(now)) return undefined
  return snoozeAt({ year: +m[1], month: +m[2], day: +m[3] })
}

/** Index after an arrow key (or Ctrl+N/P), wrapping; other keys leave it. */
export function moveActive(index: number, count: number, key: string, ctrl = false): number {
  if (!count) return 0
  const step =
    key === 'ArrowDown' || (ctrl && key === 'n')
      ? 1
      : key === 'ArrowUp' || (ctrl && key === 'p')
        ? -1
        : 0
  return (index + step + count) % count
}
