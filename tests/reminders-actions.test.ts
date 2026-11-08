import { describe, expect, it, vi } from 'vitest'
import type { ReminderSnooze, Settings } from '../packages/core/src'
import {
  dismissReminder,
  reminderCommands,
  reminderShortcuts,
  reminderTarget,
  returnedToast,
  snoozeReminder,
  withSnooze,
  type ReminderDeps,
} from '../apps/desktop/src/renderer/src/reminders/reminder-actions'
import { resolveShortcuts } from '../apps/desktop/src/renderer/src/shortcuts'

const day = 86_400_000
const now = new Date(2026, 10, 6, 15, 30).getTime()
const reminder = { kind: 'followUp' as const, dueAt: '2026-11-06T09:00:00Z', messageId: 'm2' }
const conversation = { accountId: 'a1', id: 't1', reminder }
const target = { accountId: 'a1', threadId: 't1', messageId: 'm2' }
const snooze = (threadId: string, until: number, accountId = 'a1'): ReminderSnooze => ({
  accountId,
  threadId,
  messageId: 'm',
  until,
})

/** Fake deps: settings held in memory, saved through `change` like `saveSplitSettings`. */
function fakeDeps(settings: Partial<Settings> = {}) {
  const state = { settings: settings as Settings }
  const toasts: { text: string; onUndo: () => void }[] = []
  const deps = {
    api: { dismissReminder: vi.fn(async () => {}), restoreReminder: vi.fn(async () => {}) },
    save: vi.fn(async (change: (latest: Settings) => Partial<Settings>) => {
      state.settings = { ...state.settings, ...change(state.settings) }
      return state.settings
    }),
    settings: () => state.settings,
    notify: vi.fn(),
    showToast: vi.fn((toast: { text: string; onUndo: () => void }) => void toasts.push(toast)),
    reload: vi.fn(),
    now: () => now,
  } satisfies ReminderDeps
  return { deps, state, toasts }
}

describe('reminder target', () => {
  it('is the conversation only when it carries a reminder', () => {
    expect(reminderTarget(undefined)).toBeUndefined()
    expect(reminderTarget({ accountId: 'a1', id: 't1' })).toBeUndefined()
    expect(reminderTarget(conversation)).toEqual(target)
  })
})

describe('reminder shortcuts and commands', () => {
  const keys = (id: string) => ({ dismissReminder: 'Shift D', snoozeReminder: 'Shift H' })[id]
  const run = { dismiss: vi.fn(), snooze: vi.fn() }

  it('default to Shift+D and Shift+H', () => {
    const bindings = resolveShortcuts()
    expect(bindings.dismissReminder).toEqual([['Shift+D']])
    expect(bindings.snoozeReminder).toEqual([['Shift+H']])
  })

  it('offer no commands and disabled keys without a reminder', () => {
    expect(reminderCommands(undefined, keys, run)).toEqual([])
    const handlers = reminderShortcuts(undefined, run)
    expect(handlers.dismissReminder?.enabled).toBe(false)
    expect(handlers.snoozeReminder?.enabled).toBe(false)
  })

  it('offer both commands with their keys for a reminder', () => {
    const commands = reminderCommands(target, keys, run)
    expect(commands.map((c) => [c.label, c.key])).toEqual([
      ['Dismiss reminder', 'Shift D'],
      ['Snooze reminder…', 'Shift H'],
    ])
    commands[1].run()
    expect(run.snooze).toHaveBeenCalledWith(target)
  })

  it('Shift+D dismisses the conversation’s reminder', async () => {
    const { deps } = fakeDeps()
    const handlers = reminderShortcuts(reminderTarget(conversation), {
      dismiss: (t) => void dismissReminder(t, deps),
      snooze: vi.fn(),
    })
    // Undefined leaves it to the app's own enabled state.
    expect(handlers.dismissReminder?.enabled).toBeUndefined()
    handlers.dismissReminder!.run()
    await vi.waitFor(() => expect(deps.showToast).toHaveBeenCalled())
    expect(deps.api.dismissReminder).toHaveBeenCalledWith({
      accountId: 'a1',
      threadId: 't1',
      messageId: 'm2',
    })
  })
})

describe('dismiss', () => {
  it('toasts with an Undo that restores the reminder', async () => {
    const { deps, toasts } = fakeDeps()
    await dismissReminder(target, deps)
    expect(toasts[0].text).toBe('Reminder dismissed')
    expect(deps.save).not.toHaveBeenCalled()
    expect(deps.reload).toHaveBeenCalled()
    toasts[0].onUndo()
    await vi.waitFor(() => expect(deps.api.restoreReminder).toHaveBeenCalledWith(target))
    await vi.waitFor(() => expect(deps.notify).toHaveBeenCalledWith('Undone.'))
  })

  it('shows a friendly error and no toast when it fails', async () => {
    const { deps } = fakeDeps()
    deps.api.dismissReminder.mockRejectedValueOnce(new Error('Reminders work with IMAP only.'))
    await dismissReminder(target, deps)
    expect(deps.showToast).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenCalledWith('Reminders work with IMAP only.', 'error')
  })

  it('drops the thread’s snooze, and Undo puts it back', async () => {
    const mine = snooze('t1', now - day)
    const other = snooze('t2', now + day)
    const { deps, state, toasts } = fakeDeps({ reminderSnoozes: [mine, other] })
    await dismissReminder(target, deps)
    expect(state.settings.reminderSnoozes).toEqual([other])
    toasts[0].onUndo()
    await vi.waitFor(() => expect(deps.notify).toHaveBeenCalledWith('Undone.'))
    expect(state.settings.reminderSnoozes).toEqual([other, mine])
  })
})

describe('snooze', () => {
  it('replaces the thread’s entry, drops month-old ones and keeps the last 500', () => {
    const old = snooze('t3', now - 31 * day)
    const recent = snooze('t4', now - 29 * day)
    const sameThreadOtherAccount = snooze('t1', now + day, 'a2')
    const entry = { ...target, until: now + day }
    expect(
      withSnooze([old, snooze('t1', now + 2 * day), recent, sameThreadOtherAccount], entry, now),
    ).toEqual([recent, sameThreadOtherAccount, entry])
    const many = Array.from({ length: 600 }, (_, i) => snooze('x' + i, now + day))
    const capped = withSnooze(many, entry, now)
    expect(capped).toHaveLength(500)
    expect(capped.at(-1)).toEqual(entry)
    expect(capped[0].threadId).toBe('x101')
    expect(withSnooze(undefined, entry, now)).toEqual([entry])
  })

  it('saves the snooze, toasts the time, and Undo restores the previous list', async () => {
    const before = snooze('t1', now - day)
    const other = snooze('t2', now + day)
    const { deps, state, toasts } = fakeDeps({ reminderSnoozes: [before, other] })
    const until = new Date(2026, 10, 9, 9).getTime()
    await snoozeReminder(target, until, deps)
    expect(state.settings.reminderSnoozes).toEqual([other, { ...target, until }])
    expect(toasts[0].text).toMatch(/^Snoozed until .*9:00/)
    expect(deps.reload).toHaveBeenCalled()
    toasts[0].onUndo()
    await vi.waitFor(() => expect(deps.notify).toHaveBeenCalledWith('Undone.'))
    expect(state.settings.reminderSnoozes).toEqual([other, before])
  })

  it('shows a friendly error when the save fails', async () => {
    const { deps } = fakeDeps()
    deps.save.mockRejectedValueOnce(new Error('Disk full.'))
    await snoozeReminder(target, now + day, deps)
    expect(deps.showToast).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenCalledWith('Disk full.', 'error')
  })
})

describe('follow-ups returned to the inbox', () => {
  it('counts them and carries the undo', () => {
    expect(returnedToast({ count: 1, undoId: 'u1' })).toEqual({
      text: '1 follow-up back in Inbox',
      undoId: 'u1',
    })
    expect(returnedToast({ count: 3 })).toEqual({ text: '3 follow-ups back in Inbox' })
  })
})
