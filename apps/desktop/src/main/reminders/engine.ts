import {
  connectionErrorCodes,
  deriveReminder,
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
  type Settings,
  type SplitScope,
} from '@inlark/core'
import { mainAskCheck } from './own-text'

export interface ReminderEngineDeps {
  accounts(): Account[]
  settings(): Settings
  provider(accountId: string): MailProvider | undefined
  /** Moves the thread's archived mail back to the inbox; the undo id when anything moved. */
  returnToInbox(accountId: string, threadId: string): Promise<string | undefined>
  emit(event: AppEvent): void
  store: {
    read<T>(key: string, fallback: T): Promise<T>
    write(key: string, value: unknown): Promise<void>
  }
  now?: () => number
  /** Event names only: never subjects, addresses or ids. */
  log?: (event: string) => void
}

type Derived = { reminder: Reminder; inInbox: boolean }[]
type Target = { account: Account; provider: MailProvider }

const debounceMs = 500
/** The wake-up timer never waits longer, so a sleeping laptop or a clock change catches up. */
const maxWaitMs = 60 * 60_000
const scanLimit = 25
const returnedKey = 'reminders-returned'
const returnedLimit = 500
const dayMs = 86_400_000

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
  private wake?: ReturnType<typeof setTimeout>
  private wakeAt = 0
  /** Sent mail whose body couldn't be read, per account: left unchecked until next launch. */
  private skipped = new Map<string, Set<string>>()
  private scanning = new Set<string>()
  /** Recomputes run one at a time, so a follow-up is never returned twice. */
  private queue: Promise<void> = Promise.resolve()
  private started = false
  private disposed = false

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
      // A snoozed thread stays listed however old it gets.
      ...(snoozes.length ? { threadIds: [...new Set(snoozes.map((s) => s.threadId))] } : {}),
    })
    return facts.flatMap((f) => {
      const snooze = snoozes.find((s) => s.threadId === f.threadId && s.messageId === f.messageId)
      const reminder = deriveReminder(f, { own, settings, snooze })
      return reminder ? [{ reminder, inInbox: f.inInbox }] : []
    })
  }

  private flush() {
    this.debounce = undefined
    const ids = this.pendingAll ? this.imapIds() : [...this.pending]
    this.pending.clear()
    this.pendingAll = false
    this.queue = this.queue
      .then(() => this.recompute(ids))
      .catch(() => this.log('reminders-failed'))
  }

  private async recompute(ids: string[]) {
    for (const id of ids) {
      if (this.disposed) return
      const target = this.target(id)
      if (!target) continue
      const derived = await this.derived(id)
      // In the background: the inbox never waits for bodies to be read.
      void this.scan(target)
      await this.returnDue(id, derived)
    }
    await this.arm()
  }

  /** Wakes at the next reminder to come due, at most an hour away. */
  private async arm() {
    const now = this.now()
    let next = Infinity
    for (const id of this.imapIds())
      for (const { reminder } of await this.derived(id))
        if (reminder.dueMs > now) next = Math.min(next, reminder.dueMs)
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
      let skipped = this.skipped.get(account.id)
      if (!skipped) this.skipped.set(account.id, (skipped = new Set()))
      const since = this.now() - reminderLookbackDays * dayMs
      const rows = (await provider.askChecksNeeded(account, since, scanLimit + skipped.size))
        .filter((r) => !skipped.has(r.id))
        .slice(0, scanLimit)
      if (!rows.length) return
      const read = await this.bodies(
        { account, provider },
        rows.map((r) => r.id),
      )
      const checks: { messageId: string; asks: boolean }[] = []
      for (const row of rows) {
        const message = read.get(row.id)
        if (!message || (message.html === undefined && message.text === undefined))
          skipped.add(row.id)
        else checks.push({ messageId: row.messageId, asks: mainAskCheck(message) })
      }
      if (!checks.length) return
      await provider.setAskChecks(account, checks)
      // Recompute, which also checks the next batch.
      this.invalidate(account.id)
      if (checks.some((c) => c.asks)) this.deps.emit({ type: 'changed', accountId: account.id })
    } catch {
      this.log('reminders-scan-failed')
    } finally {
      this.scanning.delete(account.id)
    }
  }

  /** Bodies by id. One unreadable email doesn't fail the others; being offline stops the scan. */
  private async bodies({ account, provider }: Target, ids: string[]) {
    const read = new Map<string, Message>()
    try {
      for (const m of await provider.messages(account, ids, true)) read.set(m.id, m)
      return read
    } catch (error) {
      if (offline(error) || ids.length === 1) throw error
    }
    for (const id of ids)
      try {
        for (const m of await provider.messages(account, [id], true)) read.set(m.id, m)
      } catch (error) {
        if (offline(error)) throw error
      }
    return read
  }

  /** Brings each archived due follow-up back to the inbox, once per email. */
  private async returnDue(accountId: string, derived: Derived) {
    const now = this.now()
    const waiting = derived.filter(
      (d) => d.reminder.kind === 'followUp' && !d.inInbox && d.reminder.dueMs <= now,
    )
    if (!waiting.length) return
    const stored = await this.deps.store.read<unknown>(returnedKey, [])
    let keys = Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : []
    let count = 0
    let undoId: string | undefined
    for (const { reminder } of waiting) {
      const key = [accountId, reminder.threadId, reminder.messageId].join('|')
      if (this.disposed) break
      if (keys.includes(key)) continue
      try {
        const undo = await this.deps.returnToInbox(accountId, reminder.threadId)
        keys = [...keys, key].slice(-returnedLimit)
        await this.deps.store.write(returnedKey, keys)
        if (undo) {
          count++
          undoId = undo
        }
      } catch {
        this.log('reminders-return-failed')
      }
    }
    if (count) this.deps.emit({ type: 'remindersReturned', count, ...(undoId ? { undoId } : {}) })
  }
}
