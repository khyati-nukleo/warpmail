import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const mac = (password: string, data: string) => createHmac('sha256', password).update(data).digest()

/** The code in a recipient's image address: stable per password, message and recipient. */
export function imageCode(password: string, messageId: string, recipient: string): string {
  const data = messageId + '\n' + recipient.trim().toLowerCase()
  return mac(password, data).toString('base64url').slice(0, 22)
}

const tagFor = (password: string, uuid: string) =>
  mac(password, 'message:' + uuid)
    .toString('hex')
    .slice(0, 10)

/** `<uuid>.<tag>@<domain>` without angle brackets; the tag marks the email as tracked. */
export function trackedMessageId(password: string, domain: string): string {
  const uuid = randomUUID()
  return `${uuid}.${tagFor(password, uuid)}@${domain}`
}

export function isTrackedMessageId(password: string, messageId: string): boolean {
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{10})@[^@\s<>]+$/.exec(
      messageId,
    )
  if (!match) return false
  return timingSafeEqual(Buffer.from(match[2]), Buffer.from(tagFor(password, match[1])))
}
