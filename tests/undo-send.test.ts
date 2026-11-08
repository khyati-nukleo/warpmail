import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Draft, SendResult, Settings } from '../packages/core/src'
import {
  UndoSend,
  undoSendKey,
  type UndoSendHost,
  type UndoSendStore,
} from '../apps/desktop/src/main/undo-send'

const id = 'fb4c0a00-254f-4fb1-965e-96d56ca9ef17'
const other = '0d0c3c5e-7a39-4b8e-9f43-2b1c9c4b7e10'
const base: Draft = {
  id,
  accountId: 'work',
  identityId: 'default',
  to: [{ name: 'Alex', email: 'alex@example.org' }],
  cc: [],
  bcc: [],
  subject: 'Plans',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [],
  updatedAt: '2026-11-07T10:00:00.000Z',
  status: 'local',
}
const sent: SendResult = { status: 'sent', message: 'Message sent.' }

/** An in-memory store that keeps what was last written, like the JSON files on disk. */
function memoryStore(): UndoSendStore & { files: Map<string, unknown>; fail?: boolean } {
  const files = new Map<string, unknown>()
  const store = {
    files,
    fail: false,
    read: async <T>(name: string, fallback: T) =>
      files.has(name) ? (structuredClone(files.get(name)) as T) : fallback,
    write: async (name: string, data: unknown) => {
      if (store.fail) throw new Error('Disk full')
      files.set(name, structuredClone(data))
    },
  }
  return store
}

let settings: Pick<Settings, 'undoSendSeconds' | 'undoSendOnQuit'>
let drafts: Map<string, Draft | 'locked'>
let started: Set<string>
let connecting: Set<string>
let store: ReturnType<typeof memoryStore>
let host: UndoSendHost & {
  send: ReturnType<typeof vi.fn<(draft: Draft) => Promise<SendResult>>>
  keep: ReturnType<typeof vi.fn<(draft: Draft) => Promise<unknown>>>
  notSent: ReturnType<typeof vi.fn<(id: string, message: string) => Promise<void>>>
  emit: ReturnType<typeof vi.fn>
}
let undoSend: UndoSend

const records = () => (store.files.get(undoSendKey) as { draftId: string; state: string }[]) ?? []
const start = async () => {
  undoSend = new UndoSend(store, host)
  await undoSend.init()
}
/** The app is killed and launched again. */
const kill = async () => {
  undoSend.dispose()
  await start()
}

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-11-07T10:00:05.000Z') })
  settings = {}
  drafts = new Map([[id, base]])
  started = new Set()
  connecting = new Set()
  store = memoryStore()
  host = {
    settings: () => settings,
    save: vi.fn(async (draft: Draft) => {
      drafts.set(draft.id, draft)
      return draft
    }),
    syncing: () => undefined,
    draft: (draftId) => drafts.get(draftId),
    send: vi.fn(async (draft: Draft) => {
      started.add(draft.id)
      return sent
    }),
    started: (draftId) => started.has(draftId),
    connecting: (accountId) => connecting.has(accountId),
    keep: vi.fn(async (draft: Draft) => draft),
    notSent: vi.fn(async () => {}),
    emit: vi.fn(),
    log: () => {},
  }
  await start()
})
afterEach(() => {
  undoSend.dispose()
  vi.useRealTimers()
})

describe('Undo send: the countdown', () => {
  it('sends only when the countdown ends, 10 seconds by default', async () => {
    const result = undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(host.send).not.toHaveBeenCalled()
    expect(undoSend.heldSends()).toEqual([
      {
        draftId: id,
        accountId: 'work',
        subject: 'Plans',
        dueAt: '2026-11-07T10:00:15.000Z',
        state: 'waiting',
      },
    ])
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual(sent)
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(host.send).toHaveBeenCalledWith(base)
    expect(undoSend.heldSends()).toEqual([])
    expect(records()).toEqual([])
  })
  it('uses the chosen delay', async () => {
    settings = { undoSendSeconds: 30 }
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(host.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.send).toHaveBeenCalledTimes(1)
  })
  it('sends at once and stores nothing when Undo send is off', async () => {
    settings = { undoSendSeconds: 0 }
    host.emit.mockClear()
    expect(await undoSend.hold(base)).toEqual(sent)
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(host.save).not.toHaveBeenCalled()
    expect(store.files.has(undoSendKey)).toBe(false)
    expect(host.emit).not.toHaveBeenCalled()
  })
  it('saves the draft and records the countdown on disk before it starts', async () => {
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(0)
    expect(host.save).toHaveBeenCalledWith(base)
    expect(records()).toEqual([
      expect.objectContaining({ draftId: id, state: 'waiting', updatedAt: base.updatedAt }),
    ])
    // The record holds no message content: the draft in Drafts is the only copy.
    expect(JSON.stringify(records())).not.toContain('Hello')
    expect(JSON.stringify(records())).not.toContain('alex@example.org')
  })
  it('refuses to start, sending nothing, when the countdown cannot be recorded', async () => {
    store.fail = true
    await expect(undoSend.hold(base)).rejects.toThrow('Disk full')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).not.toHaveBeenCalled()
    expect(undoSend.heldSends()).toEqual([])
  })
  it('marks the send as started on disk before handing it to sending', async () => {
    let onDisk: string | undefined
    host.send.mockImplementationOnce(async () => {
      onDisk = records()[0]?.state
      return sent
    })
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onDisk).toBe('sending')
  })
  it('passes a send failure on to the caller, as sending does today', async () => {
    host.send.mockRejectedValueOnce(new Error('The outgoing server rejected your login.'))
    const result = undoSend.hold(base)
    const settled = expect(result).rejects.toThrow('rejected your login')
    await vi.advanceTimersByTimeAsync(10_000)
    await settled
    expect(records()).toEqual([])
  })
})

describe('Undo send: undoing', () => {
  it('sends nothing and gives the draft back exactly as it was', async () => {
    const full: Draft = {
      ...base,
      cc: [{ name: 'Sam', email: 'sam@example.org' }],
      attachments: [{ id: 'att', name: 'plan.pdf', type: 'application/pdf', size: 3 }],
      inReplyTo: ['<earlier@example.org>'],
      references: ['<earlier@example.org>'],
      replyThreadId: 'thread',
      encryption: 'sign',
      readStatus: false,
    }
    const result = undoSend.hold(full)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(await undoSend.undo(id)).toEqual({ undone: true, draft: full })
    expect(await result).toMatchObject({ status: 'undone' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).not.toHaveBeenCalled()
    expect(records()).toEqual([])
    expect(undoSend.heldSends()).toEqual([])
    expect(host.emit).toHaveBeenLastCalledWith([])
  })
  it('is too late once the countdown has ended, and the email is sent once', async () => {
    let finish!: (r: SendResult) => void
    host.send.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const result = undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await undoSend.undo(id)).toEqual({ undone: false, reason: 'sending' })
    expect(undoSend.heldSends()).toMatchObject([{ draftId: id, state: 'sending' }])
    finish(sent)
    expect(await result).toEqual(sent)
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(await undoSend.undo(id)).toEqual({ undone: false, reason: 'gone' })
  })
  it('lets exactly one win when undo and the deadline land together', async () => {
    const result = undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(9_999)
    // Undo asked in the same tick the timer fires: whichever runs first wins outright.
    vi.advanceTimersByTime(1)
    const undo = await undoSend.undo(id)
    await vi.advanceTimersByTimeAsync(0)
    expect(undo).toEqual({ undone: false, reason: 'sending' })
    expect(await result).toEqual(sent)
    expect(host.send).toHaveBeenCalledTimes(1)

    host.send.mockClear()
    const second = undoSend.hold({ ...base, id: other })
    await vi.advanceTimersByTimeAsync(9_999)
    const undone = undoSend.undo(other)
    vi.advanceTimersByTime(1)
    expect(await undone).toMatchObject({ undone: true })
    expect(await second).toMatchObject({ status: 'undone' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).not.toHaveBeenCalled()
  })
  it('a second Send of the same draft replaces its countdown', async () => {
    const first = undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(5_000)
    const edited = { ...base, text: 'Hello again', updatedAt: '2026-11-07T10:00:09.000Z' }
    const second = undoSend.hold(edited)
    expect(await first).toMatchObject({ status: 'undone' })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(host.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await second).toEqual(sent)
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(host.send).toHaveBeenCalledWith(edited)
  })
  it('lists several pending sends, from different accounts, in the order they leave', async () => {
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(2_000)
    void undoSend.hold({ ...base, id: other, accountId: 'home', subject: 'Dinner' })
    await vi.advanceTimersByTimeAsync(0)
    expect(undoSend.heldSends().map((s) => [s.subject, s.accountId])).toEqual([
      ['Plans', 'work'],
      ['Dinner', 'home'],
    ])
    await undoSend.undo(id)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(host.send.mock.calls[0][0].id).toBe(other)
  })
})

describe('Undo send: the draft changed during the countdown', () => {
  it('sends nothing when the draft was edited after Send', async () => {
    const result = undoSend.hold(base)
    drafts.set(id, { ...base, text: 'Changed', updatedAt: '2026-11-07T10:00:08.000Z' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({
      status: 'unsent',
      message: expect.stringContaining('changed'),
    })
    expect(host.send).not.toHaveBeenCalled()
    expect(records()).toEqual([])
  })
  it('sends nothing when the draft was deleted', async () => {
    const result = undoSend.hold(base)
    drafts.delete(id)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({
      status: 'unsent',
      message: expect.stringContaining('deleted'),
    })
    expect(host.send).not.toHaveBeenCalled()
  })
  it('sends nothing when a protected draft cannot be read because the vault is locked', async () => {
    const result = undoSend.hold(base)
    drafts.set(id, 'locked')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({
      status: 'unsent',
      message: expect.stringContaining('Unlock'),
    })
    expect(host.send).not.toHaveBeenCalled()
  })
})

describe('Undo send: quitting during the countdown', () => {
  it('has nothing to wait for when nothing is pending', () => {
    expect(undoSend.onQuit()).toBeUndefined()
  })
  it('"Send it anyway" waits out each countdown, sends each once at its deadline, then settles', async () => {
    let finish!: (r: SendResult) => void
    host.send.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(2_000)
    void undoSend.hold({ ...base, id: other, accountId: 'home' })
    await vi.advanceTimersByTimeAsync(0)
    let done = false
    void undoSend.onQuit()!.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(7_999)
    // Out of sight now, but nothing leaves before its own deadline.
    expect(host.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(host.send.mock.calls[0][0].id).toBe(id)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(host.send).toHaveBeenCalledTimes(2)
    // The first is still sending: the quit waits for it.
    expect(done).toBe(false)
    finish(sent)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
    expect(records()).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).toHaveBeenCalledTimes(2)
  })
  it('a second quit during that wait leaves the countdown on disk, and the next launch resumes it', async () => {
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(2_000)
    void undoSend.onQuit()
    await vi.advanceTimersByTimeAsync(1_000)
    // The second quit goes straight through: the app stops here.
    await kill()
    expect(undoSend.heldSends()).toMatchObject([{ draftId: id, state: 'waiting' }])
    await vi.advanceTimersByTimeAsync(6_999)
    expect(host.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(host.send).toHaveBeenCalledTimes(1)
  })
  it('"Keep it as a draft" sends nothing and saves the drafts to the server', async () => {
    settings = { undoSendOnQuit: 'draft' }
    const result = undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(2_000)
    await undoSend.onQuit()
    expect(await result).toMatchObject({ status: 'unsent' })
    expect(host.keep).toHaveBeenCalledWith(base)
    expect(records()).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).not.toHaveBeenCalled()
  })
  it('"Keep it as a draft" still waits for a send whose countdown already ended', async () => {
    settings = { undoSendOnQuit: 'draft' }
    let finish!: (r: SendResult) => void
    host.send.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(10_000)
    let done = false
    void undoSend.onQuit()!.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    finish(sent)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
    expect(host.keep).not.toHaveBeenCalled()
  })
})

describe('Undo send: relaunching after the app was killed', () => {
  it('"Send it anyway" sends a past-due email once its account has connected, exactly once', async () => {
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(3_000)
    undoSend.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).not.toHaveBeenCalled()
    connecting.add('work')
    await start()
    // Past due: no Undo any more, and nothing leaves before the account is connected.
    expect(undoSend.heldSends()).toMatchObject([{ draftId: id, state: 'sending' }])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(host.send).not.toHaveBeenCalled()
    connecting.delete('work')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(host.send).toHaveBeenCalledWith(base)
    expect(records()).toEqual([])
    await kill()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).toHaveBeenCalledTimes(1)
  })
  it('"Send it anyway" resumes a countdown that has time left, with Undo', async () => {
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(3_000)
    await kill()
    expect(undoSend.heldSends()).toMatchObject([{ draftId: id, state: 'waiting' }])
    await vi.advanceTimersByTimeAsync(6_999)
    expect(host.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(host.send).toHaveBeenCalledTimes(1)
  })
  it('"Keep it as a draft" sends nothing and saves the draft to the server once connected', async () => {
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(3_000)
    undoSend.dispose()
    settings = { undoSendOnQuit: 'draft' }
    connecting.add('work')
    await vi.advanceTimersByTimeAsync(60_000)
    await start()
    expect(undoSend.heldSends()).toEqual([])
    expect(records()).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.keep).not.toHaveBeenCalled()
    connecting.delete('work')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.keep).toHaveBeenCalledWith(base)
    expect(host.send).not.toHaveBeenCalled()
  })
  it('never sends again when the kill came after sending started', async () => {
    // Like today's send: the journal records the attempt before anything leaves.
    host.send.mockImplementationOnce((draft) => {
      started.add(draft.id)
      return new Promise(() => {})
    })
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(records()).toMatchObject([{ state: 'sending' }])
    await kill()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(records()).toEqual([])
  })
  it('never sends again when the send journal shows it started, even if the record says waiting', async () => {
    store.files.set(undoSendKey, [
      {
        draftId: id,
        accountId: 'work',
        subject: 'Plans',
        updatedAt: base.updatedAt,
        dueAt: '2026-11-07T10:00:04.000Z',
        state: 'waiting',
      },
    ])
    started.add(id)
    await kill()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).not.toHaveBeenCalled()
    expect(records()).toEqual([])
  })
  it('sends nothing when the draft was deleted before the relaunch', async () => {
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(3_000)
    undoSend.dispose()
    drafts.delete(id)
    await vi.advanceTimersByTimeAsync(60_000)
    await start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.send).not.toHaveBeenCalled()
    expect(records()).toEqual([])
  })
  it('sends a record marked sending that never reached the journal, as nothing left', async () => {
    connecting.add('work')
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(10_000)
    // Killed while waiting for the account: marked sending, but no attempt on record.
    expect(records()).toMatchObject([{ state: 'sending' }])
    expect(host.send).not.toHaveBeenCalled()
    await kill()
    connecting.delete('work')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.send).toHaveBeenCalledTimes(1)
  })
  it('keeps such a record as a draft when that is the setting', async () => {
    connecting.add('work')
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(10_000)
    settings = { undoSendOnQuit: 'draft' }
    await kill()
    connecting.delete('work')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.send).not.toHaveBeenCalled()
    expect(host.keep).toHaveBeenCalledWith(base)
  })
  it('re-reads the draft after waiting for the connection: edited or deleted meanwhile, not sent', async () => {
    void undoSend.hold(base)
    void undoSend.hold({ ...base, id: other })
    await vi.advanceTimersByTimeAsync(3_000)
    undoSend.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    connecting.add('work')
    await start()
    drafts.set(id, { ...base, text: 'Changed', updatedAt: '2026-11-07T10:01:00.000Z' })
    drafts.delete(other)
    connecting.delete('work')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.send).not.toHaveBeenCalled()
    // Nobody is waiting on these after a relaunch, so the draft itself says why.
    expect(host.notSent).toHaveBeenCalledWith(id, expect.stringContaining('changed'))
  })
})

describe('Undo send: edges found in review', () => {
  it('an Undo while a second Send of the draft is still saving cancels that Send', async () => {
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(2_000)
    let saved!: () => void
    host.save.mockImplementationOnce(
      (draft: Draft) => new Promise((resolve) => (saved = () => resolve(draft))),
    )
    const again = undoSend.hold({ ...base, updatedAt: '2026-11-07T10:00:07.000Z' })
    const undo = undoSend.undo(id)
    saved()
    expect(await undo).toMatchObject({ undone: true })
    expect(await again).toMatchObject({ status: 'undone' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).not.toHaveBeenCalled()
    expect(records()).toEqual([])
  })
  it('a quit while a Send is still saving waits for it, and keeps it when that is the setting', async () => {
    settings = { undoSendOnQuit: 'draft' }
    let saved!: () => void
    host.save.mockImplementationOnce(
      (draft: Draft) => new Promise((resolve) => (saved = () => resolve(draft))),
    )
    const result = undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(0)
    const quit = undoSend.onQuit()
    expect(quit).toBeDefined()
    saved()
    await quit
    expect(await result).toMatchObject({ status: 'unsent' })
    expect(host.keep).toHaveBeenCalledWith(base)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).not.toHaveBeenCalled()
  })
  it('a quit while a Send is still saving counts it down too, with "Send it anyway"', async () => {
    let saved!: () => void
    host.save.mockImplementationOnce(
      (draft: Draft) => new Promise((resolve) => (saved = () => resolve(draft))),
    )
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(0)
    let done = false
    void undoSend.onQuit()!.then(() => (done = true))
    saved()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(host.send).not.toHaveBeenCalled()
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(done).toBe(true)
  })
  it('claims the draft from background saves while it is held', async () => {
    expect(undoSend.holds(id)).toBe(false)
    void undoSend.hold(base)
    expect(undoSend.holds(id)).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(undoSend.holds(id)).toBe(false)
  })
  it('an Undo whose record could not be written is still never sent, after a quit', async () => {
    const result = undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(3_000)
    store.fail = true
    expect(await undoSend.undo(id)).toMatchObject({ undone: true })
    expect(await result).toMatchObject({ status: 'undone' })
    store.fail = false
    // The quit writes what the failed write missed.
    await undoSend.onQuit()
    undoSend.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    await start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.send).not.toHaveBeenCalled()
    expect(records()).toEqual([])
  })
  it('an Undo whose record could not be written is still never sent, after a kill', async () => {
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(3_000)
    store.fail = true
    await undoSend.undo(id)
    await vi.advanceTimersByTimeAsync(2_000)
    store.fail = false
    // Retried in the background until it is written.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(records()).toEqual([])
    await kill()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).not.toHaveBeenCalled()
  })
  it('a second Send that could not be recorded leaves no earlier countdown to send later', async () => {
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(3_000)
    store.fail = true
    await expect(undoSend.hold(base)).rejects.toThrow('Disk full')
    store.fail = false
    await vi.advanceTimersByTimeAsync(5_000)
    await kill()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.send).not.toHaveBeenCalled()
  })
  it('"Keep it as a draft" on relaunch says why an email whose countdown had ended was kept', async () => {
    connecting.add('work')
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(10_000)
    settings = { undoSendOnQuit: 'draft' }
    await kill()
    connecting.delete('work')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.send).not.toHaveBeenCalled()
    expect(host.notSent).toHaveBeenCalledWith(id, expect.stringContaining('Drafts'))
  })
  it('"Keep it as a draft" on relaunch says nothing for an email still counting down', async () => {
    void undoSend.hold(base)
    await vi.advanceTimersByTimeAsync(3_000)
    settings = { undoSendOnQuit: 'draft' }
    await kill()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.notSent).not.toHaveBeenCalled()
  })
})
