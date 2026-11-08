import { Button, MenuItem } from '@inlark/ui'
import { Calendar, Check, Inbox } from '@inlark/ui/icons'
import { ShortcutHint } from '../shortcuts'

export type ReminderBarProps = {
  /** The reminder's label, e.g. “No reply in 3 days”. */
  label: string
  onDismiss: () => void
  onSnooze: () => void
}

/** One quiet line above the messages, in the look of the reader's image notice. */
export function ReminderBar({ label, onDismiss, onSnooze }: ReminderBarProps) {
  return (
    <div className="reminder-bar flex gap-1.75 items-center text-muted text-[11px] -mt-3.5 pb-4.25 px-0 [&_kbd]:ml-[2px] [&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:text-[9px]">
      <Inbox size={13} />
      <span>{label}</span>
      <Button size="small" variant="ghost" className="ml-auto -my-1" onClick={onDismiss}>
        Dismiss
        <ShortcutHint id="dismissReminder" />
      </Button>
      <Button size="small" variant="ghost" className="-my-1" onClick={onSnooze}>
        Snooze…
        <ShortcutHint id="snoozeReminder" />
      </Button>
    </div>
  )
}

/** "Dismiss reminder" and "Snooze reminder…" for the reader's "More conversation actions". */
export function ReminderMenuItems({ onDismiss, onSnooze }: ReminderBarProps) {
  return (
    <>
      <MenuItem onClick={onDismiss}>
        <Check size={14} />
        Dismiss reminder
        <ShortcutHint id="dismissReminder" className="menu-shortcut ml-auto" />
      </MenuItem>
      <MenuItem onClick={onSnooze}>
        <Calendar size={14} />
        Snooze reminder…
        <ShortcutHint id="snoozeReminder" className="menu-shortcut ml-auto" />
      </MenuItem>
    </>
  )
}
