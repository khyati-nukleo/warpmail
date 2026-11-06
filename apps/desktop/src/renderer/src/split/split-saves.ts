import type { Bootstrap, Settings } from '@inlark/core'
import { api } from '../api'
import { queryClient } from '../cache'
import { serialQueue } from './tab-model'

/**
 * One queue for every split inbox save (the tab row, the reader's menu and Settings → Inbox), so
 * a save never races another and each builds on the one before.
 */
export const splitSaves = serialQueue()

/**
 * Saves `change` applied to the latest cached settings, once earlier split saves are done, and
 * puts the result in the cache. Rejects when the save fails.
 */
export function saveSplitSettings(
  change: (latest: Settings) => Partial<Settings>,
): Promise<Settings> {
  return splitSaves(async () => {
    const latest = queryClient.getQueryData<Bootstrap>(['bootstrap'])?.settings
    if (!latest) throw new Error('Settings haven’t loaded yet. Try again in a moment.')
    const next = await api.settings({ ...latest, ...change(latest) })
    queryClient.setQueryData<Bootstrap>(['bootstrap'], (old) => old && { ...old, settings: next })
    return next
  })
}
