import type { Query, QueryClient } from '@tanstack/react-query'
import type { Conversation, Mailbox, Message, MutationResult, QueryPage } from '@inlark/core'

type Target = { accountId: string; threadId: string }
type ListData = { pages: QueryPage[] }

const seen = (messages: Message[]) =>
  messages.some((m) => !m.keywords.$seen)
    ? messages.map((m) =>
        m.keywords.$seen ? m : { ...m, keywords: { ...m.keywords, $seen: true } },
      )
    : messages
const isTarget = (c: Conversation, target: Target) =>
  c.accountId === target.accountId && c.id === target.threadId

/** The list with the conversation's row read; the same object when nothing changes. */
function readList(data: ListData | undefined, target: Target) {
  if (!data?.pages?.some((p) => p.items.some((c) => isTarget(c, target) && c.unread))) return data
  return {
    ...data,
    pages: data.pages.map((p) => ({
      ...p,
      items: p.items.map((c) =>
        isTarget(c, target) ? { ...c, unread: false, messages: seen(c.messages) } : c,
      ),
    })),
  }
}
/** Each folder's count without the messages that are now read. */
const readMailboxes = (boxes: Mailbox[] | undefined, unseen: Message[]) =>
  boxes?.map((box) => {
    const count = unseen.filter((m) => m.mailboxIds[box.id]).length
    return count ? { ...box, unreadEmails: Math.max(0, box.unreadEmails - count) } : box
  })

/**
 * Shows an opened conversation as read straight away, while the server marks it read, which can
 * take seconds behind other work. Until then, any fetch that lands with the old state gets the
 * read state applied again, so a refresh cannot flip the row back to unread. Counts are lowered
 * only on fetches made before the server answered; later ones already include the change. Once
 * the person marks the row unread themselves, their choice wins. On failure, the server state is
 * fetched again and the error is thrown for the caller to show.
 */
export async function markReadOptimistically(
  client: QueryClient,
  target: Target,
  messages: Message[],
  mutate: () => Promise<MutationResult>,
  refresh: () => Promise<unknown>,
) {
  const unseen = messages.filter((m) => !m.keywords.$seen)
  let counting = true,
    holding = true
  const apply = (query: Query) => {
    const [kind, accountId, threadId] = query.queryKey
    if (kind === 'mail') {
      const next = readList(query.state.data as ListData | undefined, target)
      if (next !== query.state.data) client.setQueryData(query.queryKey, next)
    } else if (
      // The opened conversation and its read-ahead copy (`['thread', account, id, 'ahead']`).
      kind === 'thread' &&
      accountId === target.accountId &&
      threadId === target.threadId
    ) {
      const data = query.state.data as Message[] | undefined,
        next = data && seen(data)
      if (next !== data) client.setQueryData(query.queryKey, next)
    } else if (kind === 'mailboxes' && accountId === target.accountId && counting)
      client.setQueryData(
        query.queryKey,
        readMailboxes(query.state.data as Mailbox[] | undefined, unseen),
      )
  }
  const stop = client.getQueryCache().subscribe((event) => {
    if (!holding || event.type !== 'updated' || event.action.type !== 'success') return
    if (!event.action.manual) return apply(event.query)
    // Marked unread by the person (the list is changed by hand for that): stop holding it read.
    const data = event.query.state.data as ListData | undefined
    if (
      event.query.queryKey[0] === 'mail' &&
      data?.pages?.some((p) => p.items.some((c) => isTarget(c, target) && c.unread))
    ) {
      holding = false
      stop()
    }
  })
  const release = () => {
    holding = false
    stop()
  }
  for (const query of client.getQueryCache().findAll({
    predicate: (q) => ['mail', 'thread', 'mailboxes'].includes(String(q.queryKey[0])),
  }))
    apply(query)
  try {
    const result = await mutate()
    if (result.failures.length) throw new Error(result.failures[0])
  } catch (error) {
    release()
    void refresh()
    throw error
  }
  counting = false
  try {
    await refresh()
  } finally {
    release()
  }
}

/**
 * What to mark read as the opened conversation renders, if anything. A placeholder (a read-ahead
 * copy or the list summary) can be stale, so it never settles the decision: a reply that arrived
 * since must still be marked once the conversation's own fetch shows it. Unread messages in the
 * placeholder, or an unread list row, are marked straight away. Once the real conversation has
 * been seen it is settled, so marking it unread by hand sticks.
 */
export function readOnOpen(
  settled: { current: string },
  key: string,
  shown: { data?: Message[]; isPlaceholderData: boolean },
  listed?: Pick<Conversation, 'unread' | 'messages'>,
): Message[] | undefined {
  if (!shown.data || settled.current === key) return
  if (!shown.isPlaceholderData) settled.current = key
  if (shown.data.some((m) => !m.keywords.$seen)) return shown.data
  if (shown.isPlaceholderData && listed?.unread) return listed.messages
}
