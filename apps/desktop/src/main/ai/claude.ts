import Anthropic from '@anthropic-ai/sdk'
import type { ImproveStyle } from '@inlark/core'
import { cleanImprovedText, improveInstructions, improveRequestText } from './instructions'
import { ImproveError, type ImproveProvider, type ImproveUsage } from './provider'

export const claudeModel = 'claude-opus-5-5'

/**
 * USD per million tokens. Source: platform.claude.com/docs/en/about-claude/pricing,
 * confirmed 2026-11-06. `cacheWrite` is the 5-minute cache write price.
 */
export const claudePrices = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }

export interface ClaudeProviderOptions {
  apiKey: string
  baseURL?: string
  maxRetries?: number
  timeoutMs?: number
  onUsage?: (usage: ImproveUsage) => void
}

/** Turns any SDK failure into an ImproveError. Most specific first. */
function toImproveError(err: unknown, signal?: AbortSignal): ImproveError {
  if (err instanceof ImproveError) return err
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) {
    return new ImproveError('cancelled')
  }
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return new ImproveError('badKey')
  }
  if (err instanceof Anthropic.RateLimitError) return new ImproveError('rateLimit')
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) return new ImproveError('billing')
    if (err instanceof Anthropic.InternalServerError) return new ImproveError('unavailable')
    if (err instanceof Anthropic.APIConnectionError) return new ImproveError('offline')
    if (err.status === undefined) {
      // An SSE `error` event in the middle of a stream has no HTTP status.
      if (err.type === 'overloaded_error' || err.type === 'api_error') {
        return new ImproveError('unavailable')
      }
      if (err.type === 'rate_limit_error') return new ImproveError('rateLimit')
    }
  }
  return new ImproveError('failed')
}

export function createClaudeProvider(options: ClaudeProviderOptions): ImproveProvider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    // Keep ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL from the environment out.
    authToken: null,
    baseURL: options.baseURL ?? 'https://api.anthropic.com',
    maxRetries: options.maxRetries ?? 1,
    timeout: options.timeoutMs ?? 60_000,
  })

  async function* improve(
    text: string,
    style: ImproveStyle,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const usage: ImproveUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    }
    const addUsage = (u: {
      input_tokens?: number | null
      output_tokens?: number | null
      cache_creation_input_tokens?: number | null
      cache_read_input_tokens?: number | null
    }): void => {
      if (u.input_tokens != null) usage.inputTokens = u.input_tokens
      if (u.output_tokens != null) usage.outputTokens = u.output_tokens
      if (u.cache_creation_input_tokens != null)
        usage.cacheWriteTokens = u.cache_creation_input_tokens
      if (u.cache_read_input_tokens != null) usage.cacheReadTokens = u.cache_read_input_tokens
    }
    try {
      const stream = client.beta.messages.stream(
        {
          model: claudeModel,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'low' },
          system: [
            { type: 'text', text: improveInstructions, cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content: improveRequestText(text, style) }],
        },
        { signal },
      )
      // Text from every text block, in order. A server-side fallback keeps what was already
      // streamed: its `fallback` block only marks where the fallback model carries on.
      let accumulated = ''
      let last = ''
      let stopReason: string | null = null
      // Track which blocks are text, so thinking or other deltas never leak in.
      const textBlocks = new Set<number>()
      for await (const event of stream) {
        if (event.type === 'message_start') {
          addUsage(event.message.usage)
        } else if (event.type === 'content_block_start') {
          if (event.content_block.type === 'text') textBlocks.add(event.index)
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta' && textBlocks.has(event.index)) {
            accumulated += event.delta.text
            const cleaned = cleanImprovedText(accumulated)
            if (cleaned !== last) {
              last = cleaned
              yield cleaned
            }
          }
        } else if (event.type === 'message_delta') {
          addUsage(event.usage)
          stopReason = event.delta.stop_reason
        }
      }
      if (signal.aborted) throw new ImproveError('cancelled')
      if (stopReason === 'refusal') throw new ImproveError('refused')
      if (stopReason === 'max_tokens') throw new ImproveError('tooLong')
      if (cleanImprovedText(accumulated) === '') throw new ImproveError('failed')
    } catch (err) {
      throw toImproveError(err, signal)
    } finally {
      options.onUsage?.(usage)
    }
  }

  async function check(signal?: AbortSignal): Promise<void> {
    try {
      await client.models.retrieve(claudeModel, undefined, { signal })
    } catch (err) {
      throw toImproveError(err, signal)
    }
  }

  return { improve, check }
}
