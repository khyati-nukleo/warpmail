import { describe, expect, it } from 'vitest'
import type { Account, Settings, SplitTab } from '../packages/core/src'
import {
  activeTabId,
  adjacentTab,
  dropIndex,
  moveTab,
  rovingTarget,
  tabEmptyCopy,
  tabEntries,
  tabForShortcut,
  untabbedAccounts,
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

  it('moves focus along the row with the arrow keys, Home and End', () => {
    expect(rovingTarget(0, 5, 'ArrowRight')).toBe(1)
    expect(rovingTarget(4, 5, 'ArrowRight')).toBe(0)
    expect(rovingTarget(0, 5, 'ArrowLeft')).toBe(4)
    expect(rovingTarget(3, 5, 'ArrowLeft')).toBe(2)
    expect(rovingTarget(3, 5, 'Home')).toBe(0)
    expect(rovingTarget(1, 5, 'End')).toBe(4)
    expect(rovingTarget(1, 5, 'Enter')).toBeUndefined()
    expect(rovingTarget(1, 5, 'ArrowDown')).toBeUndefined()
  })

  it('finds where a dragged tab lands, or nothing when it would not move', () => {
    // Three user tabs a, b, c; dropping a after c, or c before a.
    expect(dropIndex(0, 2, true)).toBe(2)
    expect(dropIndex(2, 0, false)).toBe(0)
    expect(dropIndex(0, 2, false)).toBe(1)
    expect(dropIndex(2, 0, true)).toBe(1)
    expect(dropIndex(1, 1, true)).toBeUndefined()
    expect(dropIndex(0, 1, false)).toBeUndefined()
    expect(dropIndex(1, 0, true)).toBeUndefined()
    // The result is what moveTab expects.
    const tabs = settings.splitTabs!
    expect(moveTab(tabs, 'a', dropIndex(0, 1, true)!).map((t) => t.id)).toEqual(['b', 'a', 'c'])
    expect(moveTab(tabs, 'c', dropIndex(2, 1, false)!).map((t) => t.id)).toEqual(['a', 'c', 'b'])
  })

  it('lists the accounts in scope that tabs leave out', () => {
    const account = (id: string, protocol?: 'imap' | 'jmap') =>
      ({ id, name: 'Account ' + id, protocol }) as Account
    const accounts = [account('1', 'imap'), account('2', 'jmap'), account('3')]
    expect(untabbedAccounts(accounts).map((a) => a.id)).toEqual(['2', '3'])
    expect(untabbedAccounts(accounts, '1')).toEqual([])
    expect(untabbedAccounts(accounts, '3').map((a) => a.id)).toEqual(['3'])
    expect(untabbedAccounts(accounts, 'removed').map((a) => a.id)).toEqual(['2', '3'])
  })

  it('explains an empty tab', () => {
    const important = entries[1]
    const user = entries[2]
    expect(tabEmptyCopy(user, [])).toEqual({
      id: 'a',
      title: 'Nothing in Tab a',
      description: 'Conversations in your inbox from this tab’s people show here.',
    })
    expect(tabEmptyCopy(important, [])).toEqual({
      id: 'important',
      title: 'Nothing in Important',
      description: 'Mail from people in your inbox shows here.',
    })
    expect(tabEmptyCopy(user, ['Fastmail']).note).toBe(
      'Fastmail isn’t included in tabs yet. Its mail is in Inbox.',
    )
    expect(tabEmptyCopy(user, ['Fastmail', 'Home']).note).toBe(
      'Fastmail and Home aren’t included in tabs yet. Their mail is in Inbox.',
    )
  })
})
