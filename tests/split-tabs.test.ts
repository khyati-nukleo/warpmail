import { describe, expect, it } from 'vitest'
import { QueryClient } from '../apps/desktop/node_modules/@tanstack/react-query'
import type { Account, ImportantSettings, Settings, SplitTab } from '../packages/core/src'
import {
  activeTabId,
  addRule,
  adjacentTab,
  alwaysEntry,
  alwaysShownText,
  dropIndex,
  editorState,
  importantLimit,
  importantStatus,
  importedText,
  matchCountText,
  moveTab,
  neverEntry,
  needsWholeConversation,
  parseWords,
  pickerOptions,
  pickProblem,
  putTab,
  rovingTarget,
  senderOf,
  senderRules,
  serialQueue,
  setAlways,
  setNever,
  tabEmptyCopy,
  tabEntries,
  tabForShortcut,
  tabMoves,
  undoNever,
  untabbedAccounts,
  whenIdle,
  wordsProblem,
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
    const own = ['me@work.example', 'x@gmail.com']
    const tabs = [
      { id: 'a', name: 'Client', rules: ['@client.example'] },
      { id: 'b', name: 'GitHub', rules: ['notifications@github.com'] },
    ]

    it('accepts a new tab and normalises its rules', () => {
      const state = editorState(
        '  Partners ',
        '  Y@Gmail.COM \n\npartner.example.\n<x@other.example>\ny@gmail.com',
        own,
        tabs,
      )
      expect(state).toEqual({
        rules: ['y@gmail.com', '@partner.example', 'x@other.example'],
        problems: [],
        nameError: undefined,
        limitError: undefined,
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

    it('keeps a tab to 500 addresses and domains', () => {
      const lines = (n: number) =>
        Array.from({ length: n }, (_, i) => 'person' + i + '@client.example').join('\n')
      expect(editorState('Big', lines(500), own, tabs)).toMatchObject({
        limitError: undefined,
        canSave: true,
      })
      const state = editorState('Big', lines(501) + '\nperson0@client.example', own, tabs)
      expect(state.rules).toHaveLength(501)
      expect(state.limitError).toBe(
        'A tab holds up to 500 addresses and domains. This one has 501.',
      )
      expect(state.canSave).toBe(false)
    })

    it('makes no new tab past 50, but still edits one', () => {
      const fifty = Array.from({ length: 50 }, (_, i) => ({
        id: 't' + i,
        name: 'Tab ' + i,
        rules: [],
      }))
      expect(editorState('One more', '', own, fifty)).toMatchObject({
        limitError: 'You have 50 tabs, the most there can be. Delete one to make room.',
        canSave: false,
      })
      expect(editorState('Renamed', '', own, fifty, 't3')).toMatchObject({
        limitError: undefined,
        canSave: true,
      })
      expect(editorState('One more', '', own, fifty.slice(1)).canSave).toBe(true)
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

describe('adding a sender to a tab', () => {
  const own = ['me@work.example', 'x@gmail.com']
  const from = (email: string, receivedAt: string) => ({
    from: [{ name: email.split('@')[0], email }],
    receivedAt,
  })

  it('finds the newest sender who is not the user', () => {
    const messages = [
      from('ana@client.example', '2026-11-01T10:00:00Z'),
      from('ben@partner.example', '2026-11-03T10:00:00Z'),
      from('Me@Work.example', '2026-11-04T10:00:00Z'),
      from('cleo@client.example', '2026-11-02T10:00:00Z'),
    ]
    expect(senderOf(messages, own)).toEqual({ name: 'ben', email: 'ben@partner.example' })
    expect(senderOf([from('x@gmail.com', '2026-11-04T10:00:00Z')], own)).toBeUndefined()
    expect(senderOf([{ from: [], receivedAt: '2026-11-04T10:00:00Z' }], own)).toBeUndefined()
    expect(senderOf([], own)).toBeUndefined()
  })

  it('fetches the whole conversation only when what is on hand may miss the sender', () => {
    const one = [from('me@work.example', '2026-11-04T10:00:00Z')]
    expect(needsWholeConversation({ messages: one, count: 1 }, true)).toBe(false)
    // Every message is on hand and all are the user's: nothing more to find.
    expect(needsWholeConversation({ messages: one, count: 1 }, false)).toBe(false)
    expect(needsWholeConversation({ messages: one }, false)).toBe(false)
    // A list summary holds only the latest message.
    expect(needsWholeConversation({ messages: one, count: 3 }, false)).toBe(true)
    // The reader shows the list summary as a placeholder while the conversation loads.
    expect(needsWholeConversation({ messages: one, partial: true }, false)).toBe(true)
    expect(needsWholeConversation({ messages: one, partial: true }, true)).toBe(false)
    expect(needsWholeConversation({}, false)).toBe(true)
  })

  it('offers the sender and their domain, but not free mail or refused domains', () => {
    expect(senderRules('Ana@Client.example', own)).toEqual({
      address: 'ana@client.example',
      domain: '@client.example',
    })
    expect(senderRules('y@gmail.com', own)).toEqual({ address: 'y@gmail.com' })
    // A domain holding one of the user's own addresses would match every conversation.
    expect(senderRules('it@sub.work.example', own).refusal).toMatch(/your own domain/)
    expect(senderRules('it@sub.work.example', own).address).toBeUndefined()
    expect(senderRules('not an address', own).refusal).toBe(
      'not an address isn’t an address a tab can use.',
    )
  })

  it('appends to an existing tab, by id or by name', () => {
    const tabs: SplitTab[] = [
      { id: 'a', name: 'Client', rules: ['@client.example'] },
      { id: 'b', name: 'GitHub', rules: ['notifications@github.com'] },
    ]
    const byId = addRule(tabs, { id: 'b' }, 'ben@partner.example')
    expect(byId).toEqual({
      tabs: [
        tabs[0],
        { id: 'b', name: 'GitHub', rules: ['notifications@github.com', 'ben@partner.example'] },
      ],
      tabId: 'b',
      already: false,
    })
    expect(tabs[1].rules).toEqual(['notifications@github.com'])
    expect(addRule(tabs, { name: ' github ' }, 'ben@partner.example').tabId).toBe('b')
  })

  it('creates a tab named after the typed text', () => {
    const tabs: SplitTab[] = [{ id: 'a', name: 'Client', rules: [] }]
    const result = addRule(tabs, { name: '  Partner ' }, '@partner.example')
    expect(result.already).toBe(false)
    expect(result.tabs).toHaveLength(2)
    expect(result.tabs[1]).toEqual({
      id: result.tabId,
      name: 'Partner',
      rules: ['@partner.example'],
    })
    expect(result.tabId).not.toBe('a')
  })

  it('says when the tab already has the rule, and leaves the tabs alone', () => {
    const tabs: SplitTab[] = [{ id: 'a', name: 'Client', rules: ['@client.example'] }]
    const result = addRule(tabs, { id: 'a' }, '@Client.example')
    expect(result).toEqual({ tabs, tabId: 'a', already: true })
    expect(result.tabs).toBe(tabs)
  })

  it('changes nothing for a tab that is gone', () => {
    const tabs: SplitTab[] = [{ id: 'a', name: 'Client', rules: [] }]
    expect(addRule(tabs, { id: 'gone' }, 'x@y.example')).toEqual({
      tabs,
      tabId: '',
      already: false,
    })
  })

  describe('picker options', () => {
    const tabs: SplitTab[] = [
      { id: 'a', name: 'Client', rules: [] },
      { id: 'b', name: 'GitHub', rules: [] },
      { id: 'c', name: 'Old GitHub', rules: [] },
    ]
    const kinds = (text: string) =>
      pickerOptions(tabs, text).options.map((o) =>
        o.kind === 'tab' ? o.tab.name : o.kind === 'create' ? 'create ' + o.name : 'new',
      )

    it('starts with New tab… and every tab', () => {
      expect(kinds('')).toEqual(['new', 'Client', 'GitHub', 'Old GitHub'])
      expect(pickerOptions(tabs, '  ').highlight).toBe(0)
    })

    it('filters by name, starting matches first, and offers a tab named as typed', () => {
      expect(kinds('git')).toEqual(['create git', 'GitHub', 'Old GitHub'])
      expect(kinds('hub')).toEqual(['create hub', 'GitHub', 'Old GitHub'])
      expect(kinds('Partner')).toEqual(['create Partner'])
    })

    it('highlights a tab only when the text starts a word of its name', () => {
      expect(pickerOptions(tabs, 'git').highlight).toBe(1)
      expect(pickerOptions(tabs, 'Partner').highlight).toBe(0)
      // "hub" is inside GitHub, not at the start of a word: Enter makes a tab called "hub".
      expect(pickerOptions(tabs, 'hub').highlight).toBe(0)
      const partners = [{ id: 'p', name: 'Partners', rules: [] }]
      expect(pickerOptions(partners, 'art')).toEqual({
        options: [
          { kind: 'create', name: 'art' },
          { kind: 'tab', tab: partners[0] },
        ],
        highlight: 0,
      })
    })

    it('offers no new tab when the text is a tab’s name', () => {
      expect(kinds(' github ')).toEqual(['GitHub', 'Old GitHub'])
      expect(pickerOptions(tabs, 'github').highlight).toBe(0)
    })
  })

  describe('pick problems', () => {
    const tabs: SplitTab[] = [{ id: 'a', name: 'Client', rules: [] }]
    const fifty = Array.from({ length: 50 }, (_, i) => ({ id: 't' + i, name: 'T' + i, rules: [] }))

    it('explains the tab limit instead of creating a 51st tab', () => {
      const limit = 'You have 50 tabs, the most there can be. Delete one to make room.'
      expect(pickProblem({ kind: 'new' }, fifty, 'x@y.example', own)).toBe(limit)
      expect(pickProblem({ kind: 'create', name: 'More' }, fifty, 'x@y.example', own)).toBe(limit)
      expect(pickProblem({ kind: 'new' }, tabs, 'x@y.example', own)).toBeUndefined()
      const named = [{ id: 'n', name: 'New', rules: [] }]
      expect(pickProblem({ kind: 'new' }, named, 'x@y.example', own)).toBeUndefined()
      expect(pickProblem({ kind: 'tab', tab: fifty[0] }, fifty, 'x@y.example', own)).toBeUndefined()
    })

    it('explains names a new tab can’t have', () => {
      expect(pickProblem({ kind: 'create', name: 'inbox' }, tabs, 'x@y.example', own)).toBe(
        'Inbox is a built-in tab. Choose another name.',
      )
      expect(pickProblem({ kind: 'create', name: 'x'.repeat(61) }, tabs, 'x@y.example', own)).toBe(
        'Keep the name to 60 characters or fewer.',
      )
      expect(
        pickProblem({ kind: 'create', name: 'Partner' }, tabs, 'x@y.example', own),
      ).toBeUndefined()
    })

    it('explains a full tab, unless it already has the rule', () => {
      const rules = Array.from({ length: 500 }, (_, i) => 'p' + i + '@client.example')
      const full = { id: 'f', name: 'Full', rules }
      expect(pickProblem({ kind: 'tab', tab: full }, [full], 'x@y.example', own)).toBe(
        '“Full” already holds 500 addresses and domains, the most a tab can.',
      )
      expect(
        pickProblem({ kind: 'tab', tab: full }, [full], 'p1@client.example', own),
      ).toBeUndefined()
    })
  })
})

describe('Important exceptions', () => {
  const important: ImportantSettings = {
    always: [
      { address: 'alerts@firebase.example', words: ['crash'] },
      { address: 'ceo@client.example' },
    ],
    never: ['bot@team.example'],
  }

  it('reads comma-separated subject words', () => {
    expect(parseWords(' Crash, FAILURE ,, ,down ')).toEqual(['crash', 'failure', 'down'])
    expect(parseWords('')).toEqual([])
    expect(parseWords(' , ')).toEqual([])
    expect(parseWords('crash, Crash')).toEqual(['crash'])
    const many = Array.from({ length: 25 }, (_, i) => 'w' + i).join(',')
    expect(parseWords(many)).toHaveLength(20)
    expect(parseWords(many)[19]).toBe('w19')
  })

  it('explains words the settings can’t hold', () => {
    expect(wordsProblem('crash, failure')).toBeUndefined()
    expect(wordsProblem('')).toBeUndefined()
    const many = Array.from({ length: 21 }, (_, i) => 'w' + i).join(',')
    expect(wordsProblem(many)).toBe('Use 20 words or fewer.')
    expect(wordsProblem('x'.repeat(101))).toBe('Keep each word to 100 characters or fewer.')
    expect(wordsProblem('crash, crash, ' + Array.from({ length: 19 }, (_, i) => 'w' + i))).toBe(
      undefined,
    )
  })

  it('always shows a sender, replacing their entry and taking them off Never', () => {
    expect(setAlways(undefined, ' New@Client.example ', [])).toEqual({
      always: [{ address: 'new@client.example' }],
      never: [],
    })
    const edited = setAlways(important, 'Alerts@Firebase.example', ['crash', 'failure'])
    expect(edited.always).toEqual([
      { address: 'alerts@firebase.example', words: ['crash', 'failure'] },
      { address: 'ceo@client.example' },
    ])
    expect(setAlways(important, 'alerts@firebase.example', []).always[0]).toEqual({
      address: 'alerts@firebase.example',
    })
    const moved = setAlways(important, 'BOT@team.example', ['report'])
    expect(moved.never).toEqual([])
    expect(moved.always[2]).toEqual({ address: 'bot@team.example', words: ['report'] })
    expect(important.always[0].words).toEqual(['crash'])
    expect(important.never).toEqual(['bot@team.example'])
  })

  it('never shows a sender, taking them off Always, and lets them back', () => {
    const off = setNever(important, 'CEO@client.example', true)
    expect(off.never).toEqual(['bot@team.example', 'ceo@client.example'])
    expect(off.always).toEqual([{ address: 'alerts@firebase.example', words: ['crash'] }])
    expect(setNever(important, 'Bot@Team.example', true)).toEqual(important)
    expect(setNever(important, 'Bot@Team.example', false)).toEqual({
      always: important.always,
      never: [],
    })
    expect(setNever(undefined, 'a@b.example', true)).toEqual({ always: [], never: ['a@b.example'] })
    expect(setNever(undefined, 'a@b.example', false)).toEqual({ always: [], never: [] })
    expect(important.always).toHaveLength(2)
  })

  it('tells whether a sender is in either list, ignoring case', () => {
    expect(importantStatus(important, 'Alerts@firebase.example')).toEqual({
      always: { address: 'alerts@firebase.example', words: ['crash'] },
      never: false,
    })
    expect(importantStatus(important, 'BOT@team.example')).toEqual({ never: true })
    expect(importantStatus(undefined, 'x@y.example')).toEqual({ never: false })
  })

  it('explains a full list, unless the sender is already on it', () => {
    const full: ImportantSettings = {
      always: Array.from({ length: 500 }, (_, i) => ({ address: 'a' + i + '@x.example' })),
      never: Array.from({ length: 500 }, (_, i) => 'n' + i + '@x.example'),
    }
    expect(importantLimit(full, 'new@x.example', 'always')).toBe(
      'Always show in Important already lists 500 senders, the most it can.',
    )
    expect(importantLimit(full, 'new@x.example', 'never')).toBe(
      'Never show in Important already lists 500 senders, the most it can.',
    )
    expect(importantLimit(full, 'A1@x.example', 'always')).toBeUndefined()
    expect(importantLimit(full, 'n1@x.example', 'never')).toBeUndefined()
    expect(importantLimit(undefined, 'new@x.example', 'always')).toBeUndefined()
  })

  it('says what Always show will do', () => {
    expect(alwaysShownText('a@x.example', [])).toBe('a@x.example will always show in Important')
    expect(alwaysShownText('a@x.example', ['crash'])).toBe(
      'a@x.example will show in Important when the subject contains “crash”',
    )
    expect(alwaysShownText('a@x.example', ['crash', 'failure', 'down'])).toBe(
      'a@x.example will show in Important when the subject contains “crash”, “failure” or “down”',
    )
  })
})

describe('Never show Undo', () => {
  const before: ImportantSettings = {
    always: [{ address: 'alerts@x.example', words: ['crash'] }, { address: 'b@x.example' }],
    never: ['bot@y.example'],
  }

  it('reverses only this sender, keeping changes made since', () => {
    const status = importantStatus(before, 'Alerts@X.example')
    // After Never: alerts@ moved from Always to Never; then Settings added two entries.
    const latest: ImportantSettings = {
      always: [{ address: 'b@x.example' }, { address: 'new@x.example' }],
      never: ['bot@y.example', 'alerts@x.example', 'other@y.example'],
    }
    expect(undoNever(latest, 'alerts@x.example', status)).toEqual({
      always: [
        { address: 'b@x.example' },
        { address: 'new@x.example' },
        { address: 'alerts@x.example', words: ['crash'] },
      ],
      never: ['bot@y.example', 'other@y.example'],
    })
  })

  it('takes a sender who was on neither list off Never', () => {
    const status = importantStatus(before, 'c@x.example')
    const latest = { always: before.always, never: [...before.never, 'c@x.example'] }
    expect(undoNever(latest, 'C@x.example', status)).toEqual(before)
  })

  it('changes nothing for a sender already on Never, or one put on Always since', () => {
    expect(undoNever(before, 'bot@y.example', importantStatus(before, 'bot@y.example'))).toEqual(
      before,
    )
    const status = importantStatus(before, 'alerts@x.example')
    const latest = { always: [{ address: 'alerts@x.example', words: ['down'] }], never: [] }
    expect(undoNever(latest, 'alerts@x.example', status)).toEqual(latest)
  })
})

describe('Settings → Inbox', () => {
  it('checks an address typed into Never show', () => {
    const important = { always: [{ address: 'a@x.example' }], never: ['n@x.example'] }
    expect(neverEntry(' New@X.example ', important)).toEqual({ address: 'new@x.example' })
    expect(neverEntry('<a@x.example>', important)).toEqual({ address: 'a@x.example' })
    expect(neverEntry('', important)).toEqual({})
    expect(neverEntry('@x.example', important)).toEqual({
      problem: 'Enter one email address, like someone@example.com.',
    })
    expect(neverEntry('not an address', important)).toEqual({
      problem: 'Enter one email address, like someone@example.com.',
    })
    expect(neverEntry('N@x.example', important)).toEqual({
      problem: 'n@x.example is already on the list.',
    })
    const full = { always: [], never: Array.from({ length: 500 }, (_, i) => i + '@x.example') }
    expect(neverEntry('new@x.example', full)).toEqual({
      problem: 'Never show in Important already lists 500 senders, the most it can.',
    })
  })

  it('checks a sender and words typed into Always show', () => {
    const important = { always: [{ address: 'a@x.example' }], never: ['n@x.example'] }
    expect(alwaysEntry(' New@X.example ', '', important)).toEqual({
      address: 'new@x.example',
      words: [],
    })
    expect(alwaysEntry('new@x.example', ' Crash, failure,, crash ', important)).toEqual({
      address: 'new@x.example',
      words: ['crash', 'failure'],
    })
    // On Never show it moves to Always, as the email's menu does.
    expect(alwaysEntry('n@x.example', '', important)).toEqual({
      address: 'n@x.example',
      words: [],
    })
    expect(alwaysEntry('', 'crash', important)).toEqual({})
    expect(alwaysEntry('@x.example', '', important)).toEqual({
      problem: 'Enter one email address, like someone@example.com.',
    })
    expect(alwaysEntry('A@x.example', '', important)).toEqual({
      problem: 'a@x.example is already on the list.',
    })
    expect(alwaysEntry('new@x.example', 'w'.repeat(101), important)).toEqual({
      problem: 'Keep each word to 100 characters or fewer.',
    })
    const full = {
      always: Array.from({ length: 500 }, (_, i) => ({ address: i + '@x.example' })),
      never: [],
    }
    expect(alwaysEntry('new@x.example', '', full)).toEqual({
      problem: 'Always show in Important already lists 500 senders, the most it can.',
    })
  })

  it('says what an import added', () => {
    const none = { newTabs: 0, updatedTabs: 0, senders: 0, skipped: 0 }
    expect(importedText({ ...none, newTabs: 4, senders: 2 })).toBe(
      'Imported 4 tabs and 2 Important senders',
    )
    expect(importedText({ ...none, newTabs: 1, updatedTabs: 2, senders: 1, skipped: 1 })).toBe(
      'Imported 1 tab, new rules for 2 tabs and 1 Important sender · 1 skipped',
    )
    expect(importedText({ ...none, updatedTabs: 1 })).toBe('Imported new rules for 1 tab')
    expect(importedText(none)).toBe(
      'Nothing new to import. You already have everything in this file.',
    )
    expect(importedText({ ...none, skipped: 3 })).toBe('Nothing imported · 3 skipped')
  })
})
