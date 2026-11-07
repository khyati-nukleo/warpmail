import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeStorage } from 'electron'
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from([...value].reverse().join('')),
    decryptString: (value: Buffer) => [...value.toString()].reverse().join(''),
  },
}))
import { AiService } from '../apps/desktop/src/main/ai/ai-service'
import { JsonStore } from '../apps/desktop/src/main/storage'
import type { ImproveProvider, ImproveUsage } from '../apps/desktop/src/main/ai/provider'
import { ImproveError } from '../apps/desktop/src/main/ai/provider'
import { improveErrorMessages, ipcSchemas, type AppEvent } from '../packages/core/src'

const key = 'sk-ant-' + 'test'.repeat(8)
const usage: ImproveUsage = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
}
let directory: string
let events: AppEvent[]
let created: number
let snapshots: string[]
let report: ImproveUsage | undefined
let fail: ImproveError | undefined
let waitForAbort: boolean
let today: Date

function service() {
  const ai = new AiService(new JsonStore(directory), (event) => events.push(event), {
    now: () => today,
    createProvider: (_key, onUsage): ImproveProvider => {
      created++
      return {
        async *improve(_text, _style, signal) {
          try {
            if (waitForAbort) {
              await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true }),
              )
              throw new ImproveError('cancelled')
            }
            for (const snapshot of snapshots) yield snapshot
            if (fail) throw fail
          } finally {
            if (report) onUsage(report)
          }
        },
        async check() {
          if (fail) throw fail
        },
      }
    },
  })
  return ai
}
const input = (id = 'a', text = 'hello', style = 'polish' as const) => ({ id, text, style })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ai-service-'))
  events = []
  created = 0
  snapshots = ['Hi', 'Hi there.']
  report = undefined
  fail = undefined
  waitForAbort = false
  today = new Date(2026, 10, 6, 12)
  vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('AiService', () => {
  it('never returns or stores the key in plain text', async () => {
    const ai = service()
    await ai.init()
    const results = [
      await ai.setKey(key),
      await ai.status(),
      await ai.testKey(),
      await ai.improve(input()),
    ]
    expect(JSON.stringify(results)).not.toContain(key)
    expect(JSON.stringify(events)).not.toContain(key)
    expect(await readFile(join(directory, 'ai-key.json'), 'utf8')).not.toContain(key)
  })

  it('rejects text that is not an API key', async () => {
    const ai = service()
    await ai.init()
    await expect(ai.setKey('hello')).rejects.toThrow(
      'That doesn’t look like an Anthropic API key. It starts with “sk-ant-”.',
    )
    expect((await ai.status()).hasKey).toBe(false)
    await expect(readFile(join(directory, 'ai-key.json'), 'utf8')).rejects.toThrow()
  })

  it('needs a key before improving', async () => {
    const ai = service()
    await ai.init()
    expect(await ai.improve(input())).toEqual({
      ok: false,
      error: 'noKey',
      message: improveErrorMessages.noKey,
    })
    expect((await ai.testKey()).ok).toBe(false)
    expect(created).toBe(0)
  })

  it('streams improve events and returns the final text', async () => {
    const ai = service()
    await ai.init()
    await ai.setKey(key)
    expect(await ai.improve(input())).toEqual({ ok: true, text: 'Hi there.' })
    expect(events).toEqual([
      { type: 'improve', id: 'a', text: 'Hi' },
      { type: 'improve', id: 'a', text: 'Hi there.' },
    ])
  })

  it('cancels the previous request when a new one starts', async () => {
    const ai = service()
    await ai.init()
    await ai.setKey(key)
    waitForAbort = true
    const first = ai.improve(input('a'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    waitForAbort = false
    const second = ai.improve(input('b'))
    expect(await first).toMatchObject({ ok: false, error: 'cancelled' })
    expect(await second).toEqual({ ok: true, text: 'Hi there.' })
  })

  it('cancel stops a running request', async () => {
    const ai = service()
    await ai.init()
    await ai.setKey(key)
    waitForAbort = true
    const running = ai.improve(input('a'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    ai.cancel('other')
    await new Promise((resolve) => setTimeout(resolve, 10))
    let settled = false
    void running.then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    ai.cancel('a')
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' })
  })

  it('refuses blank and very long text without calling the provider', async () => {
    const ai = service()
    await ai.init()
    await ai.setKey(key)
    expect(await ai.improve(input('a', '   '))).toMatchObject({ ok: false, error: 'failed' })
    expect(await ai.improve(input('a', 'x'.repeat(20_001)))).toMatchObject({
      ok: false,
      error: 'tooLong',
    })
    expect(created).toBe(0)
  })

  it('counts this month’s improves and estimates the cost', async () => {
    const ai = service()
    await ai.init()
    await ai.setKey(key)
    report = usage
    await ai.improve(input())
    await ai.improve(input())
    expect(await ai.status()).toMatchObject({ improves: 2, estimatedCost: 0.03 })
    fail = new ImproveError('unavailable')
    expect(await ai.improve(input())).toMatchObject({ ok: false, error: 'unavailable' })
    expect((await ai.status()).improves).toBe(2)
    expect((await ai.status()).estimatedCost).toBe(0.04)
  })

  it('starts a new count each month', async () => {
    const ai = service()
    await ai.init()
    await ai.setKey(key)
    report = usage
    today = new Date(2026, 10, 30, 12)
    await ai.improve(input())
    expect(await ai.status()).toMatchObject({ month: '2026-11', improves: 1 })
    today = new Date(2026, 11, 1, 9)
    expect(await ai.status()).toMatchObject({ month: '2026-12', improves: 0, estimatedCost: 0 })
    await ai.improve(input())
    expect(await ai.status()).toMatchObject({ month: '2026-12', improves: 1 })
  })

  it('remove key forgets it', async () => {
    const ai = service()
    await ai.init()
    await ai.setKey(key)
    expect((await ai.removeKey()).hasKey).toBe(false)
    expect(await ai.improve(input())).toMatchObject({ ok: false, error: 'noKey' })
  })

  it('reports when secure storage is unavailable', async () => {
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
    const ai = service()
    await ai.init()
    expect((await ai.status()).secureStorage).toBe(false)
    await expect(ai.setKey(key)).rejects.toThrow()
  })

  it('exposes every new method through IPC', () => {
    const names = [
      'aiStatus',
      'setAiKey',
      'removeAiKey',
      'testAiKey',
      'improveDraft',
      'cancelImprove',
    ]
    for (const name of names) expect(Object.keys(ipcSchemas)).toContain(name)
    expect(
      ipcSchemas.improveDraft.safeParse([{ id: 'a', text: 'hi', style: 'other' }]).success,
    ).toBe(false)
    expect(
      ipcSchemas.improveDraft.safeParse([{ id: 'a', text: 'hi', style: 'shorter' }]).success,
    ).toBe(true)
  })
})
