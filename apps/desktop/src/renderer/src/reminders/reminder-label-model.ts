import { reminderLabelText, type Conversation, type ReminderSettings } from '@inlark/core'

/** Text for a row's reminder label; undefined when the conversation has no reminder. */
export function reminderLabelOf(
  reminder: Conversation['reminder'],
  settings: ReminderSettings,
): string | undefined {
  return reminder ? reminderLabelText(reminder.kind, settings) : undefined
}
