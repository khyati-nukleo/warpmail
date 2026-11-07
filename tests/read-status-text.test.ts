import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../packages/core/src'
import type { RecipientReadStatus } from '../packages/core/src/read-status'
import {
  readStatusLine,
  readStatusSmallPrint,
} from '../apps/desktop/src/renderer/src/read-status/read-status-text'

// Local times, so the day words hold in any time zone. The wording assumes an en-US locale.
const now = new Date(2026, 10, 6, 17, 0)
const at = (day: number, hour: number, minute: number) =>
  new Date(2026, 10, day, hour, minute).toISOString()
const status = (patch: Partial<RecipientReadStatus>): RecipientReadStatus => ({
  email: 'alex@example.org',
  state: 'none',
  opens: 0,
  ...patch,
})

describe('readStatusLine', () => {
  it('gives the count and the last open', () => {
    const s = status({ state: 'opened', opens: 2, firstAt: at(5, 8, 0), lastAt: at(6, 15, 12) })
    expect(readStatusLine(s, now)).toBe('Opened 2× · last today 3:12 pm')
  })

  it('gives the time of a single open', () => {
    const s = status({ state: 'opened', opens: 1, firstAt: at(6, 15, 12), lastAt: at(6, 15, 12) })
    expect(readStatusLine(s, now)).toBe('Opened 1× · today 3:12 pm')
  })

  it('counts a reply as opened', () => {
    const s = status({ state: 'opened', repliedAt: at(5, 9, 5) })
    expect(readStatusLine(s, now)).toBe('Opened · replied yesterday 9:05 am')
  })

  it('adds the reply after the count', () => {
    const s = status({
      state: 'opened',
      opens: 1,
      firstAt: at(5, 8, 30),
      lastAt: at(5, 8, 30),
      repliedAt: at(5, 9, 5),
    })
    expect(readStatusLine(s, now)).toBe('Opened 1× · yesterday 8:30 am · replied yesterday 9:05 am')
  })

  it('names the date of older opens', () => {
    const s = status({ state: 'opened', opens: 1, firstAt: at(2, 10, 0), lastAt: at(2, 10, 0) })
    expect(readStatusLine(s, now)).toBe('Opened 1× · Nov 2, 10:00 am')
  })

  it('says when only Apple Mail loaded the image', () => {
    expect(readStatusLine(status({ state: 'apple' }), now)).toBe(
      "Delivered to Apple Mail, can't tell",
    )
  })

  it('says when nothing was seen', () => {
    expect(readStatusLine(status({ state: 'none' }), now)).toBe('No signal yet')
  })
})

describe('readStatusSmallPrint', () => {
  it('says what is reliable and lists the four caveats', () => {
    expect(readStatusSmallPrint).toHaveLength(5)
    const text = readStatusSmallPrint.join('\n')
    expect(text).toContain('the count is a rough guide')
    expect(text).toContain('Gmail')
    expect(text).toContain('Blocked images')
    expect(text).toContain('Several devices')
    expect(text).toContain('forwarded')
  })
})

describe('statusesByMessage', () => {
  const sent = (id: string, messageId: string) =>
    ({
      id,
      from: [{ name: '', email: 'me@example.com' }],
      to: [{ name: '', email: 'alex@example.org' }],
      cc: [],
      bcc: [],
      receivedAt: '2026-11-06T10:00:00.000Z',
      messageId: [messageId],
    }) as unknown as Message
  const lookup = (at: number) => ({
    recipients: [{ email: 'alex@example.org', fetches: [{ at, source: 'other' as const }] }],
  })
  it('matches lookups by Message-ID, so earlier results stay put while a new message loads', async () => {
    vi.stubGlobal('location', { search: '', protocol: 'file:' })
    vi.stubGlobal('window', {})
    try {
      const { statusesByMessage } =
        await import('../apps/desktop/src/renderer/src/read-status/useReadStatus')
      const first = sent('m1', 'one@example.com')
      const second = sent('m2', 'two@example.com')
      // The previous answer (for the first message only) while the new lookup is under way.
      const previous = [{ messageId: 'one@example.com', lookup: lookup(1) }]
      const out = statusesByMessage([second, first], previous, [first, second])
      expect([...out.keys()]).toEqual(['m1'])
      expect(out.get('m1')).toMatchObject([{ email: 'alex@example.org', state: 'opened' }])
      const untracked = [{ messageId: 'one@example.com', lookup: null }]
      expect(statusesByMessage([first], untracked, [first]).size).toBe(0)
      expect(statusesByMessage([first], undefined, [first]).size).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
