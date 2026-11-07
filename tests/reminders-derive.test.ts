import { describe, expect, it } from 'vitest'
import {
  addWorkingDays,
  defaultReminderSettings,
  deriveReminder,
  followUpAsk,
  reminderLabelText,
  reminderSettingsOf,
  type ReminderFacts,
  type ReminderSettings,
} from '@inlark/core'

// Set before any Date is created in this file; vitest gives each file its own worker.
process.env.TZ = 'America/Toronto'

const received = '2026-11-02T15:00:00.000Z' // a Monday
const receivedMs = Date.parse(received)
const me = 'me@example.com'
const own = [me, 'alias@example.org']

const facts = (over: Partial<ReminderFacts> = {}): ReminderFacts => ({
  threadId: 't1',
  messageId: 'm1@example.com',
  receivedAt: received,
  fromEmail: me,
  to: ['pat@example.com'],
  inInbox: true,
  labels: { noReminder: false, followUp: false, returned: false },
  asks: true,
  ...over,
})
const incoming = (over: Partial<ReminderFacts> = {}) =>
  facts({ fromEmail: 'pat@example.com', to: [me], asks: null, ...over })
const derive = (f: ReminderFacts, settings: Partial<ReminderSettings> = {}) =>
  deriveReminder(f, { own, settings: { ...defaultReminderSettings, ...settings } })

describe('deriveReminder', () => {
  it('follow-up when I sent a message that asks', () => {
    expect(derive(facts())).toEqual({
      kind: 'followUp',
      threadId: 't1',
      messageId: 'm1@example.com',
      dueMs: addWorkingDays(receivedMs, 3),
    })
  })
  it('nothing when my message does not ask', () =>
    expect(derive(facts({ asks: false }))).toBeNull())
  it('nothing when the ask-check never ran', () => expect(derive(facts({ asks: null }))).toBeNull())
  it('follow-up label forces a follow-up', () =>
    expect(
      derive(facts({ asks: false, labels: { noReminder: false, followUp: true, returned: false } }))
        ?.kind,
    ).toBe('followUp'))
  it('no-reminder label wins', () =>
    expect(
      derive(facts({ labels: { noReminder: true, followUp: false, returned: false } })),
    ).toBeNull())
  it('reply when a person wrote to me', () =>
    expect(derive(incoming())).toMatchObject({
      kind: 'reply',
      dueMs: addWorkingDays(receivedMs, 1),
    }))
  it('nothing when I am only on Cc', () =>
    expect(derive(incoming({ to: ['sam@example.com'] }))).toBeNull())
  it('nothing for a reply outside the inbox', () =>
    expect(derive(incoming({ inInbox: false }))).toBeNull())
  it('follow-up off silences my own messages', () =>
    expect(derive(facts(), { followUp: false })).toBeNull())
  it('forgot-to-reply off silences incoming', () =>
    expect(derive(incoming(), { forgotToReply: false })).toBeNull())
  it('disabled feature gives nothing', () => expect(derive(facts(), { enabled: false })).toBeNull())
  it('nothing without a message id', () => expect(derive(facts({ messageId: null }))).toBeNull())
  it('an alias counts as me', () =>
    expect(derive(facts({ fromEmail: 'alias@example.org' }))?.kind).toBe('followUp'))
  it('an alias on To counts as me', () =>
    expect(derive(incoming({ to: ['alias@example.org'] }))?.kind).toBe('reply'))
  it('uses the configured days', () =>
    expect(derive(facts(), { followUpDays: 5 })?.dueMs).toBe(addWorkingDays(receivedMs, 5)))

  // My earlier ask stands when my own later message doesn't ask.
  const earlier = '2026-10-30T15:00:00.000Z' // the Friday before
  it('follow-up from my earlier ask when my latest message does not ask', () =>
    expect(
      derive(
        facts({
          asks: false,
          ownAsk: { messageId: 'm0@example.com', receivedAt: earlier },
        }),
      ),
    ).toEqual({
      kind: 'followUp',
      threadId: 't1',
      // Any new message still resets a dismissal or snooze.
      messageId: 'm1@example.com',
      dueMs: addWorkingDays(Date.parse(earlier), 3),
    }))
  it('nothing when no message of mine since the last reply asks', () =>
    expect(derive(facts({ asks: false, ownAsk: null }))).toBeNull())
  it('the no-reminder label on my latest message still wins over an earlier ask', () =>
    expect(
      derive(
        facts({
          asks: false,
          labels: { noReminder: true, followUp: false, returned: false },
          ownAsk: { messageId: 'm0@example.com', receivedAt: earlier },
        }),
      ),
    ).toBeNull())
  it('nothing when every To recipient is a robot or me', () => {
    expect(derive(facts({ to: ['noreply@example.com'] }))).toBeNull()
    expect(derive(facts({ to: ['no-reply@example.com', 'alias@example.org'] }))).toBeNull()
    expect(derive(facts({ to: [me] }))).toBeNull()
  })
  it('follow-up when a person is on To beside a robot', () =>
    expect(derive(facts({ to: ['noreply@example.com', 'pat@example.com'] }))?.kind).toBe(
      'followUp',
    ))

  const snooze = (messageId: string, until: number) => ({
    accountId: 'a1',
    threadId: 't1',
    messageId,
    until,
  })
  it('a snooze for the same message pushes the due time', () => {
    const until = addWorkingDays(receivedMs, 10)
    const r = deriveReminder(facts(), {
      own,
      settings: defaultReminderSettings,
      snooze: snooze('m1@example.com', until),
    })
    expect(r?.dueMs).toBe(until)
  })
  it('a snooze never makes it earlier', () => {
    const r = deriveReminder(facts(), {
      own,
      settings: defaultReminderSettings,
      snooze: snooze('m1@example.com', receivedMs),
    })
    expect(r?.dueMs).toBe(addWorkingDays(receivedMs, 3))
  })
  it('a snooze for another message is ignored', () => {
    const r = deriveReminder(facts(), {
      own,
      settings: defaultReminderSettings,
      snooze: snooze('other@example.com', addWorkingDays(receivedMs, 10)),
    })
    expect(r?.dueMs).toBe(addWorkingDays(receivedMs, 3))
  })
})

describe('reminderSettingsOf', () => {
  it('fills defaults', () => expect(reminderSettingsOf({})).toEqual(defaultReminderSettings))
  it('clamps days to whole numbers 1 to 30', () => {
    expect(reminderSettingsOf({ reminders: { followUpDays: 99 } }).followUpDays).toBe(30)
    expect(reminderSettingsOf({ reminders: { replyDays: 0 } }).replyDays).toBe(1)
    expect(reminderSettingsOf({ reminders: { replyDays: 2.6 } }).replyDays).toBe(3)
    expect(reminderSettingsOf({ reminders: { replyDays: Number.NaN } }).replyDays).toBe(1)
  })
  it('keeps booleans', () =>
    expect(reminderSettingsOf({ reminders: { enabled: false } }).enabled).toBe(false))
})

describe('reminderLabelText', () => {
  it('reply', () =>
    expect(reminderLabelText('reply', defaultReminderSettings)).toBe('Waiting on you'))
  it('follow-up days', () => {
    expect(reminderLabelText('followUp', defaultReminderSettings)).toBe('No reply in 3 days')
    expect(reminderLabelText('followUp', { ...defaultReminderSettings, followUpDays: 1 })).toBe(
      'No reply in 1 day',
    )
  })
})

describe('followUpAsk', () => {
  it('is this message when it asks or carries Follow up, else my earlier ask, else none', () => {
    const earlier = { messageId: 'm0@example.com', receivedAt: '2026-11-01T15:00:00.000Z' }
    expect(followUpAsk(facts({ ownAsk: earlier }))).toEqual({
      messageId: 'm1@example.com',
      receivedAt: received,
      returned: false,
    })
    expect(
      followUpAsk(
        facts({ asks: false, labels: { noReminder: false, followUp: true, returned: false } }),
      )?.messageId,
    ).toBe('m1@example.com')
    expect(followUpAsk(facts({ asks: false, ownAsk: earlier }))).toEqual({
      ...earlier,
      returned: false,
    })
    // Its Returned label, on whichever message is the ask.
    expect(
      followUpAsk(facts({ labels: { noReminder: false, followUp: false, returned: true } }))
        ?.returned,
    ).toBe(true)
    expect(
      followUpAsk(facts({ asks: false, ownAsk: { ...earlier, returned: true } }))?.returned,
    ).toBe(true)
    expect(followUpAsk(facts({ asks: false, ownAsk: null }))).toBeNull()
  })
})
