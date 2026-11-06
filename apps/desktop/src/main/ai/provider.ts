import { improveErrorMessages, type ImproveErrorKind, type ImproveStyle } from '@inlark/core'

/** Token counts for one improve request. */
export interface ImproveUsage {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

/** Failure of an improve request. The message is our own copy, never the provider's text. */
export class ImproveError extends Error {
  constructor(readonly kind: ImproveErrorKind) {
    super(improveErrorMessages[kind])
    this.name = 'ImproveError'
  }
}

export interface ImproveProvider {
  /** Yields the whole improved text so far after each change; the last value is the result. */
  improve(text: string, style: ImproveStyle, signal: AbortSignal): AsyncIterable<string>
  /** Proves the key works without sending any draft. */
  check(signal?: AbortSignal): Promise<void>
}
