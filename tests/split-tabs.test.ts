import { describe, expect, it } from 'vitest'
import { QueryClient } from '../apps/desktop/node_modules/@tanstack/react-query'
import type { Account, Settings, SplitTab } from '../packages/core/src'
import {
  activeTabId,
  adjacentTab,
  dropIndex,
  editorState,
  matchCountText,
  moveTab,
  putTab,
  rovingTarget,
  serialQueue,
  tabEmptyCopy,
  tabEntries,
  tabForShortcut,
  tabMoves,
  untabbedAccounts,
  whenIdle,
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

  it('says when a tab has nothing unread', () => {
    expect(tabEmptyCopy(entries[2], ['Fastmail'], true)).toEqual({
      id: 'a',
      title: 'Nothing unread in Tab a',
      description: 'You’ve read everything here.',
      note: 'Fastmail isn’t included in tabs yet. Its mail is in Inbox.',
    })
  })

  it('runs queued saves one at a time, in order', async () => {
    const queue = serialQueue()
    const log: string[] = []
    let release!: () => void
    const first = queue(
      () =>
        new Promise<string>((resolve) => {
          log.push('first started')
          release = () => resolve('one')
        }),
    )
    const second = queue(async () => {
      log.push('second started')
      return 'two'
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toEqual(['first started'])
    release()
    expect(await first).toBe('one')
    expect(await second).toBe('two')
    expect(log).toEqual(['first started', 'second started'])
    // A failed task doesn't stop the next one.
    await expect(queue(() => Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(await queue(async () => 'three')).toBe('three')
  })

  it('waits for the list to finish loading', async () => {
    const client = new QueryClient()
    let finish!: (value: number) => void
    const page = client.fetchQuery({
      queryKey: ['mail', { view: 'inbox' }],
      queryFn: () => new Promise<number>((resolve) => (finish = resolve)),
    })
    let idle = false
    const waiting = whenIdle(client, ['mail']).then(() => (idle = true))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(idle).toBe(false)
    finish(1)
    await page
    await waiting
    expect(idle).toBe(true)
    // Resolves at once (after a tick) when nothing is loading.
    await whenIdle(client, ['mail'])
  })

  describe('tab editor', () => {
    const own = ['me@work.example', 'me.personal@gmail.com']
    const tabs = [
      { id: 'a', name: 'Client', rules: ['@client.example'] },
      { id: 'b', name: 'GitHub', rules: ['notifications@github.com'] },
    ]

    it('accepts a new tab and normalises its rules', () => {
      const state = editorState(
        '  Partners ',
        '  Someone@Gmail.COM \n\npartner.example.\n<x@other.example>\nsomeone@gmail.com',
        own,
        tabs,
      )
      expect(state).toEqual({
        rules: ['someone@gmail.com', '@partner.example', 'x@other.example'],
        problems: [],
        nameError: undefined,
        canSave: true,
      })
    })

    it('allows a tab with no rules yet', () => {
      expect(editorState('Later', '  \n', own, tabs).canSave).toBe(true)
    })

    it('requires a name of 60 characters or fewer', () => {
      expect(editorState('   ', '', own, tabs)).toMatchObject({
        nameError: 'Name the tab.',
        canSave: false,
      })
      expect(editorState('x'.repeat(60), '', own, tabs).canSave).toBe(true)
      expect(editorState('x'.repeat(61), '', own, tabs)).toMatchObject({
        nameError: 'Keep the name to 60 characters or fewer.',
        canSave: false,
      })
    })

    it('refuses a name another tab has, ignoring case', () => {
      expect(editorState('client ', '', own, tabs)).toMatchObject({
        nameError: 'You already have a tab called “Client”.',
        canSave: false,
      })
      // Keeping a tab's own name, or changing only its case, is fine.
      expect(editorState('Client', '', own, tabs, 'a').canSave).toBe(true)
      expect(editorState('CLIENT', '', own, tabs, 'a').canSave).toBe(true)
      expect(editorState('github', '', own, tabs, 'a').canSave).toBe(false)
    })

    it('refuses the built-in tab names', () => {
      expect(editorState('Inbox', '', own, tabs)).toMatchObject({
        nameError: 'Inbox is a built-in tab. Choose another name.',
        canSave: false,
      })
      expect(editorState(' important', '', own, tabs)).toMatchObject({
        nameError: 'Important is a built-in tab. Choose another name.',
        canSave: false,
      })
    })

    it('reports refused and unreadable rules and can’t save while any remain', () => {
      const state = editorState('Client', 'a@client.example\n@work.example\nhello', own, tabs, 'a')
      expect(state.rules).toEqual(['a@client.example'])
      expect(state.problems).toEqual([
        {
          line: 2,
          text: '@work.example',
          reason:
            '@work.example is on your own domain, so every conversation would match. Tabs are decided by the people you write with.',
        },
        { line: 3, text: 'hello', reason: 'hello is not an address or a domain.' },
      ])
      expect(state.nameError).toBeUndefined()
      expect(state.canSave).toBe(false)
    })

    it('adds a new tab at the end and replaces an edited one in place', () => {
      const added = putTab(tabs, { id: 'c', name: 'New', rules: [] })
      expect(added.map((t) => t.id)).toEqual(['a', 'b', 'c'])
      const edited = putTab(tabs, { id: 'a', name: 'Renamed', rules: ['x@y.example'] })
      expect(edited).toEqual([{ id: 'a', name: 'Renamed', rules: ['x@y.example'] }, tabs[1]])
      expect(tabs[0].name).toBe('Client')
    })

    it('says where a tab can move', () => {
      const three = [...tabs, { id: 'c', name: 'C', rules: [] }]
      expect(tabMoves(three, 'a')).toEqual({ left: undefined, right: 1 })
      expect(tabMoves(three, 'b')).toEqual({ left: 0, right: 2 })
      expect(tabMoves(three, 'c')).toEqual({ left: 1, right: undefined })
      expect(tabMoves(three, 'gone')).toEqual({ left: undefined, right: undefined })
    })

    it('words the match count', () => {
      expect(matchCountText(0)).toBe('Matches no conversations in your inbox')
      expect(matchCountText(1)).toBe('Matches 1 conversation in your inbox')
      expect(matchCountText(1234)).toBe(
        'Matches ' + (1234).toLocaleString() + ' conversations in your inbox',
      )
    })
  })
})
