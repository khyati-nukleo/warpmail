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
const { queueTabSave, saveSplitSettings, splitSaves } =
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

  it('reload tab lists after a change to rules or Important, not after a reorder', async () => {
    saved.push(defaultSettings)
    client.setQueryData(['bootstrap'], {
      accounts: [],
      settings: {
        ...defaultSettings,
        splitTabs: [
          { id: 'a', name: 'A', rules: ['@a.example'] },
          { id: 'b', name: 'B', rules: [] },
        ],
      },
    } as unknown as Bootstrap)
    const tabList = ['mail', { view: 'inbox', tab: 'a' }]
    const inbox = ['mail', { view: 'inbox' }]
    const reset = () => {
      client.setQueryData(tabList, { pages: [] })
      client.setQueryData(inbox, { pages: [] })
    }
    const stale = () => [tabList, inbox].map((key) => !!client.getQueryState(key)?.isInvalidated)
    reset()
    await saveSplitSettings((s) => ({ splitTabs: [...s.splitTabs!].reverse() }))
    expect(stale()).toEqual([false, false])
    await saveSplitSettings((s) => ({
      splitTabs: s.splitTabs!.map((t) => ({ ...t, name: t.name + '!' })),
    }))
    expect(stale()).toEqual([false, false])
    await saveSplitSettings((s) => ({
      splitTabs: s.splitTabs!.map((t) => (t.id === 'a' ? { ...t, rules: ['@b.example'] } : t)),
    }))
    expect(stale()).toEqual([true, false])
    reset()
    await saveSplitSettings(() => ({ important: { always: [], never: ['x@y.example'] } }))
    expect(stale()).toEqual([true, false])
    reset()
    const save = async (patch: Partial<Settings>) => {
      client.setQueryData<Bootstrap>(['bootstrap'], (old) => ({
        ...old!,
        settings: { ...old!.settings, ...patch },
      }))
      return true
    }
    expect(await queueTabSave(save, (tabs) => [...tabs].reverse())).toBe(true)
    expect(stale()).toEqual([false, false])
    expect(await queueTabSave(save, (tabs) => tabs.filter((t) => t.id !== 'b'))).toBe(true)
    expect(stale()).toEqual([true, false])
  })

  it('build each tab row save on the tabs the last save left', async () => {
    let release: (() => void) | undefined
    const save = async (patch: Partial<Settings>) => {
      if (!release) await new Promise<void>((resolve) => (release = resolve))
      client.setQueryData<Bootstrap>(['bootstrap'], (old) => ({
        ...old!,
        settings: { ...old!.settings, ...patch },
      }))
      return true
    }
    const first = queueTabSave(save, (tabs) => [...tabs, { id: 'b', name: 'B', rules: [] }])
    const second = queueTabSave(save, (tabs) => [...tabs, { id: 'c', name: 'C', rules: [] }])
    // Nothing to save resolves at once, as saved, without a save.
    const third = queueTabSave(save, () => undefined)
    await vi.waitFor(() => expect(release).toBeDefined())
    release!()
    expect(await Promise.all([first, second, third])).toEqual([true, true, true])
    expect(cached().splitTabs!.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    // A failed save resolves false and leaves the next one to build on what was saved.
    const failed = await queueTabSave(
      async () => false,
      (tabs) => tabs.slice(0, 1),
    )
    expect(failed).toBe(false)
    expect(cached().splitTabs!.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})
