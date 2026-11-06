import { useQuery } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Inbox,
  MailMinus,
  PencilEdit,
  PenLine,
  Star,
  Trash2,
  UserRound,
} from '@inlark/ui/icons'
import {
  friendlyError,
  ownAddresses,
  type Account,
  type Address,
  type Bootstrap,
  type ImportantSettings,
  type MailQuery,
  type Message,
  type Settings,
  type SplitTab,
} from '@inlark/core'
import { api } from '../api'
import { queryClient } from '../cache'
import type { Command } from '../CommandPalette'
import type { RouteSearch } from '../main'
import { openedThreadQuery } from '../read-ahead'
import {
  ignoreInputsForCommand,
  useShortcutText,
  type ShortcutHandler,
  type ShortcutId,
} from '../shortcuts'
import type { AddToTabState } from './AddToTab'
import type { AlwaysShowState } from './ImportantException'
import {
  activeTabId,
  addRule,
  adjacentTab,
  alwaysShownText,
  importantLimit,
  importantStatus,
  moveTab,
  needsWholeConversation,
  putTab,
  senderOf,
  setAlways,
  setNever,
  tabElementId,
  tabEntries,
  tabForShortcut,
  tabMoves,
  tabPanelId,
  undoNever,
  untabbedAccounts,
  whenIdle,
  type TabAction,
} from './tab-model'
import { splitSaves } from './split-saves'
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
  showToast,
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
  /** A toast with an Undo button. */
  showToast: (toast: { text: string; onUndo: () => void }) => void
  /** Saves and shows any error itself; resolves to whether the save worked. */
  saveSettings: (patch: Partial<Settings>) => Promise<boolean>
  /**
   * The conversation "Add sender to tab…" works on: the open one, or the focused one. "Always
   * show" and "Never show" in Important work on the open one.
   */
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
  // Without a prototype, so a tab id such as `constructor` reads its own count or none.
  const counts: Record<string, number> = Object.assign(Object.create(null), tabCounts.data, {
    inbox: inboxUnread,
  })

  const select = (id: string) => {
    if (visible && !route.thread && id === active) return
    go({ view: 'inbox', account: route.account, tab: id === 'inbox' ? undefined : id })
  }
  // Split saves run one at a time, here and in Settings → Inbox, so none races another.
  const queue = splitSaves
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
  /**
   * The newest sender in the conversation who isn't the user. Says why when there is none, and
   * gives nothing if the user moved on while the conversation loaded.
   */
  const findSender = async (): Promise<Address | undefined> => {
    const conversation = addToTab.conversation()
    if (!conversation) return
    const { accountId, id } = conversation
    let sender = senderOf(conversation.messages ?? [], own)
    // What is on hand may be only the latest message, which can be the user's own reply.
    if (needsWholeConversation(conversation, !!sender)) {
      try {
        sender = senderOf(await api.conversation(accountId, id, { prefetch: true }), own)
      } catch (error) {
        return void notify(friendlyError(error), 'error')
      }
      // Moved on while it loaded: another conversation, or another dialog or Ctrl+K is open.
      const now = target.current.conversation()
      if (now?.accountId !== accountId || now.id !== id) return
      if (document.querySelector('[role="dialog"][data-open]')) return
    }
    if (!sender) return void notify('Every message in this conversation is from you.', 'info')
    return sender
  }
  /** Opens the add-to-tab picker for the newest sender who isn't the user. */
  const openPicker = async (fromCommand = false) => {
    const sender = await findSender()
    if (sender) setPicker({ sender, fromCommand, open: true, seq: ++dialogs.current })
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

  // The cache, not this render's settings, so a quick second change builds on the first.
  const latestImportant = () =>
    queryClient.getQueryData<Bootstrap>(['bootstrap'])?.settings.important ?? settings.important
  /**
   * Saves a change to Important's Always and Never lists, one at a time like tab saves, and
   * reloads the Important list. Resolves to the lists before the change, or false if it failed.
   */
  const changeImportant = (
    change: (important?: ImportantSettings) => ImportantSettings | undefined,
  ) =>
    queue(async () => {
      const before = latestImportant()
      if (!(await saveSettings({ important: change(before) }))) return false
      // Tab counts follow on their own: their key holds these lists.
      void queryClient.invalidateQueries({
        queryKey: ['mail'],
        predicate: (query) => (query.queryKey[1] as MailQuery | undefined)?.tab === 'important',
      })
      return { before }
    })

  // The open conversation's sender, once it has loaded: null when every message is the user's.
  const openKey =
    route.thread && route.threadAccount
      ? openedThreadQuery(api, route.threadAccount, route.thread, {}).queryKey
      : undefined
  const openMessages = openKey && queryClient.getQueryData<Message[]>(openKey)
  const openSender = openMessages ? (senderOf(openMessages, own) ?? null) : undefined
  const exceptions = addToTab.available && !!route.thread && openSender !== null
  // Until the conversation loads, the items read as for a sender on neither list.
  const status = openSender
    ? importantStatus(settings.important, openSender.email)
    : { always: undefined, never: false }

  const [always, setAlwaysDialog] = useState<AlwaysShowState>()
  /** "Always show in Important…": the subject words box, with the sender's words if any. */
  const openAlways = async (fromCommand = false) => {
    const sender = await findSender()
    if (!sender) return
    const important = latestImportant()
    const limit = importantLimit(important, sender.email, 'always')
    if (limit) return notify(limit, 'info')
    const entry = importantStatus(important, sender.email).always
    setAlwaysDialog({
      sender,
      words: entry?.words ?? [],
      editing: !!entry,
      fromCommand,
      open: true,
      seq: ++dialogs.current,
    })
  }
  const closeAlways = () => {
    focusActiveTabAfterDialog(!!always?.fromCommand)
    setAlwaysDialog((shown) => shown && { ...shown, open: false })
  }
  /** Saves the sender's Always entry; a failed save keeps the box open. */
  const saveAlways = async (words: string[]) => {
    if (!always) return
    const { email } = always.sender
    if (!(await changeImportant((important) => setAlways(important, email, words)))) return
    closeAlways()
    notify(alwaysShownText(email, words))
  }
  /** "Never show in Important" (`on`), or "Show in Important again"; at once, with Undo. */
  const neverShow = async (on: boolean) => {
    const sender = await findSender()
    if (!sender) return
    const { email } = sender
    const limit = on && importantLimit(latestImportant(), email, 'never')
    if (limit) return notify(limit, 'info')
    const saved = await changeImportant((important) => setNever(important, email, on))
    if (!saved) return
    // Only this sender, on the latest lists, so changes made since (in Settings) survive.
    const before = importantStatus(saved.before, email)
    const undo = async () => {
      if (await changeImportant((important) => undoNever(important, email, before)))
        notify('Undone.')
    }
    if (on) showToast({ text: email + ' won’t show in Important', onUndo: () => void undo() })
    else notify(email + ' can show in Important again')
  }
  const alwaysLabel = status.always ? 'Edit Always show…' : 'Always show in Important…'
  const neverLabel = status.never ? 'Show in Important again' : 'Never show in Important'

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
  if (exceptions)
    commands.unshift(
      {
        id: 'important-always',
        group: 'Tabs',
        label: alwaysLabel,
        icon: Star,
        keywords: 'split inbox important sender exception subject words',
        run: () => void openAlways(true),
      },
      {
        id: 'important-never',
        group: 'Tabs',
        label: neverLabel,
        icon: MailMinus,
        keywords: 'split inbox important sender exception hide',
        run: () => void neverShow(!status.never),
      },
    )
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
    /** A tab dialog, the add-to-tab picker or the Always show box is open: shortcuts wait. */
    dialogOpen: !!dialog?.open || !!picker?.open || !!always?.open,
    /** "Add sender to tab…" for the open conversation, from the reader's menu. */
    addSender: addToTab.available ? () => void openPicker() : undefined,
    /** The reader menu's "Always show" and "Never show" items for the open conversation. */
    important: exceptions
      ? {
          alwaysShow: { label: alwaysLabel, run: () => void openAlways() },
          neverShow: { label: neverLabel, run: () => void neverShow(!status.never) },
        }
      : undefined,
    /** Props for `TabDialogs`. */
    dialogs: {
      dialog,
      tabs: userTabs,
      own,
      onClose: () => closeDialog(),
      onSave: saveTab,
      onDelete: deleteTab,
      picker: { state: picker, onClose: () => closePicker(), onPick: pickTab, onNewTab: newTabFor },
      always: { state: always, onClose: closeAlways, onSave: saveAlways },
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
