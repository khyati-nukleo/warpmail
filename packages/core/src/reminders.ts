export type ReminderKind = 'followUp' | 'reply'
export type ReminderLabel = 'noReminder' | 'followUp'
export const reminderLabelNames: Record<ReminderLabel, string> = {
  noReminder: 'No reminder',
  followUp: 'Follow up',
}
export const reminderLabelRoot = 'Warpmail'
export const reminderLookbackDays = 30
export interface ReminderFacts {
  threadId: string
  /** The thread's latest message from a person (see Important), as indexed. */
  messageId: string | null // Message-ID header, no brackets
  receivedAt: string // ISO
  fromEmail: string | null // lowercase
  to: string[] // lowercase addresses on its To line
  inInbox: boolean // any message of the thread is in INBOX
  labels: { noReminder: boolean; followUp: boolean } // a copy with this Message-ID is in the label folder
  asks: boolean | null // stored ask-check of this message; null when never checked
}
