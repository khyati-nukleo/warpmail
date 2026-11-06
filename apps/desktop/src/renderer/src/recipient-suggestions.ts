import type { Address, Message } from '@inlark/core'

/** No-reply and bounce senders show up in mail but can't receive it. */
function undeliverable(email: string) {
  const at = email.lastIndexOf('@')
  const local = (at < 0 ? email : email.slice(0, at)).toLowerCase()
  if (local === 'mailer-daemon' || local === 'postmaster') return true
  // Bounce and VERP addresses: bounce, bounces, bounces+id, bounce-123.
  return /^(noreply|donotreply|bounce)/.test(local.replace(/[.\-_]/g, ''))
}

/** People you hear from most come first; your own and undeliverable addresses never appear. */
export function recipientSuggestions(
  conversations: { messages: Pick<Message, 'from' | 'to' | 'cc'>[] }[],
  ownEmails: string[],
): Address[] {
  const own = new Set(ownEmails.map((email) => email.toLowerCase()))
  const seen = new Map<string, { address: Address; count: number }>()
  for (const c of conversations)
    for (const m of c.messages)
      for (const address of [...m.from, ...m.to, ...m.cc]) {
        const key = address.email.toLowerCase()
        if (own.has(key) || undeliverable(key)) continue
        const entry = seen.get(key)
        if (entry) {
          entry.count++
          if (!entry.address.name && address.name) entry.address = address
        } else seen.set(key, { address, count: 1 })
      }
  return [...seen.values()].sort((a, b) => b.count - a.count).map((entry) => entry.address)
}
