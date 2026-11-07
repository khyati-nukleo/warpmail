import type { Draft, Settings } from './model'

/** Seconds a sent email waits before it leaves, so it can be undone. 0 is off. */
export const undoSendChoices = [0, 5, 10, 20, 30] as const
export type UndoSendSeconds = (typeof undoSendChoices)[number]
/** What quitting during a countdown does with the email. */
export type UndoSendOnQuit = 'send' | 'draft'

const defaultSeconds: UndoSendSeconds = 10

export function undoSendSeconds(settings: Pick<Settings, 'undoSendSeconds'>): UndoSendSeconds {
  const value = settings.undoSendSeconds
  return undoSendChoices.includes(value as UndoSendSeconds)
    ? (value as UndoSendSeconds)
    : defaultSeconds
}
export function undoSendOnQuit(settings: Pick<Settings, 'undoSendOnQuit'>): UndoSendOnQuit {
  return settings.undoSendOnQuit === 'draft' ? 'draft' : 'send'
}

/** A send counting down, or just handed to sending. Contains no message body. */
export interface HeldSend {
  draftId: string
  accountId: string
  subject: string
  /** When the countdown ends (ISO). */
  dueAt: string
  /** `waiting` can still be undone; `sending` has gone to the normal send. */
  state: 'waiting' | 'sending'
}

/**
 * A held send that never left: `undone` by the user (or replaced by a later Send of the same
 * draft), or `unsent` for a reason given in `message`. The draft stays in Drafts either way.
 */
export interface NotSentResult {
  status: 'undone' | 'unsent'
  message: string
}

/** What `undoSend` found: undone with the draft to reopen, or too late. */
export type UndoSendResult =
  { undone: true; draft?: Draft } | { undone: false; reason: 'sending' | 'gone' }
