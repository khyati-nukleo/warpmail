import {
  undoSendOnQuit,
  undoSendSeconds,
  type Draft,
  type HeldSend,
  type NotSentResult,
  type SendResult,
  type Settings,
  type UndoSendResult,
} from '@inlark/core'

/** The store file that holds pending sends, beside the send journal (`submissions`). */
export const undoSendKey = 'undo-sends'
/** How long a send after a relaunch waits for its account to finish connecting. */
const connectWaitMs = 2 * 60_000
const connectPollMs = 250
/** A pending-sends write that failed is tried again this often until it lands. */
const retryWriteMs = 2_000
/** A send stopped by `dispose` before it was handed over. */
const stopped = new Error('Stopped before sending.')

const notSent = {
  undone: 'Not sent.',
  replaced: 'Not sent. You pressed Send on it again.',
  edited: 'You changed this email after pressing Send, so it wasn’t sent. It’s in Drafts.',
  deleted: 'This email was deleted before it was sent, so nothing was sent.',
  locked: 'Unlock the encryption vault, then send this email again. It’s in Drafts.',
  kept: 'Not sent. It’s in Drafts.',
  closed:
    'inlark closed before this email was sent, so it was kept in Drafts. Send it again when you’re ready.',
} as const

export interface UndoSendStore {
  read<T>(name: string, fallback: T): Promise<T>
  write(name: string, data: unknown): Promise<void>
}
/** What `UndoSend` needs from the mail service. */
export interface UndoSendHost {
  settings(): Pick<Settings, 'undoSendSeconds' | 'undoSendOnQuit'>
  /** Saves the draft locally, as sending does first. */
  save(draft: Draft): Promise<Draft>
  /** A server save of this draft already under way, if any. */
  syncing(draftId: string): Promise<unknown> | undefined
  /** The draft as saved now; `locked` when it is protected and the vault is locked. */
  draft(id: string): Draft | 'locked' | undefined
  /** Today's send, unchanged. */
  send(draft: Draft): Promise<SendResult>
  /**
   * The send journal shows this draft's send already began, or (with `since`) was attempted at or
   * after then: it must never start again. The journal tells the user what became of it.
   */
  started(draftId: string, since?: string): boolean
  /** A held send nobody waits on (after a relaunch) didn't leave: says why on the draft. */
  notSent(draftId: string, message: string): Promise<void>
  connecting(accountId: string): boolean
  /** Saves the draft to the server's Drafts folder. */
  keep(draft: Draft): Promise<unknown>
  emit(sends: HeldSend[]): void
  /** Fixed event names only: never content, subjects or addresses. */
  log(event: string): void
}
export interface UndoSendClock {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
const realClock: UndoSendClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** What is stored per pending send. The draft itself stays in Drafts, its only copy. */
type HeldRecord = HeldSend & {
  /** The draft's version when Send was pressed: any other version is not sent. */
  updatedAt: string
  /** When the countdown ended (or a quit cut it short) and the send was handed over. */
  releasedAt?: string
}
type Held = HeldRecord & {
  timer?: unknown
  /** Quitting with "Send it anyway": settles once this send has been handed over or dropped. */
  leaving?: Promise<void>
  left?: () => void
  /** Set for a send someone is waiting on; a send resumed after a relaunch has none. */
  settle?: (result: SendResult | NotSentResult) => void
  fail?: (error: unknown) => void
}

/**
 * Undo send: holds each sent email in the main process until its countdown ends, then hands it
 * to the normal send. Undo and the deadline both act on the held record's state synchronously, so
 * exactly one wins. A record is `sending` on disk before anything can leave, and the send journal
 * is checked too, so a relaunch never sends twice.
 */
export class UndoSend {
  private held = new Map<string, Held>()
  /** Sends handed over, holds being prepared and drafts kept at quit: quitting waits for them. */
  private runs = new Set<Promise<void>>()
  /** Holds still saving their draft. Undo meanwhile cancels the hold. */
  private preparing = new Map<string, { cancelled: boolean; done: Promise<void> }>()
  private quitting = false
  private disposed = false
  // Writes of the pending sends, in order: one that failed is written again until one lands, so
  // an Undo whose write failed is never left on disk to be sent by the next launch.
  private writes = 0
  private written = 0
  private failed = 0
  private retry?: ReturnType<typeof setTimeout>
  constructor(
    private store: UndoSendStore,
    private host: UndoSendHost,
    private clock: UndoSendClock = realClock,
  ) {}

  /** Picks up pending sends left by a quit or a kill, following the quit setting. */
  async init() {
    const records = await this.store.read<HeldRecord[]>(undoSendKey, [])
    const keep = undoSendOnQuit(this.host.settings()) === 'draft'
    const due: Held[] = []
    for (const record of records) {
      // Attempted before the app stopped: the send journal recovers it and says what became of
      // it. Never send it again. A record marked `sending` with no attempt on record never got
      // as far as the journal, so nothing left: it follows the setting like a waiting one.
      if (this.host.started(record.draftId, record.releasedAt ?? record.dueAt)) {
        this.host.log('undo-send-started-before-restart')
        continue
      }
      if (keep) {
        // Its countdown had ended, so the bar said "Sending…": the draft says it wasn't sent.
        // Noted first, so the server save below keeps the note.
        const noted = record.releasedAt
          ? this.host
              .notSent(record.draftId, notSent.closed)
              .catch(() => this.host.log('undo-send-save-failed'))
          : Promise.resolve()
        // In the background: a quit soon after launch doesn't wait for a connection for it.
        void noted.then(() => this.keepDraft(record.draftId, record.accountId, record.updatedAt))
        continue
      }
      const held: Held = { ...record, state: 'waiting' }
      this.held.set(held.draftId, held)
      if (record.state === 'sending' || Date.parse(held.dueAt) <= this.clock.now()) due.push(held)
      else this.arm(held)
    }
    for (const held of due) this.release(held)
    if (records.length) await this.persist().catch(() => this.host.log('undo-send-save-failed'))
    this.publish()
  }

  heldSends(): HeldSend[] {
    return [...this.held.values()]
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .map(({ draftId, accountId, subject, dueAt, state }) => ({
        draftId,
        accountId,
        subject,
        dueAt,
        state,
      }))
  }
  /** The draft belongs to a held send: background draft saves leave it alone. */
  holds(draftId: string) {
    return this.held.has(draftId) || this.preparing.has(draftId)
  }

  /** Sends `input` once the countdown ends, or at once when Undo send is off. */
  async hold(input: Draft): Promise<SendResult | NotSentResult> {
    const seconds = undoSendSeconds(this.host.settings())
    // Off, or already sent or sending: today's send decides, exactly as before.
    if (!seconds || this.host.started(input.id)) return this.host.send(input)
    if (this.held.get(input.id)?.state === 'sending' || this.preparing.has(input.id))
      throw new Error('This message is already sending.')
    // A countdown for this draft is replaced at once, so an Undo meanwhile acts on the new one.
    const previous = this.held.get(input.id)
    if (previous) this.drop(previous, { status: 'undone', message: notSent.replaced })
    let prepared!: () => void
    const token = { cancelled: false, done: new Promise<void>((resolve) => (prepared = resolve)) }
    this.preparing.set(input.id, token)
    // Counted while it saves, so a quit right after Send waits for it.
    this.track(token.done)
    let outcome: { result: Promise<SendResult | NotSentResult> }
    try {
      outcome = await this.prepare(input, seconds, token)
    } finally {
      this.preparing.delete(input.id)
      prepared()
    }
    return outcome.result
  }
  private async prepare(
    input: Draft,
    seconds: number,
    token: { cancelled: boolean; done: Promise<void> },
  ): Promise<{ result: Promise<SendResult | NotSentResult> }> {
    const undone = { status: 'undone' as const, message: notSent.undone }
    // Read before anything waits: a server save running now ends by storing the draft as it had
    // it, so the held copy is saved over it once it ends (see below).
    const syncing = this.host.syncing(input.id)
    let draft: Draft
    try {
      draft = await this.host.save(input)
    } catch (error) {
      // A countdown this one replaced is gone from disk too.
      await this.persist().catch(() => this.host.log('undo-send-save-failed'))
      this.publish()
      throw error
    }
    if (token.cancelled) {
      await this.persist().catch(() => this.host.log('undo-send-save-failed'))
      this.publish()
      return { result: Promise.resolve(undone) }
    }
    if (this.quitting && undoSendOnQuit(this.host.settings()) === 'draft')
      return { result: this.whileQuitting(draft, token.done) }
    const held: Held = {
      draftId: draft.id,
      accountId: draft.accountId,
      subject: draft.subject,
      updatedAt: draft.updatedAt,
      dueAt: new Date(this.clock.now() + seconds * 1000).toISOString(),
      state: 'waiting',
    }
    const result = new Promise<SendResult | NotSentResult>((resolve, reject) => {
      held.settle = resolve
      held.fail = reject
    })
    this.held.set(draft.id, held)
    try {
      // Durable before the countdown starts, so a kill during it is followed on relaunch.
      await this.persist()
    } catch (error) {
      if (this.held.get(draft.id) === held) {
        this.held.delete(draft.id)
        this.publish()
      }
      throw error
    }
    // Undone, or already sent or kept by a quit, while it was being recorded.
    if (this.held.get(draft.id) !== held || held.state !== 'waiting' || this.disposed)
      return { result }
    this.arm(held)
    this.publish()
    // Sent at its deadline after all, with the window already gone: the quit waits for it.
    if (this.quitting) this.awaitLeaving(held)
    // A server save that began before Send ends by storing the draft as it had it: the held
    // copy is saved again over it, so the email that leaves is the one Send was pressed on.
    if (syncing)
      this.track(
        syncing.then(async () => {
          if (this.held.get(draft.id) === held && held.state === 'waiting')
            await this.host.save(draft).catch(() => this.host.log('undo-send-save-failed'))
        }),
      )
    return { result }
  }
  /** "Keep it as a draft": a Send that arrives once quitting has begun is kept straight away. */
  private whileQuitting(
    draft: Draft,
    prepared: Promise<void>,
  ): Promise<SendResult | NotSentResult> {
    // Once this Send no longer holds the draft, or the server save would leave it alone.
    this.track(prepared.then(() => this.keepDraft(draft.id)))
    return Promise.resolve({ status: 'unsent', message: notSent.kept })
  }

  /** Takes back a send still counting down. Too late once it has gone to sending. */
  async undo(draftId: string): Promise<UndoSendResult> {
    const held = this.held.get(draftId)
    const preparing = this.preparing.get(draftId)
    if (!held && preparing) {
      // Still saving: it never starts. The draft is returned once the save has landed.
      preparing.cancelled = true
      await preparing.done
      return this.undone(draftId)
    }
    if (!held) return { undone: false, reason: 'gone' }
    if (held.state !== 'waiting') return { undone: false, reason: 'sending' }
    // Synchronous, before any wait: the deadline can no longer send it.
    this.drop(held, { status: 'undone', message: notSent.undone })
    this.publish()
    await this.persist().catch(() => this.host.log('undo-send-save-failed'))
    return this.undone(draftId)
  }
  private undone(draftId: string): UndoSendResult {
    const draft = this.host.draft(draftId)
    return {
      undone: true,
      draft: draft === 'locked' || draft?.status === 'sent' ? undefined : draft,
    }
  }

  /**
   * Follows "If you close the app during the countdown". Settles once every pending send has
   * been sent (or kept as a draft, saved to the server). Undefined when nothing is pending.
   */
  onQuit(): Promise<void> | undefined {
    if (!this.held.size && !this.runs.size && !this.dirty) return undefined
    this.quitting = true
    const waiting = [...this.held.values()].filter((h) => h.state === 'waiting')
    if (undoSendOnQuit(this.host.settings()) === 'draft') {
      for (const held of waiting) {
        this.drop(held, { status: 'unsent', message: notSent.kept })
        this.track(this.keepDraft(held.draftId))
      }
      this.track(this.persist().catch(() => this.host.log('undo-send-save-failed')))
      this.publish()
    } else
      // Khyati's call (2026-11-08): each email still waits out its own countdown, out of sight,
      // then goes through the normal send. Undo is out of reach meanwhile.
      for (const held of waiting) this.awaitLeaving(held)
    // A write that failed earlier lands now, before the app goes.
    if (this.dirty) this.track(this.persist().catch(() => this.host.log('undo-send-save-failed')))
    const settled = (): Promise<void> =>
      this.runs.size ? Promise.allSettled([...this.runs]).then(settled) : Promise.resolve()
    return settled()
  }

  /** Stops the timers, as when the app is killed: pending records stay on disk. */
  dispose() {
    this.disposed = true
    if (this.retry) clearTimeout(this.retry)
    for (const held of this.held.values()) if (held.timer) this.clock.clearTimeout(held.timer)
  }

  /** Counts a waiting send among what quitting waits for, until it is handed over or dropped. */
  private awaitLeaving(held: Held) {
    if (held.leaving) return
    held.leaving = new Promise<void>((resolve) => (held.left = resolve))
    this.track(held.leaving)
  }
  private arm(held: Held) {
    const ms = Math.max(0, Date.parse(held.dueAt) - this.clock.now())
    held.timer = this.clock.setTimeout(() => this.release(held), ms)
  }
  private drop(held: Held, result: NotSentResult) {
    if (held.timer) this.clock.clearTimeout(held.timer)
    this.held.delete(held.draftId)
    held.settle?.(result)
    held.left?.()
  }
  private track(run: Promise<unknown>) {
    const tracked = run.then(
      () => {},
      () => {},
    )
    this.runs.add(tracked)
    void tracked.finally(() => this.runs.delete(tracked))
  }

  /** The countdown is over: from here on Undo is too late. */
  private release(held: Held) {
    if (this.held.get(held.draftId) !== held || held.state !== 'waiting') return
    held.state = 'sending'
    held.releasedAt = new Date(this.clock.now()).toISOString()
    if (held.timer) this.clock.clearTimeout(held.timer)
    this.publish()
    this.track(this.sendHeld(held))
    // After the send is counted, so a quit waiting on this one goes on to wait for the send.
    held.left?.()
  }
  private async sendHeld(held: Held) {
    let outcome: { result: SendResult | NotSentResult } | { error: unknown }
    try {
      outcome = { result: await this.sendNow(held) }
    } catch (error) {
      outcome = { error }
    }
    // Stopped before it was handed over: the record stays on disk for the next launch.
    if ('error' in outcome && outcome.error === stopped) return
    if (this.held.get(held.draftId) === held) this.held.delete(held.draftId)
    await this.persist().catch(() => this.host.log('undo-send-save-failed'))
    this.publish()
    if ('result' in outcome) {
      if (held.settle) held.settle(outcome.result)
      else if (outcome.result.status === 'unsent')
        // Nobody is waiting for this one (it resumed after a relaunch): the draft says why.
        await this.host
          .notSent(held.draftId, outcome.result.message)
          .catch(() => this.host.log('undo-send-save-failed'))
    } else if (held.fail) held.fail(outcome.error)
    // Today's send has already noted the failure on the draft.
    else this.host.log('undo-send-resumed-failed')
  }
  private async sendNow(held: Held): Promise<SendResult | NotSentResult> {
    // `sending` is durable before anything can leave. Should this write fail, the send
    // journal, written before submission, still stops a relaunch from sending again.
    await this.persist().catch(() => this.host.log('undo-send-save-failed'))
    await this.connected(held.accountId)
    if (this.disposed) throw stopped
    // Read only now, after any wait, and handed to sending in the same step.
    const draft = this.host.draft(held.draftId)
    if (draft === 'locked') return { status: 'unsent', message: notSent.locked }
    if (!draft || draft.status === 'sent') return { status: 'unsent', message: notSent.deleted }
    if (draft.updatedAt !== held.updatedAt) return { status: 'unsent', message: notSent.edited }
    return this.host.send(draft)
  }
  /** Saves a draft kept by the quit setting to the server, once its account is connected. */
  private async keepDraft(draftId: string, accountId?: string, updatedAt?: string) {
    if (accountId) await this.connected(accountId)
    const draft = this.host.draft(draftId)
    if (!draft || draft === 'locked' || draft.status === 'sent') return
    if (updatedAt && draft.updatedAt !== updatedAt) return
    await this.host.keep(draft).catch(() => this.host.log('undo-send-keep-failed'))
  }
  /** Waits (for a while) for an account still connecting after a relaunch. */
  private async connected(accountId: string) {
    const until = Date.now() + connectWaitMs
    while (this.host.connecting(accountId) && !this.disposed && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, connectPollMs))
  }
  private persist() {
    const records: HeldRecord[] = [...this.held.values()].map(
      ({ draftId, accountId, subject, updatedAt, dueAt, state, releasedAt }) => ({
        draftId,
        accountId,
        subject,
        updatedAt,
        dueAt,
        state,
        ...(releasedAt && { releasedAt }),
      }),
    )
    const write = this.store.write(undoSendKey, records)
    const sequence = ++this.writes
    write.then(
      () => (this.written = Math.max(this.written, sequence)),
      () => {
        this.failed = Math.max(this.failed, sequence)
        this.retryWrite()
      },
    )
    return write
  }
  /** The last write that failed came after the last one that landed. */
  private get dirty() {
    return this.failed > this.written
  }
  private retryWrite() {
    if (this.retry || this.disposed) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      if (this.dirty && !this.disposed)
        void this.persist().catch(() => this.host.log('undo-send-save-failed'))
    }, retryWriteMs)
  }
  private publish() {
    this.host.emit(this.heldSends())
  }
}
