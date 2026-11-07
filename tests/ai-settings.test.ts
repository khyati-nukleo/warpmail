import { describe, expect, it } from 'vitest'
import { formatPrices, formatUsage } from '../apps/desktop/src/renderer/src/ai-usage'
import { aiModelInfo } from '../packages/core/src'

describe('formatUsage', () => {
  it('uses the singular for one improve', () => {
    expect(formatUsage(1, 0.012)).toBe('1 improve · about $0.01')
  })
  it('uses the plural otherwise', () => {
    expect(formatUsage(0, 0)).toBe('0 improves · about $0.00')
    expect(formatUsage(12, 0.1349)).toBe('12 improves · about $0.13')
  })
})

describe('formatPrices', () => {
  it('shows each model’s list prices per million tokens', () => {
    expect(formatPrices(aiModelInfo('claude-opus-5-5'))).toBe(
      '$4 per million input tokens, $20 per million output tokens',
    )
    expect(formatPrices(aiModelInfo('claude-haiku-5-5'))).toBe(
      '$0.10 per million input tokens, $0.50 per million output tokens',
    )
  })
})
