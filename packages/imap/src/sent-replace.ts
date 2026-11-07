import { isProviderError, ProviderError } from '@inlark/core'
import { messageIds } from './convert'
import type { ImapPort } from './port'

/**
 * Read status: a tracked email goes out as one copy per recipient, each with its own image, and
 * the server may file one of those copies in Sent itself. These steps swap whatever the server
 * filed for the one clean copy (no image). Every step is safe to repeat after a crash.
 */

/**
 * Where the copies live; on Gmail, All Mail and Trash are the folders flagged `\All` and
 * `\Trash`, and every other folder is a label, so removing a message from it only removes the label.
 */
export interface SentCopyBoxes {
  sent: string
  allMail?: string
  trash?: string
}
/** UIDs in the selected folder with this Message-ID (header search and newest envelopes). */
export type FindMessageId = (
  port: ImapPort,
  messageId: string,
  uidNext: number,
) => Promise<number[]>

/** A Message-ID that searches can only match exactly (no spaces, quotes or brackets). */
const exactId = /^[^\s<>"]+@[^\s<>"]+$/

/**
 * Whether tracked sends can work here: only Gmail keeps the app's Message-ID and lets its own
 * Sent copy be replaced, and only with All Mail and Trash shown in IMAP (see `gmailBoxes`).
 */
export function readStatusServer(
  port: Pick<ImapPort, 'capabilities'>,
  boxes: { specialUse?: string | null }[],
): boolean {
  return (
    port.capabilities.has('X-GM-EXT-1') &&
    boxes.some((b) => b.specialUse === '\\All') &&
    boxes.some((b) => b.specialUse === '\\Trash')
  )
}

/** Gmail's All Mail and Trash, or undefined on other servers. Without them nothing is deleted. */
function gmailBoxes(port: ImapPort, boxes: SentCopyBoxes) {
  if (!port.capabilities.has('X-GM-EXT-1')) return undefined
  if (!boxes.allMail || !boxes.trash)
    throw new ProviderError(
      'filing',
      "Gmail's All Mail and Trash folders must be shown in IMAP (Gmail settings → Labels) to replace the Sent copy.",
    )
  return { allMail: boxes.allMail, trash: boxes.trash }
}
/** Selects the folder where the server's copies are looked for and returns their UIDs there. */
async function serverCopies(
  port: ImapPort,
  boxes: SentCopyBoxes,
  messageId: string,
  find: FindMessageId,
): Promise<number[]> {
  if (!exactId.test(messageId))
    throw new ProviderError('filing', 'The sent message has no usable Message-ID.')
  const gmail = gmailBoxes(port, boxes)
  if (!gmail) return find(port, messageId, (await port.select(boxes.sent)).uidNext)
  // On Gmail every message is in All Mail; Gmail's own search and the header search can each lag.
  const { uidNext } = await port.select(gmail.allMail)
  const found = new Set(await find(port, messageId, uidNext))
  // Gmail's query language is not exact matching, so its matches are checked by envelope.
  const loose = (await port.search({ gmraw: 'rfc822msgid:' + messageId })).filter(
    (uid) => !found.has(uid),
  )
  if (loose.length)
    for (const m of await port.fetch(loose.join(','), { envelope: true }))
      if (messageIds(m.envelope?.messageId)[0] === messageId) found.add(m.uid)
  return [...found].sort((a, b) => a - b)
}

export async function hasServerCopy(
  port: ImapPort,
  boxes: SentCopyBoxes,
  messageId: string,
  find: FindMessageId,
): Promise<boolean> {
  return (await serverCopies(port, boxes, messageId, find)).length > 0
}

/** Removes the server's copies (and any earlier clean one), then files `mime` in Sent. */
export async function replaceSentCopy(
  port: ImapPort,
  boxes: SentCopyBoxes,
  messageId: string,
  mime: Uint8Array,
  find: FindMessageId,
): Promise<void> {
  const uids = await serverCopies(port, boxes, messageId, find)
  const uidplus = port.capabilities.has('UIDPLUS')
  const gmail = gmailBoxes(port, boxes)
  if (gmail) {
    // Deleting from Sent only removes Gmail's Sent label; leaving All Mail removes every label.
    if (uids.length && !(await port.move(uids, gmail.trash)))
      throw new ProviderError('filing', "The server's own Sent copy could not be replaced.")
    // Gmail's own search can skip Trash, so it is searched by header only.
    const trashed = await find(port, messageId, (await port.select(gmail.trash)).uidNext)
    if (trashed.length && uidplus) await port.expunge(trashed)
  } else if (uids.length) {
    // Never two Sent copies: without UID EXPUNGE the server's own copy can't be removed safely.
    if (!uidplus)
      throw new ProviderError(
        'filing',
        "The server saved its own Sent copy and can't safely delete it (no UIDPLUS), so it was kept.",
      )
    await port.expunge(uids)
  }
  // Its own date, so a filing retried later still sorts before the replies.
  await appendSentCopy(port, boxes.sent, mime, headerDate(mime))
}

/** The message's Date header, or undefined when it has none that parses. */
function headerDate(mime: Uint8Array): Date | undefined {
  const text = new TextDecoder().decode(mime.subarray(0, 64 * 1024))
  const end = text.search(/\r?\n\r?\n/)
  const head = (end < 0 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ')
  const value = /^date:[ \t]*(.+)$/im.exec(head)?.[1]
  const at = value ? Date.parse(value.trim()) : NaN
  return Number.isNaN(at) ? undefined : new Date(at)
}

/** Files the copy in Sent, already read. A dropped connection leaves unknown whether it was. */
export async function appendSentCopy(port: ImapPort, path: string, mime: Uint8Array, date?: Date) {
  try {
    await port.append(path, mime, ['\\Seen'], date ?? new Date())
  } catch (error) {
    if (isProviderError(error, 'network'))
      throw new ProviderError(
        'filingUncertain',
        'The connection dropped while saving the Sent copy. It will be checked before trying again.',
      )
    throw new ProviderError('filing', 'The server did not accept the Sent copy.')
  }
}
