import type { Settings } from './model'
import { isAutomatedAddress } from './split'
import { addWorkingDays } from './working-days'

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
  /**
   * My latest message since anyone else last wrote that asks (stored ask-check or Follow up
   * label, and no No reminder label); it may be this message or an earlier one. Undefined when
   * the provider doesn't work it out: then this message alone decides.
   */
  ownAsk?: { messageId: string; receivedAt: string } | null
}

/** The email a reminder is about, as dismissing and snoozing name it. */
export type ReminderTarget = { accountId: string; threadId: string; messageId: string }

export interface ReminderSettings {
  enabled: boolean
  followUp: boolean
  forgotToReply: boolean
  followUpDays: number
  replyDays: number
}
export const defaultReminderSettings: ReminderSettings = {
  enabled: true,
  followUp: true,
  forgotToReply: true,
  followUpDays: 3,
  replyDays: 1,
}
/** A snooze belongs to one message: a newer message in the thread starts fresh. */
export interface ReminderSnooze {
  accountId: string
  threadId: string
  messageId: string
  until: number
}
export interface Reminder {
  kind: ReminderKind
  threadId: string
  messageId: string
  /** When it shows: the due time, or the end of a snooze. */
  dueMs: number
}

const clampDays = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(30, Math.max(1, Math.round(value)))
    : fallback

export function reminderSettingsOf(settings: Pick<Settings, 'reminders'>): ReminderSettings {
  const r = settings.reminders ?? {}
  const d = defaultReminderSettings
  return {
    enabled: r.enabled ?? d.enabled,
    followUp: r.followUp ?? d.followUp,
    forgotToReply: r.forgotToReply ?? d.forgotToReply,
    followUpDays: clampDays(r.followUpDays, d.followUpDays),
    replyDays: clampDays(r.replyDays, d.replyDays),
  }
}

export function deriveReminder(
  facts: ReminderFacts,
  context: { own: string[]; settings: ReminderSettings; snooze?: ReminderSnooze },
): Reminder | null {
  const { own, settings, snooze } = context
  if (!settings.enabled || !facts.messageId || facts.labels.noReminder) return null
  let from = facts.receivedAt
  let kind: ReminderKind
  let days: number
  if (facts.fromEmail && own.includes(facts.fromEmail)) {
    if (!settings.followUp) return null
    // Only someone else's reply ends an ask: my own later note ("here's the file") keeps it.
    const ask =
      facts.labels.followUp || facts.asks === true ? facts.receivedAt : facts.ownAsk?.receivedAt
    if (!ask) return null
    // Nobody would answer: every To recipient is me or a robot (a notification's reply address).
    if (facts.to.length && facts.to.every((a) => own.includes(a) || isAutomatedAddress(a)))
      return null
    from = ask
    kind = 'followUp'
    days = settings.followUpDays
  } else {
    if (!settings.forgotToReply || !facts.inInbox || !facts.to.some((a) => own.includes(a)))
      return null
    kind = 'reply'
    days = settings.replyDays
  }
  const received = Date.parse(from)
  if (!Number.isFinite(received)) return null
  const due = addWorkingDays(received, days)
  const snoozed = snooze && snooze.messageId === facts.messageId ? snooze.until : 0
  return {
    kind,
    threadId: facts.threadId,
    messageId: facts.messageId,
    dueMs: Math.max(due, snoozed),
  }
}

export function reminderLabelText(kind: ReminderKind, settings: ReminderSettings): string {
  if (kind === 'reply') return 'Waiting on you'
  const n = settings.followUpDays
  return `No reply in ${n} ${n === 1 ? 'day' : 'days'}`
}
