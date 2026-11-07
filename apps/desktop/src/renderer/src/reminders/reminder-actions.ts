import {
  friendlyError,
  type Conversation,
  type DesktopMailAPI,
  type ReminderSnooze,
  type Settings,
} from '@inlark/core'
import type { Command } from '../CommandPalette'
import type { ShortcutHandler, ShortcutId } from '../shortcuts'
import { snoozeDetail } from '../snooze/snooze-model'

/** The email a reminder is about, as `dismissReminder` and a snooze name it. */
export type ReminderTarget = { accountId: string; threadId: string; messageId: string }

/** Snoozes kept this long after they come back, so a late sync still finds them. */
const keepDays = 30
const snoozeLimit = 500
const dayMs = 86_400_000

/** What dismiss and snooze need from the app; passed in so they can be tested. */
export interface ReminderDeps {
  api: Pick<DesktopMailAPI, 'dismissReminder' | 'restoreReminder'>
  /** Saves `change` applied to the latest settings, after earlier saves; rejects on failure. */
  save: (change: (latest: Settings) => Partial<Settings>) => Promise<unknown>
  /** The latest saved settings, if loaded. */
  settings: () => Settings | undefined
  notify: (text: string, tone?: 'error' | 'info') => void
  showToast: (toast: { text: string; onUndo: () => void }) => void
  /** Reloads the lists, which main works out again once a reminder changes. */
  reload: () => void
  now?: () => number
}

export function reminderTarget(
  conversation: Pick<Conversation, 'accountId' | 'id' | 'reminder'> | undefined,
): ReminderTarget | undefined {
  const reminder = conversation?.reminder
  return reminder
    ? {
        accountId: conversation.accountId,
        threadId: conversation.id,
        messageId: reminder.messageId,
      }
    : undefined
}

const sameThread = (a: Pick<ReminderSnooze, 'accountId' | 'threadId'>, b: typeof a) =>
  a.accountId === b.accountId && a.threadId === b.threadId

/** `list` without the thread's snoozes. */
const withoutThread = (list: ReminderSnooze[] = [], target: ReminderTarget) =>
  list.filter((s) => !sameThread(s, target))

/**
 * `list` with `entry` in place of the thread's earlier snoozes, less those back for over a month,
 * and at most the newest 500.
 */
export function withSnooze(
  list: ReminderSnooze[] = [],
  entry: ReminderSnooze,
  now: number,
): ReminderSnooze[] {
  const kept = list.filter((s) => !sameThread(s, entry) && s.until >= now - keepDays * dayMs)
  return [...kept, entry].slice(-snoozeLimit)
}

/** Dismisses the reminder everywhere, with Undo. A snooze on the thread goes too. */
export async function dismissReminder(target: ReminderTarget, deps: ReminderDeps) {
  try {
    await deps.api.dismissReminder(target)
  } catch (error) {
    return deps.notify(friendlyError(error), 'error')
  }
  let removed: ReminderSnooze[] = []
  if (deps.settings()?.reminderSnoozes?.some((s) => sameThread(s, target)))
    // Only tidies: a dismissed reminder stays hidden whatever its snooze says.
    await deps
      .save((latest) => {
        removed = (latest.reminderSnoozes ?? []).filter((s) => sameThread(s, target))
        return { reminderSnoozes: withoutThread(latest.reminderSnoozes, target) }
      })
      .catch(() => (removed = []))
  deps.reload()
  const undo = async () => {
    try {
      await deps.api.restoreReminder(target)
      // Put the snooze back unless the thread was snoozed again since.
      if (removed.length)
        await deps.save((latest) =>
          latest.reminderSnoozes?.some((s) => sameThread(s, target))
            ? {}
            : { reminderSnoozes: [...(latest.reminderSnoozes ?? []), ...removed] },
        )
      deps.notify('Undone.')
    } catch (error) {
      deps.notify(friendlyError(error), 'error')
    }
    deps.reload()
  }
  deps.showToast({ text: 'Reminder dismissed', onUndo: () => void undo() })
}

/** Snoozes the reminder until `until`, with Undo back to the thread's earlier snooze, if any. */
export async function snoozeReminder(target: ReminderTarget, until: number, deps: ReminderDeps) {
  const entry: ReminderSnooze = { ...target, until }
  const now = deps.now?.() ?? Date.now()
  let previous: ReminderSnooze[] = []
  try {
    await deps.save((latest) => {
      previous = (latest.reminderSnoozes ?? []).filter((s) => sameThread(s, target))
      return { reminderSnoozes: withSnooze(latest.reminderSnoozes, entry, now) }
    })
  } catch (error) {
    return deps.notify(friendlyError(error), 'error')
  }
  deps.reload()
  const undo = async () => {
    try {
      // Only this thread, on the latest list, and only while this snooze is still the one saved.
      await deps.save((latest) => {
        const list = latest.reminderSnoozes ?? []
        const current = list.find((s) => sameThread(s, target))
        if (current?.until !== until || current.messageId !== target.messageId) return {}
        return { reminderSnoozes: [...withoutThread(list, target), ...previous] }
      })
      deps.notify('Undone.')
    } catch (error) {
      deps.notify(friendlyError(error), 'error')
    }
    deps.reload()
  }
  deps.showToast({ text: 'Snoozed until ' + snoozeDetail(until), onUndo: () => void undo() })
}

type Run = { dismiss: (target: ReminderTarget) => void; snooze: (target: ReminderTarget) => void }

/** Shift+D and Shift+H; off unless the conversation has a reminder. */
export function reminderShortcuts(
  target: ReminderTarget | undefined,
  run: Run,
): Partial<Record<ShortcutId, ShortcutHandler>> {
  // Undefined keeps the caller's `enabled`, so dialogs and the composer still block these.
  const enabled = target ? undefined : false
  return {
    dismissReminder: { run: () => target && run.dismiss(target), enabled },
    snoozeReminder: { run: () => target && run.snooze(target), enabled },
  }
}

/** The command menu's two reminder commands, without icons; none without a reminder. */
export function reminderCommands(
  target: ReminderTarget | undefined,
  keys: (id: ShortcutId) => string | undefined,
  run: Run,
): (Omit<Command, 'icon'> & { id: 'reminder-dismiss' | 'reminder-snooze' })[] {
  if (!target) return []
  return [
    {
      id: 'reminder-dismiss',
      group: 'Conversation',
      label: 'Dismiss reminder',
      key: keys('dismissReminder'),
      keywords: 'follow-up follow up done clear hide',
      run: () => run.dismiss(target),
    },
    {
      id: 'reminder-snooze',
      group: 'Conversation',
      label: 'Snooze reminder…',
      key: keys('snoozeReminder'),
      keywords: 'follow-up follow up later remind',
      run: () => run.snooze(target),
    },
  ]
}

/** The toast for follow-ups main moved back to the inbox. */
export function returnedToast({ count, undoId }: { count: number; undoId?: string }) {
  const text = count + (count === 1 ? ' follow-up' : ' follow-ups') + ' back in Inbox'
  return undoId ? { text, undoId } : { text }
}
