/** One recipient's copy of a tracked send, as the journal records it. */
export interface JournalCopy {
  recipient: string
  /** `sending` is written before the copy is transmitted, so a crash leaves it unconfirmed. */
  state: 'pending' | 'sending' | 'accepted' | 'rejected' | 'uncertain' | 'notSent'
  reason?: string
}

export interface SettledCopies {
  state: 'sent' | 'partial' | 'uncertain' | 'rejected'
  accepted: string[]
  /** Refused or never sent: safe to send again. */
  rejected: { email: string; reason: string }[]
  /** May have arrived, so never offered for a second send. */
  unconfirmed: string[]
}

const closed = 'Not sent: the app closed before sending to this recipient.'
const notSent = 'Not sent.'

/** After a restart: a copy being sent may have arrived; a pending one never left the device. */
export function recoverCopies(copies: JournalCopy[]): JournalCopy[] {
  return copies.map((copy) =>
    copy.state === 'sending'
      ? { ...copy, state: 'uncertain' }
      : copy.state === 'pending'
        ? { ...copy, state: 'notSent', reason: closed }
        : copy,
  )
}

/**
 * All accepted is `sent`; some accepted is `partial`. With none accepted, any unconfirmed copy
 * makes it `uncertain`, otherwise nothing arrived and it is `rejected`.
 */
export function settleCopies(copies: JournalCopy[]): SettledCopies {
  const accepted: string[] = []
  const rejected: SettledCopies['rejected'] = []
  const unconfirmed: string[] = []
  for (const copy of copies)
    if (copy.state === 'accepted') accepted.push(copy.recipient)
    else if (copy.state === 'uncertain' || copy.state === 'sending')
      unconfirmed.push(copy.recipient)
    else rejected.push({ email: copy.recipient, reason: copy.reason || notSent })
  const state =
    accepted.length === copies.length && copies.length
      ? 'sent'
      : accepted.length
        ? 'partial'
        : unconfirmed.length
          ? 'uncertain'
          : 'rejected'
  return { state, accepted, rejected, unconfirmed }
}
