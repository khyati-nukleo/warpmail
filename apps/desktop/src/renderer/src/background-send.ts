import { friendlyError, type Draft, type NotSentResult, type SendResult } from '@inlark/core'

/**
 * What a send came to. A `draft` is the copy to reopen: it was not confirmed as sent. `quiet`:
 * nothing to say (Undo send: it was undone, and the draft is reopening).
 */
export type SendOutcome =
  | { text: string; tone?: 'error' | 'info'; draft?: Draft; quiet?: undefined }
  | { quiet: true; text?: undefined; tone?: undefined; draft?: undefined }

export interface SendIO {
  /** Undo send: may also come back not sent, held back or undone. */
  send(draft: Draft): Promise<SendResult | NotSentResult>
  reconcile(draftId: string): Promise<SendResult>
  drafts(): Promise<Draft[]>
  localSaveDraft(draft: Draft): Promise<unknown>
  localDeleteDraft(id: string): Promise<unknown>
}

export function sentMessage(result: SendResult): string {
  const copy = result.sentCopy === 'pending' ? ' Its copy in Sent isn’t saved yet.' : ''
  if (result.status === 'partial') {
    const refused = result.rejected || []
    return (
      (refused.length
        ? 'Sent, but refused by ' +
          (refused.length === 1 ? refused[0].email : refused.length + ' recipients') +
          '.'
        : 'Sent, but some recipients refused it.') +
      copy +
      ' Drafts has the details.'
    )
  }
  return copy ? 'Message sent.' + copy + ' Drafts shows its status.' : result.message
}

/**
 * Sends a draft the composer has already saved and closed. Only a message the server accepted
 * is reported as sent; anything else keeps the draft and returns it to reopen.
 */
export async function deliver(draft: Draft, io: SendIO): Promise<SendOutcome> {
  try {
    const result =
      draft.status === 'uncertain' ? await io.reconcile(draft.id) : await io.send(draft)
    // Undo send: nothing left. The draft stays in Drafts as it is now.
    if (result.status === 'undone') return { quiet: true }
    if (result.status === 'unsent') {
      const saved = await io
        .drafts()
        .then((values) => values.find((d) => d.id === draft.id && d.status !== 'sent'))
        .catch(() => undefined)
      if (saved) await io.localSaveDraft(saved).catch(() => {})
      return saved
        ? { tone: 'info', text: result.message, draft: saved }
        : { tone: 'info', text: result.message }
    }
    if (result.status === 'sent' || result.status === 'partial') {
      const text = sentMessage(result)
      return io.localDeleteDraft(draft.id).then(
        () => ({ text }),
        () => ({ text: 'Message sent. The local draft cache could not be cleaned up.' }),
      )
    }
    const uncertain = { ...draft, status: 'uncertain' as const }
    await io.localSaveDraft(uncertain).catch(() => {})
    return { tone: 'error', text: result.message, draft: uncertain }
  } catch (error) {
    const saved = await io
      .drafts()
      .then((values) => values.find((d) => d.id === draft.id))
      .catch(() => undefined)
    if (saved?.status === 'sent') return { text: 'Delivery confirmed.' }
    if (saved) await io.localSaveDraft(saved).catch(() => {})
    return { tone: 'error', text: friendlyError(error), draft: saved || draft }
  }
}

/** A draft as it is now, looked up when it is opened, or nothing if it was sent or deleted. */
export async function latestDraft(id: string, load: () => Promise<Draft[]>) {
  const draft = (await load()).find((d) => d.id === id)
  return draft?.status === 'sent' ? undefined : draft
}
