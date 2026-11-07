import type { AiModelInfo } from '@inlark/core'

/** "1 improve · about $0.01", "12 improves · about $0.13", "3 improves · less than $0.01". */
export function formatUsage(improves: number, estimatedCost: number): string {
  return (
    improves.toLocaleString('en-US') +
    (improves === 1 ? ' improve' : ' improves') +
    (estimatedCost > 0 && estimatedCost < 0.005
      ? ' · less than $0.01'
      : ' · about $' + estimatedCost.toFixed(2))
  )
}

const dollars = (amount: number) => '$' + (amount < 1 ? amount.toFixed(2) : String(amount))

/** "$4 per million input tokens, $20 per million output tokens". */
export function formatPrices(model: Pick<AiModelInfo, 'prices'>): string {
  return (
    dollars(model.prices.input) +
    ' per million input tokens, ' +
    dollars(model.prices.output) +
    ' per million output tokens'
  )
}
