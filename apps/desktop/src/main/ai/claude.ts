import Anthropic from '@anthropic-ai/sdk'
import { defaultAiModel, type AiModel, type ImproveStyle } from '@inlark/core'
import { cleanImprovedText, improveInstructions, improveRequestText } from './instructions'
import { ImproveError, type ImproveProvider, type ImproveUsage } from './provider'

/** Claude Haiku 5.5 has no server-side fallback and rejects the parameter. */
const withFallback = (model: AiModel) => model !== 'claude-haiku-5-5'

export interface ClaudeProviderOptions {
  apiKey: string
  /** Defaults to Claude Opus 5.5. */
  model?: AiModel
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

type TokenCount =
  'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'

/** The token counts of one entry in `usage.iterations`. */
type IterationUsage = Partial<Record<TokenCount, number | null>>

function sum(iterations: readonly IterationUsage[], key: TokenCount): number {
  return iterations.reduce((total, iteration) => total + (iteration[key] ?? 0), 0)
}

export function createClaudeProvider(options: ClaudeProviderOptions): ImproveProvider {
  const model = options.model ?? defaultAiModel
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
      iterations?: readonly IterationUsage[] | null
    }): void => {
      if (u.iterations?.length) {
        // A server-side fallback bills the declined attempt too; only iterations show it.
        usage.inputTokens = sum(u.iterations, 'input_tokens')
        usage.outputTokens = sum(u.iterations, 'output_tokens')
        usage.cacheWriteTokens = sum(u.iterations, 'cache_creation_input_tokens')
        usage.cacheReadTokens = sum(u.iterations, 'cache_read_input_tokens')
        return
      }
      if (u.input_tokens != null) usage.inputTokens = u.input_tokens
      if (u.output_tokens != null) usage.outputTokens = u.output_tokens
      if (u.cache_creation_input_tokens != null)
        usage.cacheWriteTokens = u.cache_creation_input_tokens
      if (u.cache_read_input_tokens != null) usage.cacheReadTokens = u.cache_read_input_tokens
    }
    try {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: 16000,
          ...(withFallback(model)
            ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
            : {}),
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
      await client.models.retrieve(model, undefined, { signal })
    } catch (err) {
      throw toImproveError(err, signal)
    }
  }

  return { improve, check }
}
