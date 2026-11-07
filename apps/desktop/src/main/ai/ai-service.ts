import {
  improveErrorMessages,
  type AiStatus,
  type AiTestResult,
  type AppEvent,
  type ImproveErrorKind,
  type ImproveResult,
  type ImproveStyle,
} from '@inlark/core'
import { JsonStore, decryptSecret, encryptSecret, secureStorageAvailable } from '../storage'
import { claudePrices, createClaudeProvider } from './claude'
import { ImproveError, type ImproveProvider, type ImproveUsage } from './provider'

const keyFile = 'ai-key'
const usageFile = 'ai-usage'
const maxLength = 20_000

interface Usage extends ImproveUsage {
  month: string
  improves: number
}
export interface AiServiceOptions {
  createProvider?: (apiKey: string, onUsage: (usage: ImproveUsage) => void) => ImproveProvider
  now?: () => Date
}

const failure = (error: ImproveErrorKind) => ({
  ok: false as const,
  error,
  message: improveErrorMessages[error],
})

/**
 * Keeps the Anthropic API key (encrypted) and this month's use, and runs improve requests.
 * It never logs anything about a request and never hands the key out.
 */
export class AiService {
  private current?: { id: string; controller: AbortController }
  private usageQueue: Promise<unknown> = Promise.resolve()
  private readonly createProvider: NonNullable<AiServiceOptions['createProvider']>
  private readonly now: () => Date
  constructor(
    private readonly store: JsonStore,
    private readonly send: (event: AppEvent) => void,
    options: AiServiceOptions = {},
  ) {
    this.createProvider =
      options.createProvider ?? ((apiKey, onUsage) => createClaudeProvider({ apiKey, onUsage }))
    this.now = options.now ?? (() => new Date())
  }

  init = async () => {
    await this.store.init()
  }

  status = async (): Promise<AiStatus> => {
    const usage = await this.usage()
    return {
      hasKey: (await this.storedKey()) !== undefined,
      secureStorage: secureStorageAvailable(),
      month: usage.month,
      improves: usage.improves,
      estimatedCost: this.cost(usage),
    }
  }

  setKey = async (key: string): Promise<AiStatus> => {
    const trimmed = key.trim()
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(trimmed))
      throw new Error('That doesn’t look like an Anthropic API key. It starts with “sk-ant-”.')
    await this.store.write(keyFile, { key: encryptSecret(trimmed) })
    return this.status()
  }

  removeKey = async (): Promise<AiStatus> => {
    this.current?.controller.abort()
    await this.store.write(keyFile, {})
    return this.status()
  }

  testKey = async (): Promise<AiTestResult> => {
    const apiKey = await this.apiKey()
    if (!apiKey) return failure('noKey')
    try {
      await this.createProvider(apiKey, () => {}).check()
      return { ok: true }
    } catch (error) {
      return failure(error instanceof ImproveError ? error.kind : 'failed')
    }
  }

  improve = async (input: {
    id: string
    text: string
    style: ImproveStyle
  }): Promise<ImproveResult> => {
    const apiKey = await this.apiKey()
    if (!apiKey) return failure('noKey')
    if (input.text.length > maxLength) return failure('tooLong')
    if (!input.text.trim()) return failure('failed')
    // Only the newest request may run.
    this.current?.controller.abort()
    const request = { id: input.id, controller: new AbortController() }
    this.current = request
    const { signal } = request.controller
    let result: ImproveResult
    try {
      const provider = this.createProvider(apiKey, (usage) => this.addUsage(usage))
      let text = ''
      // Always consumed with for await so the provider's cleanup (usage report) runs.
      for await (const snapshot of provider.improve(input.text, input.style, signal)) {
        if (signal.aborted) break
        text = snapshot
        this.send({ type: 'improve', id: input.id, text })
      }
      if (signal.aborted) result = failure('cancelled')
      else if (!text.trim()) result = failure('failed')
      else result = { ok: true, text }
    } catch (error) {
      if (signal.aborted) result = failure('cancelled')
      else result = failure(error instanceof ImproveError ? error.kind : 'failed')
    } finally {
      if (this.current === request) this.current = undefined
    }
    if (result.ok) this.queueUsage((usage) => ({ ...usage, improves: usage.improves + 1 }))
    await this.usageQueue
    return result
  }

  cancel = (id: string): void => {
    if (this.current?.id === id) this.current.controller.abort()
  }

  private async storedKey(): Promise<string | undefined> {
    const stored = await this.store.read<{ key?: string }>(keyFile, {})
    return typeof stored.key === 'string' ? stored.key : undefined
  }
  private async apiKey(): Promise<string | undefined> {
    const stored = await this.storedKey()
    if (!stored) return undefined
    try {
      return decryptSecret(stored)
    } catch {
      return undefined
    }
  }

  private month() {
    const date = this.now()
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0')
  }
  private async usage(): Promise<Usage> {
    const empty: Usage = {
      month: this.month(),
      improves: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    }
    const stored = await this.store.read<Partial<Usage>>(usageFile, {})
    if (stored.month !== empty.month) return empty
    const count = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0)
    return {
      month: empty.month,
      improves: count(stored.improves),
      inputTokens: count(stored.inputTokens),
      outputTokens: count(stored.outputTokens),
      cacheWriteTokens: count(stored.cacheWriteTokens),
      cacheReadTokens: count(stored.cacheReadTokens),
    }
  }
  private cost(usage: Usage) {
    const dollars =
      (usage.inputTokens * claudePrices.input +
        usage.outputTokens * claudePrices.output +
        usage.cacheWriteTokens * claudePrices.cacheWrite +
        usage.cacheReadTokens * claudePrices.cacheRead) /
      1e6
    return Math.round(dollars * 100) / 100
  }
  private addUsage(tokens: ImproveUsage) {
    this.queueUsage((usage) => ({
      ...usage,
      inputTokens: usage.inputTokens + tokens.inputTokens,
      outputTokens: usage.outputTokens + tokens.outputTokens,
      cacheWriteTokens: usage.cacheWriteTokens + tokens.cacheWriteTokens,
      cacheReadTokens: usage.cacheReadTokens + tokens.cacheReadTokens,
    }))
  }
  /** Updates run one after another. A failed write is ignored so it can't replace the result. */
  private queueUsage(change: (usage: Usage) => Usage) {
    this.usageQueue = this.usageQueue.then(async () => {
      try {
        await this.store.write(usageFile, change(await this.usage()))
      } catch {
        // Counting is best effort.
      }
    })
  }
}
