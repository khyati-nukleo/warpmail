import type { RecipientReadStatus } from '@inlark/core'
import { dayTime } from '../mail-date'

/** One recipient's status in words, e.g. “Opened 2× · last today 3:12 pm”. */
export function readStatusLine(status: RecipientReadStatus, now: Date): string {
  if (status.state === 'apple') return "Delivered to Apple Mail, can't tell"
  if (status.state === 'none') return 'No signal yet'
  const parts = [status.opens ? `Opened ${status.opens}×` : 'Opened']
  if (status.opens > 1 && status.lastAt) parts.push('last ' + dayTime(status.lastAt, now))
  else if (status.opens === 1 && status.firstAt) parts.push(dayTime(status.firstAt, now))
  if (status.repliedAt) parts.push('replied ' + dayTime(status.repliedAt, now))
  return parts.join(' · ')
}

/** Shown on request under the statuses: what the count can and cannot tell. */
export const readStatusSmallPrint: string[] = [
  'Opened or not, and the first open, are reliable; the count is a rough guide.',
  'Gmail recipients often show 1× after several opens, because Google fetches the image once and reuses it.',
  'Blocked images mean “No signal” even if the email was read.',
  'Several devices count separately.',
  'A forwarded copy’s opens count as the original recipient’s.',
]
