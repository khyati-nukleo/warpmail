import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  ownAddresses,
  recipientStatus,
  replyTimes,
  trackedRecipients,
  workerBase,
  type Message,
  type ReadStatusLookup,
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

/** One answer from main, kept with the Message-ID it was asked for. */
export interface ReadStatusAnswer {
  messageId: string
  lookup: ReadStatusLookup | null
}

/**
 * Statuses keyed by message id, matched to `answers` by Message-ID: while a new lookup loads,
 * the previous answers still fit the messages they were for.
 */
export function statusesByMessage(
  sent: Message[],
  answers: ReadStatusAnswer[] | undefined,
  conversation: Message[],
): Map<string, RecipientReadStatus[]> {
  const out = new Map<string, RecipientReadStatus[]>()
  const byId = new Map(answers?.map((a) => [a.messageId, a.lookup]))
  for (const message of sent) {
    const lookup = byId.get(message.messageId![0])
    if (!lookup) continue
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
  }
  return out
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
  const ids = sent.map((m) => m.messageId![0])
  const lookups = useQuery({
    queryKey: ['readStatus', accountId, ...ids],
    queryFn: async (): Promise<ReadStatusAnswer[]> => {
      const results = await api.readStatus(
        sent.map((m) => ({ messageId: m.messageId![0], recipients: trackedRecipients(m) })),
      )
      return ids.map((messageId, i) => ({ messageId, lookup: results[i] ?? null }))
    },
    enabled: configured && sent.length > 0,
    staleTime: 60_000,
    // A new message changes the key; the earlier statuses stay on screen meanwhile.
    placeholderData: keepPreviousData,
  })
  return useMemo(
    () => statusesByMessage(sent, lookups.data, conversation),
    [lookups.data, sent, conversation],
  )
}
