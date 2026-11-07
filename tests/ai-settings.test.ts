import { describe, expect, it } from 'vitest'
import { formatUsage } from '../apps/desktop/src/renderer/src/ai-usage'

describe('formatUsage', () => {
  it('uses the singular for one improve', () => {
    expect(formatUsage(1, 0.012)).toBe('1 improve · about $0.01')
  })
  it('uses the plural otherwise', () => {
    expect(formatUsage(0, 0)).toBe('0 improves · about $0.00')
    expect(formatUsage(12, 0.1349)).toBe('12 improves · about $0.13')
  })
})
