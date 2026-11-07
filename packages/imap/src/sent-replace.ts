import {
  hasWorkerImage,
  isProviderError,
  ProviderError,
  type SentCopyReplacement,
} from '@inlark/core'
import { messageIds } from './convert'
import { parseMime } from './mime'
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

/**
 * Swaps the server's copies for the clean one (`mime`) in Sent. Returns the clean copy's UID in
 * Sent on Gmail, where it is confirmed there before anything is deleted for good.
 */
export async function replaceSentCopy(
  port: ImapPort,
  boxes: SentCopyBoxes,
  messageId: string,
  mime: Uint8Array,
  find: FindMessageId,
  replacement?: SentCopyReplacement,
): Promise<number | undefined> {
  if (!exactId.test(messageId))
    throw new ProviderError('filing', 'The sent message has no usable Message-ID.')
  const gmail = gmailBoxes(port, boxes)
  if (gmail) return replaceOnGmail(port, boxes, gmail, messageId, mime, find, replacement)
  const uids = await serverCopies(port, boxes, messageId, find)
  if (uids.length) {
    // Never two Sent copies: without UID EXPUNGE the server's own copy can't be removed safely.
    if (!port.capabilities.has('UIDPLUS'))
      throw new ProviderError(
        'filing',
        "The server saved its own Sent copy and can't safely delete it (no UIDPLUS), so it was kept.",
      )
    await port.expunge(uids)
  }
  // Its own date, so a filing retried later still sorts before the replies.
  await appendSentCopy(port, boxes.sent, mime, headerDate(mime))
  return undefined
}

/**
 * On Gmail, nothing is deleted for good before the clean copy is confirmed in Sent:
 * 1. recipients' copies (with an image) leave All Mail for Trash, once `owe` made the debt durable;
 * 2. the clean copy is filed in Sent and confirmed there, unless an earlier attempt's already is;
 * 3. only then are this Message-ID's copies in Trash deleted for good.
 * Every step is safe to repeat: a retry never files a second clean copy.
 */
async function replaceOnGmail(
  port: ImapPort,
  boxes: SentCopyBoxes,
  gmail: { allMail: string; trash: string },
  messageId: string,
  mime: Uint8Array,
  find: FindMessageId,
  replacement?: SentCopyReplacement,
): Promise<number> {
  const hosts = replacement?.hosts ?? []
  if (!hosts.length)
    throw new ProviderError(
      'filing',
      "The read status Worker's address is needed to replace the Sent copy safely.",
    )
  let clean = await cleanCopy(port, boxes.sent, messageId, find, hosts)
  // Selects All Mail, where Gmail keeps every copy whatever its labels.
  const copies = await serverCopies(port, boxes, messageId, find)
  const images = await withImage(port, copies, messageId, hosts)
  if (images.length || !clean) await replacement?.owe?.()
  // Deleting from Sent only removes Gmail's Sent label; leaving All Mail removes every label.
  if (images.length && !(await port.move(images, gmail.trash)))
    throw new ProviderError('filing', "The server's own Sent copy could not be replaced.")
  clean ??= await fileConfirmed(port, boxes.sent, gmail.trash, messageId, mime, find, hosts)
  await deleteTrashed(port, gmail.trash, messageId, find)
  return clean
}

/** Large enough for any tracked copy (see `readStatusLimits`). */
const sourceLimit = 64 * 1024 * 1024

/** Parsed copies at `uids` in the selected folder that have exactly this Message-ID. */
async function parsedCopies(port: ImapPort, uids: number[], messageId: string) {
  const out: { uid: number; html: string }[] = []
  if (!uids.length) return out
  for (const [uid, raw] of await port.sources(uids, sourceLimit)) {
    const parsed = await parseMime(raw, { maxBytes: sourceLimit }).catch(() => undefined)
    if (parsed?.messageId === messageId) out.push({ uid, html: parsed.html || '' })
  }
  return out.sort((a, b) => a.uid - b.uid)
}

/** Copies in the selected folder that carry a Worker image. Unreadable ones are left alone. */
async function withImage(port: ImapPort, uids: number[], messageId: string, hosts: string[]) {
  return (await parsedCopies(port, uids, messageId))
    .filter((c) => hasWorkerImage(c.html, hosts))
    .map((c) => c.uid)
}

/** The UID of a copy in Sent with this Message-ID and no Worker image, if there is one. */
export async function cleanCopy(
  port: ImapPort,
  sent: string,
  messageId: string,
  find: FindMessageId,
  hosts: string[],
  hint?: number,
): Promise<number | undefined> {
  const uids = new Set(await find(port, messageId, (await port.select(sent)).uidNext))
  if (hint) uids.add(hint)
  const copies = await parsedCopies(port, [...uids], messageId)
  return copies.find((c) => !hasWorkerImage(c.html, hosts))?.uid
}

/** Files the clean copy in Sent and confirms it there (by APPENDUID, else by search). */
async function fileConfirmed(
  port: ImapPort,
  sent: string,
  trash: string,
  messageId: string,
  mime: Uint8Array,
  find: FindMessageId,
  hosts: string[],
): Promise<number> {
  const date = headerDate(mime)
  const first = await appendSentCopy(port, sent, mime, date)
  const filed = await cleanCopy(port, sent, messageId, find, hosts, first.uid)
  if (filed) return filed
  // Gmail may drop a copy whose Message-ID is still in Trash; those go first, then once more.
  await deleteTrashed(port, trash, messageId, find)
  const again = await appendSentCopy(port, sent, mime, date)
  const refiled = await cleanCopy(port, sent, messageId, find, hosts, again.uid)
  if (refiled) return refiled
  throw new ProviderError('filing', "Gmail didn't keep the Sent copy. It will be filed again.")
}

/** Deletes this Message-ID's copies in Trash for good. Gmail's search can skip Trash. */
async function deleteTrashed(
  port: ImapPort,
  trash: string,
  messageId: string,
  find: FindMessageId,
) {
  const trashed = await find(port, messageId, (await port.select(trash)).uidNext)
  if (trashed.length && port.capabilities.has('UIDPLUS')) await port.expunge(trashed)
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
    return await port.append(path, mime, ['\\Seen'], date ?? new Date())
  } catch (error) {
    if (isProviderError(error, 'network'))
      throw new ProviderError(
        'filingUncertain',
        'The connection dropped while saving the Sent copy. It will be checked before trying again.',
      )
    throw new ProviderError('filing', 'The server did not accept the Sent copy.')
  }
}
