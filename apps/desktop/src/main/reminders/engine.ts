import {
  connectionErrorCodes,
  deriveReminder,
  followUpAsk,
  isProviderError,
  ownAddresses,
  ProviderError,
  reminderLookbackDays,
  reminderSettingsOf,
  resolveSplitScope,
  type Account,
  type AppEvent,
  type MailProvider,
  type Message,
  type Reminder,
  type ReminderLabel,
  type ReminderTarget,
  type Settings,
  type SplitScope,
} from '@inlark/core'
import { mainAskCheck } from './own-text'

export interface ReminderEngineDeps {
  accounts(): Account[]
  settings(): Settings
  provider(accountId: string): MailProvider | undefined
  /**
   * Moves these threads' archived mail back to the inbox, with one undo for all of them.
   * `moved` lists the threads with mail moved, even partly; ones with nothing moved are left out.
   */
  returnToInbox(targets: ReturnTarget[]): Promise<{ moved: ReturnTarget[]; undoId?: string }>
  emit(event: AppEvent): void
  store: {
    read<T>(key: string, fallback: T): Promise<T>
    write(key: string, value: unknown): Promise<void>
  }
  now?: () => number
  /** Event names only: never subjects, addresses or ids. */
  log?: (event: string) => void
}

export type ReturnTarget = { accountId: string; threadId: string }
export interface SentInput {
  accountId: string
  /** The Sent copy's Message-ID, without angle brackets. */
  messageId: string
  sentCopy?: string
  /** The composer's follow-up switch, when it showed one. */
  followUp?: boolean
  html: string
  text: string
}
/**
 * `ask`: a follow-up's ask, which a later note of mine that asks nothing doesn't change, and
 * whether its Returned label stops a return: it does unless a snooze set the due time since.
 */
type Derived = {
  reminder: Reminder
  inInbox: boolean
  /** Has mail in the archive folder; without any, a return has nothing to move. */
  archived: boolean
  ask?: { messageId: string; returned: boolean; skip: boolean }
}[]
type Waiting = ReturnTarget & { key: string; ask?: { messageId: string; returned: boolean } }
type Target = { account: Account; provider: MailProvider }

const debounceMs = 500
/** A steady stream of changes still recomputes this often. */
const debounceMaxMs = 5000
/** The wake-up timer never waits longer, so a sleeping laptop or a clock change catches up. */
const maxWaitMs = 60 * 60_000
const scanLimit = 25
const returnedKey = 'reminders-returned'
const returnedLimit = 500
/**
 * A return that moved nothing (the archive folder held none of it, or the move failed) is tried
 * again this long after, once a full sync has run since: not on every change.
 */
const retryMs = 10 * 60_000
const dayMs = 86_400_000
/** How long a switch label waits for its Sent copy to be indexed. */
const labelWaitMs = 10 * 60_000
/** Tries while offline before giving up; tries before the copy is indexed are local and free. */
const labelOfflineTries = 5
const labelsWaitingLimit = 100

const background = { background: true }
const offline = (error: unknown) =>
  error instanceof ProviderError && connectionErrorCodes.includes(error.code)

/**
 * Works out each IMAP account's reminders from its local index, keeps them current, checks
 * recent Sent mail for asks in the background, and returns archived due follow-ups to the inbox.
 */
export class ReminderEngine {
  /** All reminders per account, due or not; `due` filters by the clock when asked. */
  private cache = new Map<string, Promise<Derived>>()
  private pending = new Set<string>()
  private pendingAll = false
  private debounce?: ReturnType<typeof setTimeout>
  private debounceMax?: ReturnType<typeof setTimeout>
  private wake?: ReturnType<typeof setTimeout>
  private wakeAt = 0
  /**
   * Sent mail read by the scan this session, per account, checked or not: never read twice.
   * One whose body couldn't be read stays unchecked in the index, so a later session retries it.
   */
  private scanned = new Map<string, Set<string>>()
  private scanning = new Set<string>()
  /** Recomputes run one at a time, so a follow-up is never returned twice. */
  private queue: Promise<void> = Promise.resolve()
  private started = false
  private disposed = false
  /** Switch labels whose Sent copy wasn't indexed yet; tried again as each sync lands. */
  private labelsWaiting: {
    accountId: string
    label: ReminderLabel
    messageId: string
    until: number
    offline: number
    syncAsked?: boolean
  }[] = []
  private labelling = new Set<string>()
  /** Returns that moved nothing, by key, with when they were tried. */
  private unmoved = new Map<string, number>()

  constructor(private deps: ReminderEngineDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now()
  }
  private log(event: string) {
    this.deps.log?.(event)
  }
  private imapIds() {
    return this.deps
      .accounts()
      .filter((a) => a.protocol === 'imap')
      .map((a) => a.id)
  }
  private target(accountId: string): Target | undefined {
    if (!reminderSettingsOf(this.deps.settings()).enabled) return undefined
    const account = this.deps.accounts().find((a) => a.id === accountId && a.protocol === 'imap')
    const provider = account && this.deps.provider(accountId)
    return account && provider?.reminderFacts ? { account, provider } : undefined
  }

  async due(accountId: string): Promise<Reminder[]> {
    const derived = await this.derived(accountId)
    const now = this.now()
    return derived.filter((d) => d.reminder.dueMs <= now).map((d) => d.reminder)
  }

  invalidate(accountId?: string): void {
    if (accountId) {
      this.cache.delete(accountId)
      this.pending.add(accountId)
    } else {
      this.cache.clear()
      this.pendingAll = true
    }
    if (!this.started || this.disposed) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.flush(), debounceMs)
    this.debounceMax ??= setTimeout(() => this.flush(), debounceMaxMs)
  }

  /**
   * After a send: stores the main-process ask-check of the sent body, the same check the
   * other laptop runs on the Sent copy, and saves the follow-up switch as a label only when
   * it differs from that guess. Never throws.
   */
  async afterSend(input: SentInput): Promise<void> {
    // Nothing runs inside the send flow's own steps.
    await Promise.resolve()
    try {
      if (input.sentCopy !== 'filed' && input.sentCopy !== 'server') return
      const target = this.target(input.accountId)
      if (!target || !reminderSettingsOf(this.deps.settings()).followUp) return
      const { account, provider } = target
      const guess = mainAskCheck({ html: input.html, text: input.text })
      await provider.setAskChecks?.(account, [{ messageId: input.messageId, asks: guess }])
      this.invalidate(account.id)
      if (input.followUp === undefined || input.followUp === guess) return
      this.labelsWaiting.push({
        accountId: account.id,
        label: input.followUp ? 'followUp' : 'noReminder',
        messageId: input.messageId,
        until: this.now() + labelWaitMs,
        offline: 0,
      })
      this.labelsWaiting = this.labelsWaiting.slice(-labelsWaitingLimit)
      await this.saveLabels(account.id)
    } catch {
      this.log('reminders-after-send-failed')
    }
  }

  /** Writes the waiting switch labels; one whose email isn't indexed yet waits for a sync. */
  private async saveLabels(accountId: string) {
    if (this.labelling.has(accountId)) return
    this.labelling.add(accountId)
    const drop = (waiting: (typeof this.labelsWaiting)[number]) =>
      (this.labelsWaiting = this.labelsWaiting.filter((w) => w !== waiting))
    try {
      for (const waiting of this.labelsWaiting.filter((w) => w.accountId === accountId)) {
        const target = this.target(accountId)
        if (!target?.provider.labelMessage) return this.dropLabels(accountId)
        if (this.now() > waiting.until) {
          drop(waiting)
          this.log('reminders-label-expired')
          continue
        }
        try {
          // Skips service.guard on purpose: a background retry never marks the account offline.
          await target.provider.labelMessage(target.account, waiting.label, waiting.messageId, true)
          drop(waiting)
          this.invalidate(accountId)
        } catch (error) {
          this.log('reminders-label-failed')
          if (isProviderError(error, 'notFound')) {
            // Once: each sync announces a change, which retries this again.
            if (!waiting.syncAsked) target.provider.requestSync?.('all')
            waiting.syncAsked = true
          } else if (!offline(error) || ++waiting.offline >= labelOfflineTries) drop(waiting)
        }
      }
    } finally {
      this.labelling.delete(accountId)
    }
  }

  private dropLabels(accountId: string) {
    this.labelsWaiting = this.labelsWaiting.filter((w) => w.accountId !== accountId)
  }

  /** Hides a reminder on every device: a `No reminder` label on its email. */
  dismiss(target: ReminderTarget): Promise<void> {
    return this.noReminder(target, true)
  }
  /** Undoes `dismiss`. */
  restore(target: ReminderTarget): Promise<void> {
    return this.noReminder(target, false)
  }
  private async noReminder({ accountId, messageId }: ReminderTarget, add: boolean) {
    const account = this.deps.accounts().find((a) => a.id === accountId && a.protocol === 'imap')
    const provider = account && this.deps.provider(accountId)
    if (!account || !provider?.labelMessage)
      throw new ProviderError('unsupported', 'Reminders work with IMAP accounts only.')
    await provider.labelMessage(account, 'noReminder', messageId, add)
    this.invalidate(accountId)
  }

  /** Catches up on launch: reminders that came due while the app was closed. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.invalidate()
  }

  dispose(): void {
    this.disposed = true
    if (this.debounce) clearTimeout(this.debounce)
    if (this.debounceMax) clearTimeout(this.debounceMax)
    if (this.wake) clearTimeout(this.wake)
  }

  private derived(accountId: string): Promise<Derived> {
    const target = this.target(accountId)
    if (!target) return Promise.resolve([])
    let run = this.cache.get(accountId)
    if (!run) {
      const started = this.derive(target)
      run = started
      this.cache.set(accountId, started)
      // A failed read is not kept, so the next ask tries again.
      started.catch(() => {
        if (this.cache.get(accountId) === started) this.cache.delete(accountId)
      })
    }
    return run.catch(() => {
      this.log('reminders-failed')
      return []
    })
  }

  private async derive({ account, provider }: Target): Promise<Derived> {
    const all = this.deps.settings()
    const settings = reminderSettingsOf(all)
    // Lowercase, as deriveReminder compares them.
    const own = ownAddresses(this.deps.accounts())
    const important = resolveSplitScope('important', all, own) as Extract<
      SplitScope,
      { kind: 'important' }
    >
    const snoozes = (all.reminderSnoozes ?? []).filter((s) => s.accountId === account.id)
    const facts = await provider.reminderFacts!(account, {
      important,
      sinceMs: this.now() - reminderLookbackDays * dayMs,
      own,
      // A snoozed thread stays listed however old it gets.
      ...(snoozes.length ? { threadIds: [...new Set(snoozes.map((s) => s.threadId))] } : {}),
    })
    return facts.flatMap((f) => {
      const snooze = snoozes.find((s) => s.threadId === f.threadId && s.messageId === f.messageId)
      const reminder = deriveReminder(f, { own, settings, snooze })
      if (!reminder) return []
      const found = reminder.kind === 'followUp' ? followUpAsk(f) : null
      const archived = f.archived !== false
      if (!found) return [{ reminder, inInbox: f.inInbox, archived }]
      // The label is shared and the snooze is not: a snooze that ends may bring it back again.
      const snoozed =
        !!snooze && reminder.dueMs > (deriveReminder(f, { own, settings })?.dueMs ?? 0)
      const ask = { ...found, skip: found.returned && !snoozed }
      return [{ reminder, inInbox: f.inInbox, archived, ask }]
    })
  }

  private flush() {
    if (this.debounce) clearTimeout(this.debounce)
    if (this.debounceMax) clearTimeout(this.debounceMax)
    this.debounce = this.debounceMax = undefined
    const ids = this.pendingAll ? this.imapIds() : [...this.pending]
    this.pending.clear()
    this.pendingAll = false
    this.queue = this.queue
      .then(() => this.recompute(ids))
      .catch(() => this.log('reminders-failed'))
  }

  private async recompute(ids: string[]) {
    const waiting: Waiting[] = []
    const now = this.now()
    for (const id of ids) {
      if (this.disposed) return
      const target = this.target(id)
      if (!target) {
        this.dropLabels(id)
        continue
      }
      if (this.labelsWaiting.some((w) => w.accountId === id)) await this.saveLabels(id)
      const derived = await this.derived(id)
      // In the background: the inbox never waits for bodies to be read.
      if (reminderSettingsOf(this.deps.settings()).followUp) void this.scan(target)
      // Showing reminders from a stale index is fine; moving mail on it is not. One waits for a
      // full sync that started after it came due, which announces itself and recomputes.
      let held = false
      // One with nothing in the archive folder (only in Sent, say) is tried once its facts change.
      for (const { reminder, inInbox, archived, ask } of derived) {
        if (reminder.kind !== 'followUp' || inInbox || !archived) continue
        if (reminder.dueMs > now || ask?.skip) continue
        if (target.provider.readyForReminders?.(reminder.dueMs) === false) {
          held = true
          continue
        }
        // Once per ask and due time: a snooze that ends later may bring it back again.
        const askId = ask?.messageId ?? reminder.messageId
        const key = [id, reminder.threadId, askId, reminder.dueMs].join('|')
        const tried = this.unmoved.get(key)
        if (
          tried !== undefined &&
          (now < tried + retryMs || target.provider.readyForReminders?.(tried + 1) === false)
        )
          continue
        waiting.push({ accountId: id, threadId: reminder.threadId, key, ask })
      }
      if (held) target.provider.awaitFullSync?.()
    }
    if (waiting.length && !this.disposed) await this.returnDue(waiting)
    await this.arm()
  }

  /** Wakes at the next reminder to come due, at most an hour away. */
  private async arm() {
    const now = this.now()
    let next = Infinity
    for (const id of this.imapIds())
      for (const { reminder } of await this.derived(id))
        if (reminder.dueMs > now) next = Math.min(next, reminder.dueMs)
    for (const tried of this.unmoved.values())
      if (tried + retryMs > now) next = Math.min(next, tried + retryMs)
    if (this.wake) clearTimeout(this.wake)
    this.wake = undefined
    if (this.disposed || next === Infinity) return
    this.wakeAt = next
    this.wake = setTimeout(() => this.woke(), Math.min(next - now, maxWaitMs))
  }

  private woke() {
    this.wake = undefined
    if (this.disposed) return
    if (this.now() < this.wakeAt) {
      void this.arm().catch(() => this.log('reminders-failed'))
      return
    }
    this.invalidate()
    this.deps.emit({ type: 'changed' })
  }

  /** Ask-checks recent Sent mail that has none, such as mail sent from another computer. */
  private async scan({ account, provider }: Target) {
    if (!provider.askChecksNeeded || !provider.setAskChecks || this.scanning.has(account.id)) return
    this.scanning.add(account.id)
    try {
      let scanned = this.scanned.get(account.id)
      if (!scanned) this.scanned.set(account.id, (scanned = new Set()))
      const since = this.now() - reminderLookbackDays * dayMs
      // Mail read before but still listed (unreadable, or a check that didn't store) comes
      // back first, so ask for that many more.
      const rows = (await provider.askChecksNeeded(account, since, scanLimit + scanned.size))
        .filter((r) => !scanned.has(r.id))
        .slice(0, scanLimit)
      if (!rows.length) return
      const read = await this.bodies(
        { account, provider },
        rows.map((r) => r.id),
      )
      const checks: { messageId: string; asks: boolean }[] = []
      for (const row of rows) {
        scanned.add(row.id)
        const message = read.get(row.id)
        if (message && (message.html !== undefined || message.text !== undefined))
          checks.push({ messageId: row.messageId, asks: mainAskCheck(message) })
      }
      if (!checks.length) return
      await provider.setAskChecks(account, checks)
      // Recompute, which also checks the next batch; it ends once every row was read.
      this.invalidate(account.id)
      if (checks.some((c) => c.asks)) this.deps.emit({ type: 'changed', accountId: account.id })
    } catch {
      this.log('reminders-scan-failed')
    } finally {
      this.scanning.delete(account.id)
    }
  }

  /**
   * Bodies by id, read behind the user's own work. One unreadable email doesn't fail the
   * others; being offline stops the scan.
   */
  private async bodies({ account, provider }: Target, ids: string[]) {
    const read = new Map<string, Message>()
    try {
      for (const m of await provider.messages(account, ids, true, background)) read.set(m.id, m)
      return read
    } catch (error) {
      if (offline(error) || ids.length === 1) throw error
    }
    for (const id of ids)
      try {
        for (const m of await provider.messages(account, [id], true, background)) read.set(m.id, m)
      } catch (error) {
        if (offline(error)) throw error
      }
    return read
  }

  /**
   * Brings archived due follow-ups back to the inbox in one move, once per ask: kept here, and
   * as a Returned label on the ask in Gmail, which the other laptop reads.
   */
  private async returnDue(waiting: Waiting[]) {
    const stored = await this.deps.store.read<unknown>(returnedKey, [])
    const keys = Array.isArray(stored)
      ? stored.filter((k): k is string => typeof k === 'string')
      : []
    const known = new Set(keys)
    const due = waiting.filter((w) => !known.has(w.key))
    if (!due.length) return
    let result: Awaited<ReturnType<ReminderEngineDeps['returnToInbox']>>
    try {
      result = await this.deps.returnToInbox(
        due.map(({ accountId, threadId }) => ({ accountId, threadId })),
      )
    } catch {
      result = { moved: [] }
    }
    const moved = new Set(result.moved.map((t) => t.accountId + '|' + t.threadId + '|'))
    const done = due.filter((w) => moved.has(w.accountId + '|' + w.threadId + '|'))
    // Still due: tried again later, and never marked handled, here or in Gmail.
    for (const w of due) {
      this.unmoved.delete(w.key)
      if (!done.includes(w)) this.unmoved.set(w.key, this.now())
    }
    while (this.unmoved.size > returnedLimit) this.unmoved.delete(this.unmoved.keys().next().value!)
    if (done.length < due.length) this.log('reminders-return-failed')
    if (done.length)
      await this.deps.store.write(
        returnedKey,
        [...keys, ...done.map((w) => w.key)].slice(-returnedLimit),
      )
    // After the move: a label without it would stop the return on both laptops.
    for (const { accountId, ask } of done)
      if (ask && !ask.returned)
        this.labelsWaiting.push({
          accountId,
          label: 'returned',
          messageId: ask.messageId,
          until: this.now() + labelWaitMs,
          offline: 0,
        })
    this.labelsWaiting = this.labelsWaiting.slice(-labelsWaitingLimit)
    for (const accountId of new Set(done.map((w) => w.accountId))) await this.saveLabels(accountId)
    if (done.length)
      this.deps.emit({
        type: 'remindersReturned',
        count: done.length,
        ...(result.undoId ? { undoId: result.undoId } : {}),
      })
  }
}
