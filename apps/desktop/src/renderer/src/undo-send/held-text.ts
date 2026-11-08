import type { HeldSend } from '@inlark/core'

/** Rows shown at once; older pending sends are counted as "+N more". */
const visibleRows = 3

/** Whole seconds left, never below one while the send can still be undone. */
export function secondsLeft(send: Pick<HeldSend, 'dueAt'>, now: number) {
  return Math.max(1, Math.ceil((Date.parse(send.dueAt) - now) / 1000))
}

export type HeldRow = { draftId: string; text: string; undo: boolean }

/**
 * The bar's rows, oldest first so the newest sits at the bottom. With one pending send it reads
 * like Gmail ("Sending in 8s"); with several, each row names its subject, and its account when
 * there is more than one.
 */
export function heldRows(
  sends: HeldSend[],
  now: number,
  accounts: { id: string; name: string }[],
): { rows: HeldRow[]; more: number } {
  const ordered = [...sends].sort((a, b) => a.dueAt.localeCompare(b.dueAt))
  const shown = ordered.slice(-visibleRows)
  const several = sends.length > 1
  const rows = shown.map((send) => {
    const status = send.state === 'waiting' ? `Sending in ${secondsLeft(send, now)}s` : 'Sending…'
    const account = accounts.length > 1 && accounts.find((a) => a.id === send.accountId)?.name
    const label = several
      ? [account, '“' + (send.subject || '(No subject)') + '”', status].filter(Boolean).join(' · ')
      : status
    return { draftId: send.draftId, text: label, undo: send.state === 'waiting' }
  })
  return { rows, more: ordered.length - shown.length }
}

/** The bar's height in pixels for `count` pending sends, so a toast shown with it sits above. */
export function heldBarHeight(count: number) {
  const rows = Math.min(count, visibleRows)
  return 18 + rows * 26 + (rows - 1) * 4 + (count > visibleRows ? 20 : 0)
}
