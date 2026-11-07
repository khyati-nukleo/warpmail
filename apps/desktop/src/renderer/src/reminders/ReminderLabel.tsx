import { useQuery } from '@tanstack/react-query'
import { reminderSettingsOf, type Conversation, type ReminderSettings } from '@inlark/core'
import { api } from '../api'
import { reminderLabelOf } from './reminder-label-model'

export function ReminderLabel({
  reminder,
  settings,
}: {
  reminder?: Conversation['reminder']
  settings: ReminderSettings
}) {
  const text = reminderLabelOf(reminder, settings)
  if (!text) return null
  return (
    <span className="row-reminder shrink-0 text-primary text-[11px] font-semibold">{text}</span>
  )
}

/** Reminder settings from the cached bootstrap, so rows need no extra props. */
export function useReminderSettings(): ReminderSettings {
  const { data } = useQuery({ queryKey: ['bootstrap'], queryFn: () => api.bootstrap() })
  return reminderSettingsOf(data?.settings ?? {})
}
