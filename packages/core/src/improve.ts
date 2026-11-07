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

/** The Claude models Improve can use, cheapest first. */
export type AiModel =
  'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'claude-fable-5-1'

export const defaultAiModel: AiModel = 'claude-opus-5-5'

export interface AiModelInfo {
  id: AiModel
  label: string
  detail: string
  /**
   * USD per million tokens. Source: platform.claude.com/docs/en/about-claude/pricing,
   * confirmed 2026-11-06. `cacheWrite` is the 5-minute cache write price.
   */
  prices: { input: number; output: number; cacheWrite: number; cacheRead: number }
}

export const aiModels: AiModelInfo[] = [
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    detail: 'Fastest and cheapest. Fine for quick fixes.',
    prices: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    detail: 'Good writing at half the price of Opus.',
    prices: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    detail: 'The best balance of writing and price. The default.',
    prices: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  },
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    detail: 'Anthropic’s most capable model. Costs the most.',
    prices: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  },
]

export const aiModelInfo = (model: AiModel): AiModelInfo =>
  aiModels.find((info) => info.id === model) ?? aiModels.find((i) => i.id === defaultAiModel)!

export interface AiStatus {
  hasKey: boolean
  secureStorage: boolean
  /** The model Improve uses. */
  model: AiModel
  /** Month of the counters, as YYYY-MM. */
  month: string
  improves: number
  /** Estimated spend this month in USD. */
  estimatedCost: number
}

export type AiTestResult = { ok: true } | { ok: false; error: ImproveErrorKind; message: string }
