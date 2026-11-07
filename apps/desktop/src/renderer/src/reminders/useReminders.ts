import { useState } from 'react'
import { Calendar, Check } from '@inlark/ui/icons'
import { reminderSettingsOf, type Bootstrap, type Conversation, type Settings } from '@inlark/core'
import { api } from '../api'
import { queryClient } from '../cache'
import type { Command } from '../CommandPalette'
import { useShortcutText } from '../shortcuts'
import { saveSplitSettings } from '../split/split-saves'
import {
  dismissReminder,
  reminderCommands,
  reminderShortcuts,
  reminderTarget,
  snoozeReminder,
  type ReminderDeps,
  type ReminderTarget,
} from './reminder-actions'
import { reminderLabelOf } from './reminder-label-model'
import type { ReminderBarProps } from './ReminderBar'

const icons = { 'reminder-dismiss': Check, 'reminder-snooze': Calendar }

/**
 * Dismiss and snooze for the open conversation, else the focused one, when it has a reminder:
 * shortcuts, commands, the reader's bar and menu items, and the snooze picker.
 */
export function useReminders({
  settings,
  conversation,
  notify,
  showToast,
}: {
  settings: Settings
  /** The open conversation, else the focused row. */
  conversation: () => Pick<Conversation, 'accountId' | 'id' | 'reminder'> | undefined
  notify: (text: string, tone?: 'error' | 'info') => void
  /** A toast with an Undo button. */
  showToast: (toast: { text: string; onUndo: () => void }) => void
}) {
  const keys = useShortcutText()
  const current = conversation()
  const target = reminderTarget(current)
  const [picker, setPicker] = useState<{ target: ReminderTarget; open: boolean }>()

  const deps: ReminderDeps = {
    api,
    // Queued with the split inbox's saves, each on the latest settings.
    save: saveSplitSettings,
    settings: () => queryClient.getQueryData<Bootstrap>(['bootstrap'])?.settings,
    notify,
    showToast,
    reload: () => void queryClient.invalidateQueries({ queryKey: ['mail'] }),
  }
  const run = {
    dismiss: (t: ReminderTarget) => void dismissReminder(t, deps),
    snooze: (t: ReminderTarget) => setPicker({ target: t, open: true }),
  }
  const closePicker = () => setPicker((shown) => shown && { ...shown, open: false })
  const pick = (until: number) => {
    const chosen = picker?.target
    closePicker()
    if (chosen) void snoozeReminder(chosen, until, deps)
  }

  const commands: Command[] = reminderCommands(target, keys, run).map((command) => ({
    ...command,
    icon: icons[command.id],
  }))
  const label = reminderLabelOf(current?.reminder, reminderSettingsOf(settings))

  return {
    shortcutHandlers: reminderShortcuts(target, run),
    commands,
    /** The snooze picker is open: other shortcuts wait. */
    pickerOpen: !!picker?.open,
    /** Props for `SnoozePicker`. */
    picker: { open: !!picker?.open, onClose: closePicker, onPick: pick },
    /** The reader's bar and menu items, when the open conversation has a reminder. */
    reader:
      target && label
        ? ({
            label,
            onDismiss: () => run.dismiss(target),
            onSnooze: () => run.snooze(target),
          } satisfies ReminderBarProps)
        : undefined,
  }
}
