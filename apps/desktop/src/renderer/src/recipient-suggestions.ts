import { isAutomatedAddress, type Address, type Message } from '@inlark/core'

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
        if (own.has(key) || isAutomatedAddress(key)) continue
        const entry = seen.get(key)
        if (entry) {
          entry.count++
          if (!entry.address.name && address.name) entry.address = address
        } else seen.set(key, { address, count: 1 })
      }
  return [...seen.values()].sort((a, b) => b.count - a.count).map((entry) => entry.address)
}
