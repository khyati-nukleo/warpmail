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

const notSent = {
  undone: 'Not sent.',
  replaced: 'Not sent. You pressed Send on it again.',
  edited: 'You changed this email after pressing Send, so it wasn’t sent. It’s in Drafts.',
  deleted: 'This email was deleted before it was sent, so nothing was sent.',
  locked: 'Unlock the encryption vault, then send this email again. It’s in Drafts.',
  kept: 'Not sent. It’s in Drafts.',
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
  /** The draft as saved now; `locked` when it is protected and the vault is locked. */
  draft(id: string): Draft | 'locked' | undefined
  /** Today's send, unchanged. */
  send(draft: Draft): Promise<SendResult>
  /** The send journal shows this draft's send already began: it must never start again. */
  started(draftId: string): boolean
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
}
type Held = HeldRecord & {
  timer?: unknown
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
  /** Sends handed over and drafts being saved at quit, so quitting can wait for them. */
  private runs = new Set<Promise<void>>()
  private quitting = false
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
      // Started before the app stopped: the send journal recovers it. Never send it again.
      if (record.state === 'sending' || this.host.started(record.draftId)) {
        this.host.log('undo-send-started-before-restart')
        continue
      }
      if (keep) {
        this.track(this.keepDraft(record.draftId, record.accountId, record.updatedAt))
        continue
      }
      const held: Held = { ...record }
      this.held.set(held.draftId, held)
      if (Date.parse(held.dueAt) <= this.clock.now()) due.push(held)
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

  /** Sends `input` once the countdown ends, or at once when Undo send is off. */
  async hold(input: Draft): Promise<SendResult | NotSentResult> {
    const seconds = undoSendSeconds(this.host.settings())
    // Off, quitting, or already sent or sending: today's send decides, exactly as before.
    if (!seconds || this.quitting || this.host.started(input.id)) return this.host.send(input)
    if (this.held.get(input.id)?.state === 'sending')
      throw new Error('This message is already sending.')
    const draft = await this.host.save(input)
    if (this.quitting) return this.host.send(draft)
    const previous = this.held.get(draft.id)
    if (previous?.state === 'sending') throw new Error('This message is already sending.')
    if (previous) this.drop(previous, { status: 'undone', message: notSent.replaced })
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
    // Undone or replaced while it was being recorded.
    if (this.held.get(draft.id) !== held) return result
    this.arm(held)
    this.publish()
    return result
  }

  /** Takes back a send still counting down. Too late once it has gone to sending. */
  async undo(draftId: string): Promise<UndoSendResult> {
    const held = this.held.get(draftId)
    if (!held) return { undone: false, reason: 'gone' }
    if (held.state !== 'waiting') return { undone: false, reason: 'sending' }
    // Synchronous, before any wait: the deadline can no longer send it.
    this.drop(held, { status: 'undone', message: notSent.undone })
    this.publish()
    await this.persist().catch(() => this.host.log('undo-send-save-failed'))
    const draft = this.host.draft(draftId)
    return { undone: true, draft: draft === 'locked' ? undefined : draft }
  }

  /**
   * Follows "If you close the app during the countdown". Settles once every pending send has
   * been sent (or kept as a draft, saved to the server). Undefined when nothing is pending.
   */
  onQuit(): Promise<void> | undefined {
    if (!this.held.size && !this.runs.size) return undefined
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
      // Nobody can press Undo without a window: waiting longer would only delay quitting.
      for (const held of waiting) this.release(held)
    const settled = (): Promise<void> =>
      this.runs.size ? Promise.allSettled([...this.runs]).then(settled) : Promise.resolve()
    return settled()
  }

  /** Stops the timers, as when the app is killed: pending records stay on disk. */
  dispose() {
    for (const held of this.held.values()) if (held.timer) this.clock.clearTimeout(held.timer)
  }

  private arm(held: Held) {
    const ms = Math.max(0, Date.parse(held.dueAt) - this.clock.now())
    held.timer = this.clock.setTimeout(() => this.release(held), ms)
  }
  private drop(held: Held, result: NotSentResult) {
    if (held.timer) this.clock.clearTimeout(held.timer)
    this.held.delete(held.draftId)
    held.settle?.(result)
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
    if (held.timer) this.clock.clearTimeout(held.timer)
    this.publish()
    this.track(this.sendHeld(held))
  }
  private async sendHeld(held: Held) {
    let outcome: { result: SendResult | NotSentResult } | { error: unknown }
    try {
      outcome = { result: await this.sendNow(held) }
    } catch (error) {
      outcome = { error }
    }
    if (this.held.get(held.draftId) === held) this.held.delete(held.draftId)
    await this.persist().catch(() => this.host.log('undo-send-save-failed'))
    this.publish()
    if ('result' in outcome) held.settle?.(outcome.result)
    else if (held.fail) held.fail(outcome.error)
    else this.host.log('undo-send-resumed-failed')
  }
  private async sendNow(held: Held): Promise<SendResult | NotSentResult> {
    // `sending` is durable before anything can leave. Should this write fail, the send
    // journal, written before submission, still stops a relaunch from sending again.
    await this.persist().catch(() => this.host.log('undo-send-save-failed'))
    const draft = this.host.draft(held.draftId)
    if (draft === 'locked') return { status: 'unsent', message: notSent.locked }
    if (!draft || draft.status === 'sent') return { status: 'unsent', message: notSent.deleted }
    if (draft.updatedAt !== held.updatedAt) return { status: 'unsent', message: notSent.edited }
    await this.connected(draft.accountId)
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
    while (this.host.connecting(accountId) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, connectPollMs))
  }
  private persist() {
    const records: HeldRecord[] = [...this.held.values()].map(
      ({ draftId, accountId, subject, updatedAt, dueAt, state }) => ({
        draftId,
        accountId,
        subject,
        updatedAt,
        dueAt,
        state,
      }),
    )
    return this.store.write(undoSendKey, records)
  }
  private publish() {
    this.host.emit(this.heldSends())
  }
}
