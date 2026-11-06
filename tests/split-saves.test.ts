import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '../apps/desktop/node_modules/@tanstack/react-query'
import { defaultSettings, type Bootstrap, type Settings } from '../packages/core/src'

const state = vi.hoisted(() => ({
  saved: [] as Settings[],
  release: undefined as (() => void) | undefined,
}))
const saved = state.saved
vi.mock('../apps/desktop/src/renderer/src/api', () => ({
  api: {
    settings: async (value: Settings) => {
      state.saved.push(value)
      if (state.saved.length === 1) await new Promise<void>((resolve) => (state.release = resolve))
      return value
    },
  },
}))
const client = new QueryClient()
vi.mock('../apps/desktop/src/renderer/src/cache', () => ({ queryClient: client }))
const { saveSplitSettings, splitSaves } =
  await import('../apps/desktop/src/renderer/src/split/split-saves')

const cached = () => client.getQueryData<Bootstrap>(['bootstrap'])!.settings

beforeEach(() => {
  saved.length = 0
  client.setQueryData(['bootstrap'], {
    accounts: [],
    settings: { ...defaultSettings, splitTabs: [{ id: 'a', name: 'A', rules: [] }] },
  } as unknown as Bootstrap)
})

describe('split inbox saves', () => {
  it('build each change on the settings the last save left', async () => {
    const first = saveSplitSettings((s) => ({
      splitTabs: [...(s.splitTabs ?? []), { id: 'b', name: 'B', rules: [] }],
    }))
    const second = saveSplitSettings((s) => ({ important: { always: [], never: ['x@y.example'] } }))
    // The second waits for the first, then sees its tab.
    await vi.waitFor(() => expect(state.release).toBeDefined())
    expect(saved).toHaveLength(1)
    state.release!()
    await Promise.all([first, second])
    expect(saved[1]!.splitTabs!.map((t) => t.id)).toEqual(['a', 'b'])
    expect(cached().splitTabs!.map((t) => t.id)).toEqual(['a', 'b'])
    expect(cached().important).toEqual({ always: [], never: ['x@y.example'] })
  })

  it('share one queue with the tab row’s saves', async () => {
    const order: string[] = []
    saved.push(defaultSettings) // so the next save doesn't wait
    const row = splitSaves(async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push('row')
    })
    const settings = saveSplitSettings(() => {
      order.push('settings')
      return {}
    })
    await Promise.all([row, settings])
    expect(order).toEqual(['row', 'settings'])
  })

  it('a failed save rejects and leaves the cache alone, and the queue keeps going', async () => {
    saved.push(defaultSettings)
    const before = cached()
    await expect(
      saveSplitSettings(() => {
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
    expect(cached()).toBe(before)
    await saveSplitSettings(() => ({ important: { always: [], never: [] } }))
    expect(cached().important).toEqual({ always: [], never: [] })
  })
})
