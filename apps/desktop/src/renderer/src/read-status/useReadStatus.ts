import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ownAddresses,
  recipientStatus,
  replyTimes,
  trackedRecipients,
  workerBase,
  type Message,
  type RecipientReadStatus,
} from '@inlark/core'
import { api } from '../api'

/** Accounts and settings from the app's bootstrap, plus whether read status could be on at all. */
export function useReadStatusSetup() {
  const { data } = useQuery({ queryKey: ['bootstrap'], queryFn: () => api.bootstrap() })
  const settings = data?.settings.readStatus
  const accounts = data?.accounts
  const own = useMemo(() => ownAddresses(accounts ?? []), [accounts])
  const configured = settings?.enabled !== false && !!workerBase(settings?.workerUrl)
  return { settings, accounts: accounts ?? [], own, configured }
}

/** Whether a password is saved; refreshed with every `readStatus` event. */
export function useReadStatusInfo() {
  return useQuery({ queryKey: ['readStatus', 'info'], queryFn: () => api.readStatusInfo() })
}

/** Emails sent from one of the user's addresses that could carry read status. */
export function sentByMe(messages: Message[], own: string[]): Message[] {
  return messages.filter(
    (m) => !!m.messageId?.[0] && m.from.some((a) => own.includes(a.email.trim().toLowerCase())),
  )
}

/**
 * Per-recipient statuses for `messages` sent from an own address, keyed by message id. Replies
 * are looked for in `conversation`. Untracked emails have no entry.
 */
export function useReadStatus(
  accountId: string,
  messages: Message[],
  conversation: Message[],
): Map<string, RecipientReadStatus[]> {
  const { own, configured } = useReadStatusSetup()
  const sent = useMemo(() => sentByMe(messages, own), [messages, own])
  const lookups = useQuery({
    queryKey: ['readStatus', accountId, ...sent.map((m) => m.messageId![0])],
    queryFn: () =>
      api.readStatus(
        sent.map((m) => ({ messageId: m.messageId![0], recipients: trackedRecipients(m) })),
      ),
    enabled: configured && sent.length > 0,
    staleTime: 60_000,
  })
  return useMemo(() => {
    const out = new Map<string, RecipientReadStatus[]>()
    const results = lookups.data
    if (!results || results.length !== sent.length) return out
    sent.forEach((message, index) => {
      const lookup = results[index]
      if (!lookup) return
      const replies = replyTimes(
        message,
        conversation.filter((m) => m.id !== message.id),
      )
      out.set(
        message.id,
        lookup.recipients.map((r) =>
          recipientStatus(r.email, r.fetches, replies.get(r.email.toLowerCase())),
        ),
      )
    })
    return out
  }, [lookups.data, sent, conversation])
}
