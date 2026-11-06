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
  friendlyError,
  ownAddresses,
  type Account,
  type Bootstrap,
  type Message,
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
import type { AddToTabState } from './AddToTab'
import {
  activeTabId,
  addRule,
  adjacentTab,
  moveTab,
  needsWholeConversation,
  putTab,
  senderOf,
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
  notify,
  saveSettings,
  addToTab,
}: {
  settings: Settings
  accounts: Account[]
  route: RouteSearch
  go: (next: RouteSearch) => void
  /** The sidebar's inbox unread count for the accounts in scope. */
  inboxUnread: number
  notify: (text: string, tone?: 'error' | 'info') => void
  /** Saves and shows any error itself; resolves to whether the save worked. */
  saveSettings: (patch: Partial<Settings>) => Promise<boolean>
  /** The conversation "Add sender to tab…" works on: the open one, or the focused one. */
  addToTab: {
    available: boolean
    /** Read when the picker opens. List summaries hold only the latest message. */
    conversation: () =>
      | {
          accountId: string
          id: string
          count?: number
          messages?: Pick<Message, 'from' | 'receivedAt'>[]
          /** The messages are a placeholder while the conversation loads. */
          partial?: boolean
        }
      | undefined
  }
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
  const closeMenu = () => {
    setMenu((shown) => shown && { ...shown, open: false })
    // Forget it once it has faded out, so a deleted tab's button isn't held on to.
    setTimeout(() => setMenu((shown) => (shown?.open ? shown : undefined)), 300)
  }
  const shownMenu = menu && userTabs.some((tab) => tab.id === menu.id) ? menu : undefined

  const [dialog, setDialog] = useState<TabDialogState>()
  const dialogs = useRef(0)
  const editTab = (tab: SplitTab | undefined, focus: 'name' | 'rules', fromCommand = false) =>
    setDialog({ kind: 'edit', tab, focus, fromCommand, open: true, seq: ++dialogs.current })
  /** Closes the tab dialog; focus goes to the active tab when it came from Ctrl+K or was lost. */
  const closeDialog = (toTab = false) => {
    focusActiveTabAfterDialog(toTab || !!dialog?.fromCommand)
    setDialog((shown) => shown && { ...shown, open: false })
  }
  const add = () => editTab(undefined, 'name')

  /** Runs a tab menu item; `fromCommand` when chosen in Ctrl+K. */
  const act = (id: string, action: TabAction, fromCommand = false) => {
    const tab = latestTabs().find((t) => t.id === id)
    if (!tab) return
    if (action === 'rules' || action === 'rename')
      editTab(tab, action === 'rules' ? 'rules' : 'name', fromCommand)
    else if (action === 'delete')
      setDialog({ kind: 'delete', tab, fromCommand, open: true, seq: ++dialogs.current })
    else {
      const to = tabMoves(latestTabs(), id)[action]
      if (to !== undefined) reorder(id, to)
    }
  }
  /**
   * Saves a new or edited tab; a new one opens once saved, unless it was made for an email's
   * sender. A failed save keeps the box open.
   */
  const saveTab = async (tab: SplitTab) => {
    const tabs = latestTabs()
    const added = !tabs.some((t) => t.id === tab.id)
    const sender = dialog?.kind === 'edit' ? dialog.added : undefined
    if (!(await saveTabs(putTab(tabs, tab)))) return
    closeDialog()
    if (sender) {
      if (tab.rules.some((r) => r.toLowerCase() === sender.toLowerCase()))
        notify('Added ' + sender + ' to ' + tab.name)
    } else if (added) select(tab.id)
  }
  const deleteTab = async (tab: SplitTab) => {
    if (!(await saveTabs(latestTabs().filter((t) => t.id !== tab.id)))) return
    // The tab's button is gone, so focus the active tab: Inbox when it was this one.
    closeDialog(true)
    if (tab.id === active) select('inbox')
  }

  const [picker, setPicker] = useState<AddToTabState>()
  // The latest render's conversation, for a picker that had to wait for one.
  const target = useRef(addToTab)
  target.current = addToTab
  /** Opens the add-to-tab picker for the newest sender who isn't the user. */
  const openPicker = async (fromCommand = false) => {
    const conversation = addToTab.conversation()
    if (!conversation) return
    const { accountId, id } = conversation
    let sender = senderOf(conversation.messages ?? [], own)
    // What is on hand may be only the latest message, which can be the user's own reply.
    if (needsWholeConversation(conversation, !!sender)) {
      try {
        sender = senderOf(await api.conversation(accountId, id, { prefetch: true }), own)
      } catch (error) {
        return notify(friendlyError(error), 'error')
      }
      // Moved on while it loaded: another conversation, or another dialog or Ctrl+K is open.
      const now = target.current.conversation()
      if (now?.accountId !== accountId || now.id !== id) return
      if (document.querySelector('[role="dialog"][data-open]')) return
    }
    if (!sender) return notify('Every message in this conversation is from you.', 'info')
    setPicker({ sender, fromCommand, open: true, seq: ++dialogs.current })
  }
  const closePicker = (refocus = true) => {
    if (refocus) focusActiveTabAfterDialog(!!picker?.fromCommand)
    setPicker((shown) => shown && { ...shown, open: false })
  }
  /** Adds the rule to a tab, or a new tab named as typed; a failed save keeps the picker open. */
  const pickTab = async (target: { id?: string; name?: string }, rule: string) => {
    const result = addRule(latestTabs(), target, rule)
    const tab = result.tabs.find((t) => t.id === result.tabId)
    if (!tab) return closePicker()
    if (!result.already && !(await saveTabs(result.tabs))) return
    closePicker()
    notify(result.already ? 'Already in ' + tab.name : 'Added ' + rule + ' to ' + tab.name)
  }
  /** "New tab…": the tab editor, with the sender's rule in it. */
  const newTabFor = (rule: string) => {
    closePicker(false)
    setDialog({
      kind: 'edit',
      focus: 'name',
      rules: [rule],
      added: rule,
      fromCommand: picker?.fromCommand,
      open: true,
      seq: ++dialogs.current,
    })
  }

  const shortcutHandlers: Partial<Record<ShortcutId, ShortcutHandler>> = {
    addToTab: {
      run: () => void openPicker(),
      enabled: addToTab.available ? undefined : false,
    },
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
  if (addToTab.available)
    commands.unshift({
      id: 'tab-add-sender',
      group: 'Tabs',
      label: 'Add sender to tab…',
      icon: UserRound,
      key: keys('addToTab'),
      keywords: 'split inbox sender domain rule',
      run: () => void openPicker(true),
    })

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
      run: () => act(activeTab.id, action, true),
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
    /** A tab dialog or the add-to-tab picker is open, so the app's shortcuts wait. */
    dialogOpen: !!dialog?.open || !!picker?.open,
    /** "Add sender to tab…" for the open conversation, from the reader's menu. */
    addSender: addToTab.available ? () => void openPicker() : undefined,
    /** Props for `TabDialogs`. */
    dialogs: {
      dialog,
      tabs: userTabs,
      own,
      onClose: () => closeDialog(),
      onSave: saveTab,
      onDelete: deleteTab,
      picker: { state: picker, onClose: () => closePicker(), onPick: pickTab, onNewTab: newTabFor },
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
      menu: shownMenu,
      onMenuClose: closeMenu,
      onMenuAction: act,
    },
  }
}

/**
 * Once the tab dialog has gone, focuses the active tab: always with `always`, otherwise only when
 * focus was left on the page itself or on the menu's unseen trigger.
 */
function focusActiveTabAfterDialog(always: boolean) {
  let frames = 0
  const check = () => {
    if (document.querySelector('[role="dialog"]') && ++frames < 60)
      return void requestAnimationFrame(check)
    const focused = document.activeElement
    const lost =
      !focused || focused === document.body || focused.classList.contains('tab-menu-anchor')
    if (always || lost)
      document
        .querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"][aria-controls="' + tabPanelId + '"]',
        )
        ?.focus()
  }
  requestAnimationFrame(check)
}
