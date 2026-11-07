import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addWorkingDays,
  type Account,
  type AppEvent,
  type MailProvider,
  type ReminderFacts,
  type Settings,
} from '@inlark/core'
import { ReminderEngine } from '../apps/desktop/src/main/reminders/engine'
import { htmlOwnText, mainAskCheck } from '../apps/desktop/src/main/reminders/own-text'

// Set before any Date is created in this file; vitest gives each file its own worker.
process.env.TZ = 'America/Toronto'

const me = 'me@example.com'
const account = {
  id: 'a1',
  connectionId: 'c1',
  email: 'Me@Example.com',
  name: 'Me',
  protocol: 'imap',
  status: 'connected',
} as unknown as Account
const receivedMs = Date.parse('2026-11-02T15:00:00.000Z') // a Monday
const received = new Date(receivedMs).toISOString()

const fact = (over: Partial<ReminderFacts> = {}): ReminderFacts => ({
  threadId: 't1',
  messageId: 'm1@example.com',
  receivedAt: received,
  fromEmail: me,
  to: ['pat@example.com'],
  inInbox: true,
  labels: { noReminder: false, followUp: false },
  asks: true,
  ...over,
})
const incoming = (over: Partial<ReminderFacts> = {}) =>
  fact({ fromEmail: 'pat@example.com', to: [me], asks: null, ...over })

interface Harness {
  engine: ReminderEngine
  provider: MailProvider & Record<string, ReturnType<typeof vi.fn>>
  facts: ReminderFacts[]
  checks: Map<string, boolean>
  events: AppEvent[]
  returned: ReturnType<typeof vi.fn>
  stored: Map<string, unknown>
  clock: { now: number }
  settings: Settings
}

function harness(
  options: {
    facts?: ReminderFacts[]
    now?: number
    settings?: Partial<Settings>
    sent?: { id: string; messageId: string; html?: string; text?: string }[]
  } = {},
): Harness {
  const facts = options.facts ?? []
  const checks = new Map<string, boolean>()
  const sent = options.sent ?? []
  const clock = { now: options.now ?? receivedMs }
  const settings = { ...options.settings } as Settings
  const events: AppEvent[] = []
  const stored = new Map<string, unknown>()
  const provider = {
    reminderFacts: vi.fn(async () =>
      facts.map((f) => (checks.has(f.messageId!) ? { ...f, asks: checks.get(f.messageId!)! } : f)),
    ),
    askChecksNeeded: vi.fn(async (_a: Account, _since: number, limit: number) =>
      sent
        .filter((s) => !checks.has(s.messageId))
        .slice(0, limit)
        .map(({ id, messageId }) => ({ id, messageId })),
    ),
    setAskChecks: vi.fn(async (_a: Account, rows: { messageId: string; asks: boolean }[]) => {
      for (const row of rows) checks.set(row.messageId, row.asks)
    }),
    messages: vi.fn(async (_a: Account, ids: string[]) =>
      sent
        .filter((s) => ids.includes(s.id) && (s.html !== undefined || s.text !== undefined))
        .map((s) => ({ id: s.id, html: s.html, text: s.text })),
    ),
  } as unknown as Harness['provider']
  const returned = vi.fn(async (targets: { accountId: string; threadId: string }[]) => ({
    handled: targets,
    moved: targets.length,
    undoId: 'undo-1' as string | undefined,
  }))
  const engine = new ReminderEngine({
    accounts: () => [account],
    settings: () => settings,
    provider: (id) => (id === account.id ? provider : undefined),
    returnToInbox: returned,
    emit: (event) => events.push(event),
    store: {
      read: async <T>(key: string, fallback: T) =>
        stored.has(key) ? (stored.get(key) as T) : fallback,
      write: async (key, value) => void stored.set(key, value),
    },
    now: () => clock.now,
  })
  return { engine, provider, facts, checks, events, returned, stored, clock, settings }
}

let current: Harness | undefined
beforeEach(() =>
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }),
)
afterEach(() => {
  current?.engine.dispose()
  current = undefined
  vi.useRealTimers()
})
const make = (...args: Parameters<typeof harness>) => (current = harness(...args))
/** Lets the debounced recompute, and what it starts in the background, run. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(600)
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('ReminderEngine', () => {
  it('lists a forgot-to-reply one working day after receipt, and not before', async () => {
    const due = addWorkingDays(receivedMs, 1)
    const h = make({ facts: [incoming()], now: due - 60_000 })
    expect(await h.engine.due('a1')).toEqual([])
    h.clock.now = due
    expect(await h.engine.due('a1')).toEqual([
      { kind: 'reply', threadId: 't1', messageId: 'm1@example.com', dueMs: due },
    ])
    // Lowercase own addresses and the Important scope reach the index.
    expect(h.provider.reminderFacts).toHaveBeenCalledWith(
      account,
      expect.objectContaining({
        important: expect.objectContaining({ kind: 'important' }),
        sinceMs: due - 60_000 - 30 * 86_400_000,
      }),
    )
  })
  it('checks unchecked Sent mail in the background, and the next list has the follow-up', async () => {
    const h = make({
      facts: [fact({ asks: null })],
      now: addWorkingDays(receivedMs, 5),
      sent: [{ id: 's1', messageId: 'm1@example.com', html: '<p>Can you confirm?</p>' }],
    })
    expect(await h.engine.due('a1')).toEqual([])
    h.engine.start()
    await settle()
    expect(h.provider.askChecksNeeded).toHaveBeenCalledWith(account, expect.any(Number), 25)
    // Behind the user's own reading.
    expect(h.provider.messages).toHaveBeenCalledWith(account, ['s1'], true, { background: true })
    expect(h.provider.setAskChecks).toHaveBeenCalledWith(account, [
      { messageId: 'm1@example.com', asks: true },
    ])
    expect((await h.engine.due('a1')).map((r) => r.kind)).toEqual(['followUp'])
    expect(h.events).toContainEqual({ type: 'changed', accountId: 'a1' })
  })
  it('never reads an email twice in a session, even when its check didn’t store', async () => {
    const h = make({
      sent: [{ id: 's1', messageId: 'odd', text: 'Can you?' }],
    })
    // The index refuses the write, so the email stays listed as needing a check.
    h.provider.setAskChecks.mockImplementation(async () => {})
    h.engine.start()
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.provider.messages).toHaveBeenCalledTimes(1)
    expect(h.provider.setAskChecks).toHaveBeenCalledTimes(1)
    // One more pass found nothing new, and nothing scheduled another.
    expect(h.provider.askChecksNeeded).toHaveBeenCalledTimes(2)
  })
  it('skips the scan while follow-ups are off', async () => {
    const h = make({
      settings: { reminders: { followUp: false } },
      sent: [{ id: 's1', messageId: 'm1@example.com', text: 'Can you?' }],
    })
    h.engine.start()
    await settle()
    expect(h.provider.reminderFacts).toHaveBeenCalled()
    expect(h.provider.askChecksNeeded).not.toHaveBeenCalled()
  })
  it('recomputes at least every 5 seconds under a steady stream of changes', async () => {
    const h = make()
    h.engine.start()
    const stream = setInterval(() => h.engine.invalidate('a1'), 400)
    try {
      await vi.advanceTimersByTimeAsync(4900)
      expect(h.provider.reminderFacts).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      expect(h.provider.reminderFacts).toHaveBeenCalledTimes(1)
    } finally {
      clearInterval(stream)
    }
  })
  it('skips a body it can’t read for the rest of the session', async () => {
    const h = make({
      facts: [],
      sent: [
        { id: 's1', messageId: 'gone@example.com' },
        { id: 's2', messageId: 'm2@example.com', text: 'Done, all sent.' },
      ],
    })
    h.engine.start()
    await settle()
    expect(h.provider.setAskChecks).toHaveBeenCalledWith(account, [
      { messageId: 'm2@example.com', asks: false },
    ])
    h.engine.invalidate()
    await settle()
    // The unreadable one stays unchecked in the index, so a later session retries it.
    expect(h.checks.has('gone@example.com')).toBe(false)
    expect(h.provider.messages).toHaveBeenCalledTimes(1)
  })
  it('returns an archived due follow-up to the inbox once, with its undo', async () => {
    const h = make({ facts: [fact({ inInbox: false })], now: addWorkingDays(receivedMs, 4) })
    h.engine.start()
    await settle()
    expect(h.returned).toHaveBeenCalledTimes(1)
    expect(h.returned).toHaveBeenCalledWith([{ accountId: 'a1', threadId: 't1' }])
    expect(h.events).toContainEqual({ type: 'remindersReturned', count: 1, undoId: 'undo-1' })
    expect(h.stored.get('reminders-returned')).toEqual(['a1|t1|m1@example.com'])
    h.engine.invalidate('a1')
    await settle()
    expect(h.returned).toHaveBeenCalledTimes(1)
    expect(h.events.filter((e) => e.type === 'remindersReturned')).toHaveLength(1)
  })
  it('returns several in one move, so one undo covers them, and retries one that failed', async () => {
    const h = make({
      facts: [
        fact({ inInbox: false }),
        fact({ threadId: 't2', messageId: 'm2@example.com', inInbox: false }),
        fact({ threadId: 't3', messageId: 'm3@example.com', inInbox: false }),
      ],
      now: addWorkingDays(receivedMs, 4),
    })
    h.returned.mockImplementationOnce(async (targets) => ({
      handled: targets.filter((t) => t.threadId !== 't3'),
      moved: 2,
      undoId: 'undo-2',
    }))
    h.engine.start()
    await settle()
    expect(h.returned).toHaveBeenCalledTimes(1)
    expect(h.returned.mock.calls[0]![0].map((t) => t.threadId)).toEqual(['t1', 't2', 't3'])
    expect(h.events).toContainEqual({ type: 'remindersReturned', count: 2, undoId: 'undo-2' })
    expect(h.stored.get('reminders-returned')).toEqual([
      'a1|t1|m1@example.com',
      'a1|t2|m2@example.com',
    ])
    h.engine.invalidate('a1')
    await settle()
    expect(h.returned).toHaveBeenLastCalledWith([{ accountId: 'a1', threadId: 't3' }])
  })
  it('never returns a forgot-to-reply or one not yet due', async () => {
    const h = make({
      facts: [
        incoming({ threadId: 't2', messageId: 'm2@example.com', inInbox: false }),
        fact({ inInbox: false }),
      ],
      now: receivedMs + 60_000,
    })
    h.engine.start()
    await settle()
    expect(h.returned).not.toHaveBeenCalled()
  })
  it('keeps at most 500 returned keys, dropping the oldest', async () => {
    const h = make({ facts: [fact({ inInbox: false })], now: addWorkingDays(receivedMs, 4) })
    h.stored.set(
      'reminders-returned',
      Array.from({ length: 500 }, (_, i) => `a1|old${i}|x@example.com`),
    )
    h.engine.start()
    await settle()
    const keys = h.stored.get('reminders-returned') as string[]
    expect(keys).toHaveLength(500)
    expect(keys[0]).toBe('a1|old1|x@example.com')
    expect(keys.at(-1)).toBe('a1|t1|m1@example.com')
  })
  it('catches up on launch: a follow-up due while closed is listed at start', async () => {
    const h = make({ facts: [fact()], now: addWorkingDays(receivedMs, 5) })
    h.engine.start()
    expect(await h.engine.due('a1')).toEqual([
      {
        kind: 'followUp',
        threadId: 't1',
        messageId: 'm1@example.com',
        dueMs: addWorkingDays(receivedMs, 3),
      },
    ])
    expect(h.events).toEqual([])
  })
  it('hides a snoozed reminder until the snooze ends', async () => {
    const until = addWorkingDays(receivedMs, 6)
    const h = make({
      facts: [fact()],
      now: addWorkingDays(receivedMs, 4),
      settings: {
        reminderSnoozes: [{ accountId: 'a1', threadId: 't1', messageId: 'm1@example.com', until }],
      },
    })
    expect(await h.engine.due('a1')).toEqual([])
    expect(h.provider.reminderFacts).toHaveBeenCalledWith(
      account,
      expect.objectContaining({ threadIds: ['t1'] }),
    )
    h.clock.now = until + 1
    expect(await h.engine.due('a1')).toEqual([
      { kind: 'followUp', threadId: 't1', messageId: 'm1@example.com', dueMs: until },
    ])
  })
  it('wakes when the next reminder comes due', async () => {
    const due = addWorkingDays(receivedMs, 1)
    const h = make({ facts: [incoming()], now: due - 10 * 60_000 })
    h.engine.start()
    await settle()
    expect(h.events).toEqual([])
    h.clock.now = due
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.events).toContainEqual({ type: 'changed' })
  })
  it('does nothing while reminders are off', async () => {
    const h = make({
      facts: [incoming(), fact({ inInbox: false })],
      now: addWorkingDays(receivedMs, 5),
      settings: { reminders: { enabled: false } },
      sent: [{ id: 's1', messageId: 'm1@example.com', text: 'Can you?' }],
    })
    h.engine.start()
    expect(await h.engine.due('a1')).toEqual([])
    await settle()
    expect(h.provider.reminderFacts).not.toHaveBeenCalled()
    expect(h.provider.askChecksNeeded).not.toHaveBeenCalled()
    expect(h.returned).not.toHaveBeenCalled()
  })
  it('caches the list until invalidated', async () => {
    const h = make({ facts: [incoming()], now: addWorkingDays(receivedMs, 2) })
    await h.engine.due('a1')
    await h.engine.due('a1')
    expect(h.provider.reminderFacts).toHaveBeenCalledTimes(1)
    h.engine.invalidate('a1')
    await h.engine.due('a1')
    expect(h.provider.reminderFacts).toHaveBeenCalledTimes(2)
  })
})

describe('htmlOwnText', () => {
  it('drops quotes, signatures and images', () => {
    const html = `<div>Can you confirm the date?</div>
      <div data-inlark-signature><p>Alex Example</p></div>
      <p data-inlark-signature-text>Sent from my phone, why?</p>
      <blockquote>Old question?</blockquote>
      <div class="gmail_quote"><div class="gmail_attr">On Monday Pat wrote:</div>Earlier?</div>
      <img src="x.png" alt="logo?">`
    const text = htmlOwnText(html)
    expect(text).toBe('Can you confirm the date?')
  })
  it('asks from the HTML when there is HTML, else from the text', () => {
    expect(mainAskCheck({ html: '<p>Here it is.</p><blockquote>Can you?</blockquote>' })).toBe(
      false,
    )
    expect(mainAskCheck({ text: 'Could you send it?' })).toBe(true)
    expect(mainAskCheck({})).toBe(false)
  })
})
