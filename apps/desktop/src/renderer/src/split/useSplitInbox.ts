import { useIsFetching, useQuery } from '@tanstack/react-query'
import { Inbox, UserRound } from '@inlark/ui/icons'
import { friendlyError, type Account, type Settings, type SplitTab } from '@inlark/core'
import { api } from '../api'
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
  tabEmptyCopy,
  tabEntries,
  tabForShortcut,
  untabbedAccounts,
} from './tab-model'

/** The tab row's state, shortcuts and commands, kept out of App.tsx. */
export function useSplitInbox({
  settings,
  accounts,
  route,
  go,
  inboxUnread,
  notify,
  saveSettings,
}: {
  settings: Settings
  accounts: Account[]
  route: RouteSearch
  go: (next: RouteSearch) => void
  /** The sidebar's inbox unread count for the accounts in scope. */
  inboxUnread: number
  notify: (text: string, tone?: 'error' | 'info') => void
  saveSettings: (patch: Partial<Settings>) => Promise<void>
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
  // Counts share the index worker with page loads, so they wait until the list has its mail.
  const listLoading = useIsFetching({ queryKey: ['mail'] }) > 0
  const tabCounts = useQuery({
    queryKey: ['tabCounts', accountId, tabsKey],
    queryFn: () => api.tabCounts(accountId),
    enabled: visible && accounts.length > 0 && !listLoading,
    staleTime: 10_000,
    // Edited tabs keep their old counts until the new ones arrive; another account doesn't.
    placeholderData: (previous, query) => (query?.queryKey[1] === accountId ? previous : undefined),
  })
  const counts: Record<string, number> = { ...tabCounts.data, inbox: inboxUnread }

  const select = (id: string) => {
    if (visible && !route.thread && id === active) return
    go({ view: 'inbox', account: route.account, tab: id === 'inbox' ? undefined : id })
  }
  const saveTabs = async (tabs: SplitTab[]) => {
    try {
      await saveSettings({ splitTabs: tabs })
    } catch (error) {
      notify(friendlyError(error), 'error')
    }
  }
  const reorder = (id: string, toIndex: number) =>
    void saveTabs(moveTab(settings.splitTabs ?? [], id, toIndex))
  // The tab menu and the new-tab box come with the tab editor.
  const openMenu = (_id: string, _anchor: HTMLElement) => {}
  const add = () => {}

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

  const activeEntry = entries.find((entry) => entry.id === active)!
  const empty =
    visible && active !== 'inbox'
      ? tabEmptyCopy(
          activeEntry,
          untabbedAccounts(accounts, accountId).map((a) => a.name),
        )
      : undefined

  return {
    entries,
    active,
    counts,
    visible,
    select,
    saveTabs,
    shortcutHandlers,
    commands,
    /** What an empty list says in Important or a user tab. */
    empty,
    /** Props for `TabRow`. */
    row: {
      entries,
      active,
      counts,
      onSelect: select,
      onReorder: reorder,
      onMenu: openMenu,
      onAdd: add,
    },
  }
}
