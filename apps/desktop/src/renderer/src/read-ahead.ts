import type { Conversation, DesktopMailAPI, Message } from '@inlark/core'

/**
 * The conversations either side of the open one, to fetch ahead of reading. Only once the open
 * conversation has finished loading, so these fetches never compete with the one being read.
 */
export function readAhead(
  conversations: Conversation[],
  accountId: string | undefined,
  threadId: string | undefined,
  opened: { status: string; isPlaceholderData: boolean; isFetching: boolean },
  connected: (accountId: string) => boolean,
): Conversation[] {
  if (!threadId || opened.status !== 'success' || opened.isPlaceholderData || opened.isFetching)
    return []
  const index = conversations.findIndex((c) => c.id === threadId && c.accountId === accountId)
  if (index < 0) return []
  return [conversations[index - 1], conversations[index + 1]].filter(
    (c): c is Conversation => !!c && connected(c.accountId),
  )
}

/**
 * Read-ahead results live beside the opened conversation's query, not in it. Sharing its key would
 * make opening a conversation that is still being read ahead wait for that background fetch, which
 * queues behind sync. The key keeps the `thread` prefix, so refreshes, cache clears, persistence
 * and the read-status overlay treat it like any other copy of the conversation.
 */
export const readAheadKey = (accountId: string | undefined, id: string | undefined) => [
  'thread',
  accountId,
  id,
  'ahead',
]

export const readAheadQuery = (
  api: Pick<DesktopMailAPI, 'conversation'>,
  nearby: Pick<Conversation, 'accountId' | 'id'>,
) => ({
  queryKey: readAheadKey(nearby.accountId, nearby.id),
  queryFn: () => api.conversation(nearby.accountId, nearby.id, { prefetch: true }),
  staleTime: 60_000,
  // Only a placeholder for a moment, so an unused copy is dropped soon (and never persisted).
  gcTime: 5 * 60_000,
})

export const isReadAheadKey = (key: readonly unknown[]) => key[0] === 'thread' && key[3] === 'ahead'

/**
 * Whether a read-ahead holds every body. The main process leaves out a large message's body
 * (its original is downloaded, decrypted and verified by the open), so such a copy shows as
 * loading, like the list summary, never as plain unsigned mail.
 */
export const aheadHasBodies = (ahead: Message[] | undefined) =>
  !!ahead && ahead.every((m) => m.html !== undefined || m.text !== undefined)

/**
 * The opened conversation always gets its own foreground fetch. Until it lands, a finished
 * read-ahead shows (with its bodies), or else the list summary.
 */
export const openedThreadQuery = (
  api: Pick<DesktopMailAPI, 'conversation'>,
  accountId: string,
  id: string,
  known: { ahead?: Message[]; listed?: Message[] },
) => ({
  queryKey: ['thread', accountId, id],
  queryFn: () => api.conversation(accountId, id),
  placeholderData: known.ahead ?? known.listed,
})
