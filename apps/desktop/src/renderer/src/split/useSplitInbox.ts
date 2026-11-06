import { useQuery } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Inbox,
  PencilEdit,
  PenLine,
  Trash2,
  UserRound,
} from '@inlark/ui/icons'
import {
  ownAddresses,
  type Account,
  type Bootstrap,
  type Settings,
  type SplitTab,
} from '@inlark/core'
import { api } from '../api'
import { queryClient } from '../cache'
import type { Command } from '../CommandPalette'
import type { RouteSearch } from '../main'
import {
  ignoreInputsForCommand,
  useShortcutText,
  type ShortcutHandler,
  type ShortcutId,
} from '../shortcuts'
import {
  activeTabId,
  adjacentTab,
  moveTab,
  putTab,
  serialQueue,
  tabElementId,
  tabEntries,
  tabForShortcut,
  tabMoves,
  tabPanelId,
  untabbedAccounts,
  whenIdle,
  type TabAction,
} from './tab-model'
import type { TabDialogState } from './TabEditor'
import type { TabMenuState } from './TabRow'

/** The tab row's state, shortcuts and commands, kept out of App.tsx. */
export function useSplitInbox({
  settings,
  accounts,
  route,
  go,
  inboxUnread,
  saveSettings,
}: {
  settings: Settings
  accounts: Account[]
  route: RouteSearch
  go: (next: RouteSearch) => void
  /** The sidebar's inbox unread count for the accounts in scope. */
  inboxUnread: number
  /** For the tab editor and pickers that come next. */
  notify: (text: string, tone?: 'error' | 'info') => void
  /** Saves and shows any error itself; resolves to whether the save worked. */
  saveSettings: (patch: Partial<Settings>) => Promise<boolean>
}) {
  const keys = useShortcutText()
  const entries = tabEntries(settings)
  const active = activeTabId(route.tab, entries)
  const visible = (!route.view || route.view === 'inbox') && !route.folder && !route.q
  const accountId = accounts.some((a) => a.id === route.account) ? route.account : undefined
  // Order doesn't change counts, so reordering tabs shouldn't recount them.
  const tabsKey = JSON.stringify([
    [...(settings.splitTabs ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    settings.important ?? null,
  ])
  const tabCounts = useQuery({
    queryKey: ['tabCounts', accountId, tabsKey],
    queryFn: async ({ signal }) => {
      // Counts share the index worker with page loads, so they wait until the list has its mail.
      await whenIdle(queryClient, ['mail'])
      signal.throwIfAborted()
      return api.tabCounts(accountId)
    },
    enabled: visible && accounts.length > 0,
    staleTime: 10_000,
    // Edited tabs keep their old counts until the new ones arrive; another account doesn't.
    placeholderData: (previous, query) => (query?.queryKey[1] === accountId ? previous : undefined),
  })
  const counts: Record<string, number> = { ...tabCounts.data, inbox: inboxUnread }

  const select = (id: string) => {
    if (visible && !route.thread && id === active) return
    go({ view: 'inbox', account: route.account, tab: id === 'inbox' ? undefined : id })
  }
  // Tab saves run one at a time, so a later one never races an earlier one.
  const [queue] = useState(serialQueue)
  const saveTabs = (tabs: SplitTab[]) => queue(() => saveSettings({ splitTabs: tabs }))

  // While reorders save: the order last dropped, and the last one known to be saved.
  const shownOrder = useRef<SplitTab[]>(undefined)
  const savedOrder = useRef<SplitTab[]>([])
  const showTabs = (tabs: SplitTab[]) =>
    queryClient.setQueryData<Bootstrap>(
      ['bootstrap'],
      (old) => old && { ...old, settings: { ...old.settings, splitTabs: tabs } },
    )
  /** Shows the new order at once; saves run one at a time and a failed one puts it back. */
  const reorder = (id: string, toIndex: number) => {
    // The cache, not this render's settings, so a quick second drag builds on the first.
    const before = queryClient.getQueryData<Bootstrap>(['bootstrap'])?.settings.splitTabs ?? []
    const tabs = moveTab(before, id, toIndex)
    if (!shownOrder.current) savedOrder.current = before
    shownOrder.current = tabs
    showTabs(tabs)
    void saveTabs(tabs).then((saved) => {
      if (saved) savedOrder.current = tabs
      // A newer order is waiting to save; keep it on screen over this save's result.
      if (shownOrder.current !== tabs) return showTabs(shownOrder.current!)
      shownOrder.current = undefined
      if (!saved) showTabs(savedOrder.current)
    })
  }

  const userTabs = settings.splitTabs ?? []
  // The cache, not this render's settings, so an edit builds on a reorder still saving.
  const latestTabs = () =>
    queryClient.getQueryData<Bootstrap>(['bootstrap'])?.settings.splitTabs ?? userTabs
  const own = useMemo(() => ownAddresses(accounts), [accounts])

  const [menu, setMenu] = useState<TabMenuState>()
  const openMenu = (id: string, anchor: HTMLElement) => {
    if (userTabs.some((tab) => tab.id === id)) setMenu({ id, anchor, open: true })
  }
  const closeMenu = () => setMenu((shown) => shown && { ...shown, open: false })

  const [dialog, setDialog] = useState<TabDialogState>()
  const dialogs = useRef(0)
  const editTab = (tab: SplitTab | undefined, focus: 'name' | 'rules') =>
    setDialog({ kind: 'edit', tab, focus, open: true, seq: ++dialogs.current })
  const closeDialog = () => setDialog((shown) => shown && { ...shown, open: false })
  const add = () => editTab(undefined, 'name')

  const act = (id: string, action: TabAction) => {
    const tab = latestTabs().find((t) => t.id === id)
    if (!tab) return
    if (action === 'rules' || action === 'rename')
      editTab(tab, action === 'rules' ? 'rules' : 'name')
    else if (action === 'delete')
      setDialog({ kind: 'delete', tab, open: true, seq: ++dialogs.current })
    else {
      const to = tabMoves(latestTabs(), id)[action]
      if (to !== undefined) reorder(id, to)
    }
  }
  /** Saves a new or edited tab; a new one opens once saved. A failed save keeps the box open. */
  const saveTab = async (tab: SplitTab) => {
    const tabs = latestTabs()
    const added = !tabs.some((t) => t.id === tab.id)
    if (!(await saveTabs(putTab(tabs, tab)))) return
    closeDialog()
    if (added) select(tab.id)
  }
  const deleteTab = async (tab: SplitTab) => {
    if (!(await saveTabs(latestTabs().filter((t) => t.id !== tab.id)))) return
    closeDialog()
    if (tab.id === active) select('inbox')
  }

  const shortcutHandlers: Partial<Record<ShortcutId, ShortcutHandler>> = {
    // Undefined keeps the caller's `enabled`, so dialogs and the composer still block these.
    nextTab: {
      run: () => select(adjacentTab(active, entries, 1)),
      enabled: visible ? undefined : false,
      ignoreInputs: ignoreInputsForCommand,
    },
    previousTab: {
      run: () => select(adjacentTab(active, entries, -1)),
      enabled: visible ? undefined : false,
      ignoreInputs: ignoreInputsForCommand,
    },
  }
  for (let n = 1; n <= 9; n++)
    shortcutHandlers[('goTab' + n) as ShortcutId] = {
      run: () => {
        const id = tabForShortcut(n, entries)
        if (id) select(id)
      },
      ignoreInputs: ignoreInputsForCommand,
    }

  const commands: Command[] = entries.map((entry, index) => ({
    id: 'tab-' + entry.id,
    group: 'Tabs',
    label: entry.name + ' tab',
    icon: entry.id === 'important' ? UserRound : Inbox,
    key: index < 9 ? keys(('goTab' + (index + 1)) as ShortcutId) : undefined,
    keywords: 'go open switch split inbox',
    checked: visible && entry.id === active,
    run: () => select(entry.id),
  }))

  // The active user tab's menu, in Ctrl+K.
  const activeTab = visible ? userTabs.find((tab) => tab.id === active) : undefined
  if (activeTab) {
    const moves = tabMoves(userTabs, activeTab.id)
    const command = (action: TabAction, label: string, icon: Command['icon']): Command => ({
      id: 'tab-action-' + action,
      group: 'Tabs',
      label,
      icon,
      keywords: 'split inbox ' + activeTab.name,
      run: () => act(activeTab.id, action),
    })
    commands.push(
      command('rules', 'Edit tab rules', PencilEdit),
      command('rename', 'Rename tab', PenLine),
      ...(moves.left !== undefined ? [command('left', 'Move tab left', ChevronLeft)] : []),
      ...(moves.right !== undefined ? [command('right', 'Move tab right', ChevronRight)] : []),
      command('delete', 'Delete tab', Trash2),
    )
  }

  const empty =
    visible && active !== 'inbox'
      ? {
          entry: entries.find((entry) => entry.id === active)!,
          untabbed: untabbedAccounts(accounts, accountId).map((a) => a.name),
        }
      : undefined

  return {
    entries,
    active,
    counts,
    visible,
    select,
    saveTabs,
    /** A tab dialog is open, so the app's shortcuts wait. */
    dialogOpen: !!dialog?.open,
    /** Props for `TabDialogs`. */
    dialogs: {
      dialog,
      tabs: userTabs,
      own,
      onClose: closeDialog,
      onSave: saveTab,
      onDelete: deleteTab,
    },
    shortcutHandlers,
    commands,
    /** The `tab` route and query parameter for the list on screen, if any. */
    tabParam: visible && active !== 'inbox' ? active : undefined,
    /** For `TabEmptyState` when Important or a user tab is empty. */
    empty,
    /** Ties the conversation list to the active tab while the row shows. */
    panel: visible ? { id: tabPanelId, labelledBy: tabElementId(active) } : undefined,
    /** Props for `TabRow`. */
    row: {
      entries,
      active,
      counts,
      onSelect: select,
      onReorder: reorder,
      onMenu: openMenu,
      onAdd: add,
      menu,
      onMenuClose: closeMenu,
      onMenuAction: act,
    },
  }
}
