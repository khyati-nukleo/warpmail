/** Shared types and copy for the Improve draft feature. */

export type ImproveStyle = 'polish' | 'shorter' | 'formal' | 'friendly'

export const improveStyles: ImproveStyle[] = ['polish', 'shorter', 'formal', 'friendly']

export const improveStyleLabels: Record<ImproveStyle, string> = {
  polish: 'Improve',
  shorter: 'Shorter',
  formal: 'More formal',
  friendly: 'Friendlier',
}

export type ImproveErrorKind =
  | 'noKey'
  | 'badKey'
  | 'billing'
  | 'offline'
  | 'rateLimit'
  | 'unavailable'
  | 'refused'
  | 'tooLong'
  | 'failed'
  | 'cancelled'

/** What the user sees for each failure. `cancelled` is shown nowhere. */
export const improveErrorMessages: Record<ImproveErrorKind, string> = {
  noKey: 'Add your Anthropic API key in Settings → AI to use Improve.',
  badKey: 'Anthropic didn’t accept the API key. Check it in Settings → AI.',
  billing: 'Your Anthropic account is out of credit. Add credit in the Anthropic Console.',
  offline: 'Couldn’t reach Anthropic. Check your connection and try again.',
  rateLimit: 'Too many requests right now. Wait a moment and try again.',
  unavailable: 'Claude is unavailable right now. Try again in a moment.',
  refused: 'Claude declined to rewrite this draft.',
  tooLong: 'This draft is too long to improve in one go.',
  failed: 'Improve didn’t work this time. Try again.',
  cancelled: '',
}

export type ImproveResult =
  { ok: true; text: string } | { ok: false; error: ImproveErrorKind; message: string }

export interface AiStatus {
  hasKey: boolean
  secureStorage: boolean
  /** Month of the counters, as YYYY-MM. */
  month: string
  improves: number
  /** Estimated spend this month in USD. */
  estimatedCost: number
}

export type AiTestResult = { ok: true } | { ok: false; error: ImproveErrorKind; message: string }
