import { describe, expect, it, vi } from 'vitest'
vi.mock('../apps/desktop/node_modules/idb', () => ({ openDB: async () => ({}) }))
vi.mock('../apps/desktop/src/renderer/src/api', () => ({ isDemo: true, api: {} }))
import { QueryClient, QueryObserver } from '../apps/desktop/node_modules/@tanstack/react-query'
import type { Conversation, Mailbox, Message, MutationResult, QueryPage } from '@inlark/core'
import {
  markReadOptimistically,
  readOnOpen,
} from '../apps/desktop/src/renderer/src/optimistic-read'
import {
  aheadHasBodies,
  openedThreadQuery,
  readAhead,
  readAheadKey,
  readAheadQuery,
} from '../apps/desktop/src/renderer/src/read-ahead'

const message = (id: string, threadId: string, seen: boolean, box = 'inbox') =>
  ({
    id,
    accountId: 'a',
    threadId,
    keywords: seen ? { $seen: true } : {},
    mailboxIds: { [box]: true },
  }) as unknown as Message
const conversation = (id: string, messages: Message[], accountId = 'a') =>
  ({
    id,
    accountId,
    key: accountId + ':' + id,
    unread: messages.some((m) => !m.keywords.$seen),
    messages,
  }) as unknown as Conversation
const box = (id: string, unreadEmails: number) => ({ id, accountId: 'a', unreadEmails }) as Mailbox

const mailKey = ['mail', { view: 'inbox' }]
const threadKey = ['thread', 'a', 't1']
const boxesKey = ['mailboxes', 'a']

/** Server state as the main process would report it, before the read reaches the server. */
const unreadServer = () => ({
  list: {
    pages: [
      {
        items: [
          conversation('t1', [message('m1', 't1', false), message('m2', 't1', false, 'archive')]),
          conversation('t2', [message('m3', 't2', false)]),
        ],
        total: 2,
        failedAccounts: [],
      } as QueryPage,
    ],
    pageParams: [undefined],
  },
  thread: [message('m1', 't1', false), message('m2', 't1', false, 'archive')],
  boxes: [box('inbox', 5), box('archive', 2), box('sent', 0)],
})
type Server = ReturnType<typeof unreadServer>

/** Lands a fetch result the way a refetch does (not a manual cache write). */
const land = (client: QueryClient, server: Server) =>
  Promise.all([
    client.fetchQuery({ queryKey: mailKey, queryFn: () => server.list, staleTime: 0 }),
    client.fetchQuery({ queryKey: threadKey, queryFn: () => server.thread, staleTime: 0 }),
    client.fetchQuery({ queryKey: boxesKey, queryFn: () => server.boxes, staleTime: 0 }),
  ])
const row = (client: QueryClient, id = 't1') =>
  client
    .getQueryData<{ pages: QueryPage[] }>(mailKey)!
    .pages.flatMap((p) => p.items)
    .find((c) => c.id === id)!
const thread = (client: QueryClient) => client.getQueryData<Message[]>(threadKey)!
const unread = (client: QueryClient, id: string) =>
  client.getQueryData<Mailbox[]>(boxesKey)!.find((b) => b.id === id)!.unreadEmails

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => ((resolve = yes), (reject = no)))
  return { promise, resolve, reject }
}
async function setup(refreshed: Promise<void> = Promise.resolve()) {
  const client = new QueryClient()
  await land(client, unreadServer())
  const mutation = deferred<MutationResult>()
  const refresh = vi.fn(() => refreshed)
  const done = markReadOptimistically(
    client,
    { accountId: 'a', threadId: 't1' },
    thread(client),
    () => mutation.promise,
    refresh,
  )
  return { client, mutation, refresh, done }
}
const ok: MutationResult = { changed: 1, failures: [] }

describe('marking an opened conversation read', () => {
  it('shows it read at once, before the server answers', async () => {
    const { client } = await setup()
    expect(row(client).unread).toBe(false)
    expect(row(client).messages.every((m) => m.keywords.$seen)).toBe(true)
    expect(thread(client).every((m) => m.keywords.$seen)).toBe(true)
    expect(row(client, 't2').unread).toBe(true)
  })

  it('lowers the unread count of each folder holding its unread messages', async () => {
    const { client } = await setup()
    expect(unread(client, 'inbox')).toBe(4)
    expect(unread(client, 'archive')).toBe(1)
    expect(unread(client, 'sent')).toBe(0)
  })

  it('keeps it read when a refresh lands before the server has marked it', async () => {
    const { client } = await setup()
    await land(client, unreadServer())
    expect(row(client).unread).toBe(false)
    expect(thread(client).every((m) => m.keywords.$seen)).toBe(true)
    expect(unread(client, 'inbox')).toBe(4)
  })

  it('refreshes once the server has marked it, then trusts the server again', async () => {
    const { client, mutation, refresh, done } = await setup()
    mutation.resolve(ok)
    await done
    expect(refresh).toHaveBeenCalledOnce()
    // Counts fetched after the change already include it, so they are not lowered twice.
    const server = unreadServer()
    server.boxes = [box('inbox', 4), box('archive', 1), box('sent', 0)]
    await land(client, server)
    expect(unread(client, 'inbox')).toBe(4)
    // Marked unread elsewhere later: the list shows what the server says.
    expect(row(client).unread).toBe(true)
  })

  it('keeps it read but trusts new counts while its refresh is still running', async () => {
    const refreshed = deferred<void>()
    const { client, mutation, refresh, done } = await setup(refreshed.promise)
    mutation.resolve(ok)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled())
    // A list fetch that started before the change can still land with the old flag.
    const server = unreadServer()
    server.boxes = [box('inbox', 4), box('archive', 1), box('sent', 0)]
    await land(client, server)
    expect(row(client).unread).toBe(false)
    expect(unread(client, 'inbox')).toBe(4)
    refreshed.resolve()
    await done
  })

  it('reverts to the server state and reports the error when marking fails', async () => {
    const { client, mutation, refresh, done } = await setup()
    mutation.reject(new Error('The server is unreachable.'))
    await expect(done).rejects.toThrow('The server is unreachable.')
    expect(refresh).toHaveBeenCalledOnce()
    await land(client, unreadServer())
    expect(row(client).unread).toBe(true)
    expect(unread(client, 'inbox')).toBe(5)
  })

  it('treats a failure the server reports as failing', async () => {
    const { client, mutation, done } = await setup()
    mutation.resolve({ changed: 0, failures: ['Gmail refused the change.'] })
    await expect(done).rejects.toThrow('Gmail refused the change.')
    await land(client, unreadServer())
    expect(row(client).unread).toBe(true)
  })

  it('stops holding it read once the person marks it unread', async () => {
    const { client } = await setup()
    client.setQueriesData<{ pages: QueryPage[] }>({ queryKey: ['mail'] }, (current) => ({
      ...current!,
      pages: current!.pages.map((p) => ({
        ...p,
        items: p.items.map((c) => (c.id === 't1' ? { ...c, unread: true } : c)),
      })),
    }))
    await land(client, unreadServer())
    expect(row(client).unread).toBe(true)
  })
})

describe('reading ahead', () => {
  const list = [conversation('t0', []), conversation('t1', []), conversation('t2', [])]
  const loaded = { status: 'success' as const, isPlaceholderData: false, isFetching: false }
  const connected = () => true

  it('waits until the opened conversation has loaded', () => {
    expect(
      readAhead(list, 'a', 't1', { ...loaded, status: 'pending', isFetching: true }, connected),
    ).toEqual([])
    // The list summary shown while the conversation loads does not count as loaded.
    expect(
      readAhead(
        list,
        'a',
        't1',
        { ...loaded, isPlaceholderData: true, isFetching: true },
        connected,
      ),
    ).toEqual([])
    expect(readAhead(list, 'a', 't1', { ...loaded, isFetching: true }, connected)).toEqual([])
    expect(readAhead(list, 'a', 't1', { ...loaded, status: 'error' }, connected)).toEqual([])
  })

  it('then reads the previous and next conversations', () => {
    expect(readAhead(list, 'a', 't1', loaded, connected).map((c) => c.id)).toEqual(['t0', 't2'])
    expect(readAhead(list, 'a', 't0', loaded, connected).map((c) => c.id)).toEqual(['t1'])
    expect(readAhead(list, 'a', undefined, loaded, connected)).toEqual([])
  })

  it('skips neighbours on accounts that are not connected', () => {
    const mixed = [conversation('t0', [], 'b'), list[1], list[2]]
    expect(readAhead(mixed, 'a', 't1', loaded, (id) => id === 'a').map((c) => c.id)).toEqual(['t2'])
  })

  it('asks for the neighbour as a prefetch', async () => {
    const conversationApi = vi.fn(async () => [] as Message[])
    const query = readAheadQuery({ conversation: conversationApi }, list[2])
    expect(query.queryKey).toEqual(readAheadKey('a', 't2'))
    await query.queryFn()
    expect(conversationApi).toHaveBeenCalledWith('a', 't2', { prefetch: true })
  })
})

describe('opening a conversation that was read ahead', () => {
  const summary = [message('m3', 't2', false)]
  const full = [{ ...message('m3', 't2', false), text: 'Full body' } as Message]
  it('treats a read-ahead missing any body as a summary, so the reader shows it loading', () => {
    const empty = { ...message('m4', 't2', false), html: '', text: '' } as Message
    expect(aheadHasBodies(undefined)).toBe(false)
    expect(aheadHasBodies([...full, empty])).toBe(true)
    // A large message left for the open to download and decrypt.
    expect(aheadHasBodies([...full, message('m5', 't2', false)])).toBe(false)
  })
  /** The main process: read-ahead (prefetch) answers wait behind background sync. */
  function server() {
    const background = deferred<Message[]>()
    const conversationApi = vi.fn(
      (_account: string, _id: string, options?: { prefetch?: boolean }) =>
        options?.prefetch ? background.promise : Promise.resolve(full),
    )
    return { background, api: { conversation: conversationApi } }
  }
  /** Opens t2 the way the reader does, with what is already known about it. */
  function open(client: QueryClient, api: ReturnType<typeof server>['api']) {
    const observer = new QueryObserver(
      client,
      openedThreadQuery(api, 'a', 't2', {
        ahead: client.getQueryData<Message[]>(readAheadKey('a', 't2')),
        listed: summary,
      }),
    )
    const stop = observer.subscribe(() => {})
    return { observer, stop }
  }

  it('asks for it in the foreground at once, even while the read-ahead is still waiting', async () => {
    const client = new QueryClient()
    const { api, background } = server()
    void client.prefetchQuery(readAheadQuery(api, { accountId: 'a', id: 't2' }))
    const { observer, stop } = open(client, api)
    expect(api.conversation).toHaveBeenLastCalledWith('a', 't2')
    await vi.waitFor(() => expect(observer.getCurrentResult().isPlaceholderData).toBe(false))
    expect(observer.getCurrentResult().data).toEqual(full)
    stop()
    background.resolve(full)
  })

  it('shows a finished read-ahead straight away while its own fetch runs', async () => {
    const client = new QueryClient()
    const { api, background } = server()
    background.resolve(full)
    await client.prefetchQuery(readAheadQuery(api, { accountId: 'a', id: 't2' }))
    const { observer, stop } = open(client, api)
    const shown = observer.getCurrentResult()
    expect(shown.data).toEqual(full)
    expect(shown.isPlaceholderData).toBe(true)
    expect(api.conversation).toHaveBeenLastCalledWith('a', 't2')
    stop()
  })

  it('shows read-ahead data as read once the conversation is marked read', async () => {
    const client = new QueryClient()
    const { api, background } = server()
    background.resolve(full)
    await client.prefetchQuery(readAheadQuery(api, { accountId: 'a', id: 't2' }))
    const mutation = deferred<MutationResult>()
    const done = markReadOptimistically(
      client,
      { accountId: 'a', threadId: 't2' },
      full,
      () => mutation.promise,
      async () => {},
    )
    const ahead = () => client.getQueryData<Message[]>(readAheadKey('a', 't2'))!
    expect(ahead().every((m) => m.keywords.$seen)).toBe(true)
    // A read-ahead that lands before the server has marked it keeps it read.
    await client.fetchQuery({ ...readAheadQuery(api, { accountId: 'a', id: 't2' }), staleTime: 0 })
    expect(ahead().every((m) => m.keywords.$seen)).toBe(true)
    const { observer, stop } = open(client, api)
    expect(observer.getCurrentResult().data!.every((m) => m.keywords.$seen)).toBe(true)
    stop()
    mutation.resolve(ok)
    await done
  })
})

describe('deciding to mark an opened conversation read', () => {
  const old = [message('m3', 't2', true)]
  const replied = [...old, message('m4', 't2', false)]

  it('waits for the real conversation when a stale read-ahead shows it all read', () => {
    const settled = { current: '' }
    const marks: Message[][] = []
    // Renders as the conversation opens: stale placeholder, then its own fetch with a new reply.
    for (const shown of [
      { data: old, isPlaceholderData: true },
      { data: old, isPlaceholderData: true },
      { data: replied, isPlaceholderData: false },
      { data: replied, isPlaceholderData: false },
    ]) {
      const marking = readOnOpen(settled, 'a:t2', shown)
      if (marking) marks.push(marking)
    }
    expect(marks).toEqual([replied])
  })

  it('marks at once from the list row when it is unread but the placeholder is not', () => {
    const row = conversation('t2', replied)
    expect(readOnOpen({ current: '' }, 'a:t2', { data: old, isPlaceholderData: true }, row)).toBe(
      row.messages,
    )
  })

  it('marks from an unread placeholder without settling, so the real conversation is checked too', () => {
    const settled = { current: '' }
    expect(readOnOpen(settled, 'a:t2', { data: replied, isPlaceholderData: true })).toBe(replied)
    expect(settled.current).toBe('')
    const read = replied.map((m) => ({ ...m, keywords: { $seen: true } }) as Message)
    expect(readOnOpen(settled, 'a:t2', { data: read, isPlaceholderData: false })).toBeUndefined()
    expect(settled.current).toBe('a:t2')
  })

  it('does not mark again once settled, even if the person marks it unread', () => {
    const settled = { current: 'a:t2' }
    expect(readOnOpen(settled, 'a:t2', { data: replied, isPlaceholderData: false })).toBeUndefined()
  })
})

describe('keeping read-ahead copies short-lived', () => {
  it('does not persist them, only the conversations people opened', async () => {
    vi.stubGlobal('location', { search: '' })
    const { persists } = await import('../apps/desktop/src/renderer/src/cache')
    expect(persists(['thread', 'a', 't2'])).toBe(true)
    expect(persists(readAheadKey('a', 't2'))).toBe(false)
    vi.unstubAllGlobals()
  })

  it('drops an unused read-ahead from memory within minutes', async () => {
    vi.useFakeTimers()
    const client = new QueryClient()
    await client.prefetchQuery(
      readAheadQuery(
        { conversation: async () => [message('m3', 't2', true)] },
        { accountId: 'a', id: 't2' },
      ),
    )
    expect(client.getQueryData(readAheadKey('a', 't2'))).toBeDefined()
    vi.advanceTimersByTime(5 * 60_000 + 1)
    expect(client.getQueryData(readAheadKey('a', 't2'))).toBeUndefined()
    vi.useRealTimers()
  })
})
