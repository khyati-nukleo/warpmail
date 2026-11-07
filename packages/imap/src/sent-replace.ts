import { isProviderError, ProviderError } from '@inlark/core'
import type { ImapPort } from './port'

/**
 * Read status: a tracked email goes out as one copy per recipient, each with its own image, and
 * the server may file one of those copies in Sent itself. These steps swap whatever the server
 * filed for the one clean copy (no image). Every step is safe to repeat after a crash.
 */

/** The folders the server's own copies can be in. Gmail needs All Mail (`\All`) and Trash. */
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

function onGmail(port: ImapPort, boxes: SentCopyBoxes): boxes is Required<SentCopyBoxes> {
  return port.capabilities.has('X-GM-EXT-1') && !!boxes.allMail && !!boxes.trash
}
/** Selects the folder where the server's copies are looked for and returns their UIDs there. */
async function serverCopies(
  port: ImapPort,
  boxes: SentCopyBoxes,
  messageId: string,
  find: FindMessageId,
): Promise<number[]> {
  if (!onGmail(port, boxes)) return find(port, messageId, (await port.select(boxes.sent)).uidNext)
  // On Gmail every message is in All Mail; Gmail's own search and the header search can each lag.
  const { uidNext } = await port.select(boxes.allMail)
  const found = new Set(await port.search({ gmraw: 'rfc822msgid:' + messageId }))
  for (const uid of await find(port, messageId, uidNext)) found.add(uid)
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
  if (onGmail(port, boxes)) {
    // Deleting from Sent only removes Gmail's Sent label; leaving All Mail removes every label.
    if (uids.length && !(await port.move(uids, boxes.trash)))
      throw new ProviderError('filing', "The server's own Sent copy could not be replaced.")
    // Gmail's own search can skip Trash, so it is searched by header only.
    const trashed = await find(port, messageId, (await port.select(boxes.trash)).uidNext)
    if (trashed.length && uidplus) await port.expunge(trashed)
  } else if (uids.length && uidplus) await port.expunge(uids)
  await appendSentCopy(port, boxes.sent, mime)
}

/** Files the copy in Sent, already read. A dropped connection leaves unknown whether it was. */
export async function appendSentCopy(port: ImapPort, path: string, mime: Uint8Array) {
  try {
    await port.append(path, mime, ['\\Seen'], new Date())
  } catch (error) {
    if (isProviderError(error, 'network'))
      throw new ProviderError(
        'filingUncertain',
        'The connection dropped while saving the Sent copy. It will be checked before trying again.',
      )
    throw new ProviderError('filing', 'The server did not accept the Sent copy.')
  }
}
