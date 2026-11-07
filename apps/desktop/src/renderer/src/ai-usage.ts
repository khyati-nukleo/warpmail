/** "1 improve · about $0.01", "12 improves · about $0.13". */
export function formatUsage(improves: number, estimatedCost: number): string {
  return (
    improves.toLocaleString('en-US') +
    (improves === 1 ? ' improve' : ' improves') +
    ' · about $' +
    estimatedCost.toFixed(2)
  )
}
