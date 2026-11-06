import { describe, expect, it, vi } from 'vitest'
import type { Draft, SendResult } from '../packages/core/src'
import { deliver, latestDraft, type SendIO } from '../apps/desktop/src/renderer/src/background-send'

const draft: Draft = {
  id: 'draft',
  accountId: 'account',
  identityId: 'identity',
  to: [{ name: 'Alex', email: 'alex@example.org' }],
  cc: [],
  bcc: [],
  subject: 'Plans',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [],
  updatedAt: '2026-09-23T10:00:00.000Z',
  status: 'local',
}
const io = (send: () => Promise<SendResult>, saved: Draft[] = []) =>
  ({
    send: vi.fn(send),
    reconcile: vi.fn(async (): Promise<SendResult> => ({
      status: 'sent',
      message: 'Delivery confirmed.',
    })),
    drafts: vi.fn(async () => saved),
    localSaveDraft: vi.fn(async () => {}),
    localDeleteDraft: vi.fn(async () => {}),
  }) satisfies SendIO

describe('sending in the background', () => {
  it('reports an accepted message as sent and clears its local copy', async () => {
    const api = io(async () => ({ status: 'sent', message: 'Message sent.' }))
    expect(await deliver(draft, api)).toEqual({ text: 'Message sent.' })
    expect(api.send).toHaveBeenCalledWith(draft)
    expect(api.localDeleteDraft).toHaveBeenCalledWith('draft')
  })
  it('still reports sent when only the local cache cleanup fails', async () => {
    const api = io(async () => ({ status: 'sent', message: 'Message sent.' }))
    api.localDeleteDraft.mockRejectedValue(new Error('Quota'))
    expect(await deliver(draft, api)).toEqual({
      text: 'Message sent. The local draft cache could not be cleaned up.',
    })
  })
  it('names refused recipients of a partial send', async () => {
    const api = io(async () => ({
      status: 'partial',
      message: 'Sent to some recipients.',
      rejected: [{ name: 'Sam', email: 'sam@example.org' }],
    }))
    expect((await deliver(draft, api)).text).toBe(
      'Sent, but refused by sam@example.org. Drafts has the details.',
    )
  })
  it('never reports an unconfirmed send as sent, and keeps the draft to review', async () => {
    const api = io(async () => ({ status: 'uncertain', message: 'Delivery is not confirmed.' }))
    const outcome = await deliver(draft, api)
    expect(outcome).toMatchObject({
      tone: 'error',
      text: 'Delivery is not confirmed.',
      draft: { id: 'draft', status: 'uncertain', text: 'Hello' },
    })
    expect(api.localSaveDraft).toHaveBeenCalledWith(outcome.draft)
    expect(api.localDeleteDraft).not.toHaveBeenCalled()
  })
  it('returns the saved draft with its error when sending fails', async () => {
    const failed = {
      ...draft,
      status: 'error' as const,
      error: 'The outgoing server rejected your login.',
      errorKind: 'outgoingAuthentication' as const,
    }
    const api = io(async () => {
      throw new Error('The outgoing server rejected your login.')
    }, [failed])
    expect(await deliver(draft, api)).toEqual({
      tone: 'error',
      text: 'The outgoing server rejected your login.',
      draft: failed,
    })
    expect(api.localSaveDraft).toHaveBeenCalledWith(failed)
    expect(api.localDeleteDraft).not.toHaveBeenCalled()
  })
  it('keeps the draft it was given when the failure cannot be looked up', async () => {
    const api = io(async () => {
      throw new Error('Connection lost.')
    })
    api.drafts.mockRejectedValue(new Error('Gone'))
    expect(await deliver(draft, api)).toEqual({
      tone: 'error',
      text: 'Connection lost.',
      draft,
    })
  })
  it('confirms delivery when the send call failed after the server recorded it as sent', async () => {
    const api = io(async () => {
      throw new Error('Connection lost.')
    }, [{ ...draft, status: 'sent' }])
    expect(await deliver(draft, api)).toEqual({ text: 'Delivery confirmed.' })
  })
  it('checks delivery of an unconfirmed draft instead of sending it again', async () => {
    const api = io(async () => ({ status: 'sent', message: 'Message sent.' }))
    const outcome = await deliver({ ...draft, status: 'uncertain' }, api)
    expect(api.send).not.toHaveBeenCalled()
    expect(api.reconcile).toHaveBeenCalledWith('draft')
    expect(outcome).toEqual({ text: 'Delivery confirmed.' })
  })
})

describe('reopening a draft that was not sent', () => {
  it('opens the copy as it is now, not as it was when the send failed', async () => {
    const fixed = { ...draft, text: 'Fixed', updatedAt: '2026-09-23T10:09:00.000Z' }
    expect(await latestDraft('draft', async () => [fixed])).toBe(fixed)
  })
  it('finds nothing to open once the draft was sent or deleted', async () => {
    expect(await latestDraft('draft', async () => [{ ...draft, status: 'sent' }])).toBeUndefined()
    expect(await latestDraft('draft', async () => [])).toBeUndefined()
  })
})
