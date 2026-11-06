import { describe, expect, it } from 'vitest'
import type { Settings, SplitTab } from '../packages/core/src'
import {
  activeTabId,
  adjacentTab,
  moveTab,
  tabEntries,
  tabForShortcut,
} from '../apps/desktop/src/renderer/src/split/tab-model'

const tab = (id: string): SplitTab => ({ id, name: 'Tab ' + id, rules: [] })
const settings = { splitTabs: [tab('a'), tab('b'), tab('c')] } as Settings
const entries = tabEntries(settings)

describe('split tab model', () => {
  it('lists Inbox, Important, then user tabs in order', () => {
    expect(entries.map((entry) => entry.id)).toEqual(['inbox', 'important', 'a', 'b', 'c'])
    expect(entries.map((entry) => entry.user)).toEqual([false, false, true, true, true])
    expect(entries[0].name).toBe('Inbox')
    expect(tabEntries({} as Settings).map((entry) => entry.id)).toEqual(['inbox', 'important'])
  })

  it('falls back to inbox for a missing tab', () => {
    expect(activeTabId('deleted-id', entries)).toBe('inbox')
    expect(activeTabId(undefined, entries)).toBe('inbox')
    expect(activeTabId('b', entries)).toBe('b')
  })

  it('maps shortcut numbers to tabs', () => {
    expect(tabForShortcut(1, entries)).toBe('inbox')
    expect(tabForShortcut(2, entries)).toBe('important')
    expect(tabForShortcut(3, entries)).toBe('a')
    expect(tabForShortcut(5, entries)).toBe('c')
    expect(tabForShortcut(9, entries)).toBeUndefined()
  })

  it('wraps around for next and previous', () => {
    expect(adjacentTab('inbox', entries, 1)).toBe('important')
    expect(adjacentTab('c', entries, 1)).toBe('inbox')
    expect(adjacentTab('inbox', entries, -1)).toBe('c')
    expect(adjacentTab('b', entries, -1)).toBe('a')
    expect(adjacentTab('gone', entries, 1)).toBe('important')
  })

  it('reorders among user tabs and clamps', () => {
    const tabs = settings.splitTabs!
    expect(moveTab(tabs, 'c', 0).map((t) => t.id)).toEqual(['c', 'a', 'b'])
    expect(moveTab(tabs, 'a', 1).map((t) => t.id)).toEqual(['b', 'a', 'c'])
    expect(moveTab(tabs, 'a', 99).map((t) => t.id)).toEqual(['b', 'c', 'a'])
    expect(moveTab(tabs, 'c', -5).map((t) => t.id)).toEqual(['c', 'a', 'b'])
    expect(moveTab(tabs, 'zzz', 0)).toEqual(tabs)
    expect(tabs.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})
