import type { Bootstrap, MailQuery, Settings, SplitTab } from '@inlark/core'
import { api } from '../api'
import { queryClient } from '../cache'
import { serialQueue } from './tab-model'

/**
 * One queue for every split inbox save (the tab row, the reader's menu and Settings → Inbox), so
 * a save never races another and each builds on the one before.
 */
export const splitSaves = serialQueue()

type SplitLists = Pick<Settings, 'splitTabs' | 'important'>

/** Whether going from `before` to `after` can change which conversations a tab lists. */
export function tabListsChanged(before: SplitLists, after: SplitLists): boolean {
  // By id, so reordering and renaming tabs leave the lists alone.
  const rules = (s: SplitLists) =>
    JSON.stringify(
      [...(s.splitTabs ?? [])]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((t) => [t.id, t.rules]),
    )
  const important = (s: SplitLists) => JSON.stringify(s.important ?? null)
  return rules(before) !== rules(after) || important(before) !== important(after)
}

/**
 * Reloads the lists of tab `tab`, or of every tab and Important: their conversations come from
 * the saved settings, which the list's query key doesn't hold. Tab counts follow on their own.
 */
export function reloadTabLists(tab?: string) {
  void queryClient.invalidateQueries({
    queryKey: ['mail'],
    predicate: (query) => {
      const shown = (query.queryKey[1] as MailQuery | undefined)?.tab
      return tab ? shown === tab : !!shown
    },
  })
}

const cachedSettings = () => queryClient.getQueryData<Bootstrap>(['bootstrap'])?.settings

/**
 * Saves `change` applied to the latest cached settings, once earlier split saves are done, and
 * puts the result in the cache. Rejects when the save fails.
 */
export function saveSplitSettings(
  change: (latest: Settings) => Partial<Settings>,
): Promise<Settings> {
  return splitSaves(async () => {
    const latest = cachedSettings()
    if (!latest) throw new Error('Settings haven’t loaded yet. Try again in a moment.')
    const next = await api.settings({ ...latest, ...change(latest) })
    queryClient.setQueryData<Bootstrap>(['bootstrap'], (old) => old && { ...old, settings: next })
    if (tabListsChanged(latest, next)) reloadTabLists()
    return next
  })
}

/**
 * The tab row's saves: `change` gets the tabs as the saves before it left them, and gives the
 * tabs to save, or nothing when there is nothing to save. `save` stores them in the cache and
 * shows any error itself. Resolves to whether the tabs are saved.
 */
export function queueTabSave(
  save: (patch: Partial<Settings>) => Promise<boolean>,
  change: (latest: SplitTab[]) => SplitTab[] | undefined,
): Promise<boolean> {
  return splitSaves(async () => {
    const latest = cachedSettings()
    if (!latest) return false
    const before = latest.splitTabs ?? []
    const tabs = change(before)
    if (!tabs) return true
    const saved = await save({ splitTabs: tabs })
    if (saved && tabListsChanged({ splitTabs: before }, { splitTabs: tabs })) reloadTabLists()
    return saved
  })
}
