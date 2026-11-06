# Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Follow-up and forgot-to-reply reminders, worked out from the local IMAP index, that bring due conversations to the top of Inbox and its tabs, with dismiss and snooze, Gmail labels that keep two laptops in agreement, a composer switch and a Settings section.

**Architecture:** Reminder state is derived, never stored: one SQL query per account (schema v5) returns the facts of each recently active thread, and a pure core function turns facts plus settings, snoozes and the clock into "due at". A main-process engine caches the due list per account, re-derives it when the index changes or a reminder comes due, and passes it into the inbox query, where it only changes the sort key. Khyati's choices live in two Gmail label folders (`Warpmail/No reminder`, `Warpmail/Follow up`), detected by the index through folder membership; snoozes live in settings.

**Tech Stack:** TypeScript, Electron (main, preload, renderer), React 19, TanStack Query, `node:sqlite` in a worker, imapflow behind `ImapPort`, `html-to-text` (already a desktop dependency), zod, vitest.

**Spec:** [docs/superpowers/specs/2026-11-05-reminders-design.md](../specs/2026-11-05-reminders-design.md). Also read the parallel-sessions note (`docs/superpowers/briefs/2026-11-06-parallel-sessions.md`, not committed) for which shared files you may touch and how.

## Global Constraints

- Work only in `/home/khyati/me/warpmail-reminders` on `feat/reminders`. Commit; never push or merge.
- `corepack pnpm` always (never bare `pnpm`). Tests: `corepack pnpm exec vitest run <file>`. Typecheck: `corepack pnpm --filter @inlark/desktop typecheck` plus `--filter @inlark/core` / `@inlark/imap` when touched. Format: `corepack pnpm exec prettier --check <files>`.
- Baseline before any change: 778 passed, 2 failed, 7 skipped. The two failures (`tests/service.test.ts` "keeps JMAP replacement IDs through delayed saves", `tests/reader-body.test.ts` "shows plain text outside the HTML frame…") are timing/temp-dir flakes; re-run a failing test alone before suspecting your change.
- No new dependencies. No network calls beyond IMAP. Never log subjects, addresses or bodies.
- Public repo: only `example.com`/`example.org` addresses and made-up names in code, tests, fixtures, docs, commit messages.
- New logic in new files. Edits to inlark files stay small and in one block, with a one-line comment naming the feature where the parallel-sessions note asks for it (`Settings`, `Draft`, schemas, preload method list, IPC wiring, `DesktopMailAPI`).
- Ownership (parallel sessions): Reminders owns the index schema (bump to v5), Gmail labels and `Warpmail/` folders, and duplicate ranking (`provider.ts` `locationRank`). Read status owns the send flow: Reminders adds exactly one call after a send completes. Improve draft owns `Composer.tsx` layout and has `Mod+J`: Reminders mounts its switch with a line or two next to Send. Read status owns `Reader.tsx`: Reminders mounts its own component with a line or two.
- Keep inlark's look: existing type, spacing, colours, `IconButton`, `Dropdown`/`MenuItem`, `SegmentedControl`, the row's "Draft" label style. No Superhuman styling.
- Keyboard and mouse parity: every reminder action has a shortcut, a menu item and a command menu entry.
- Copy fixed by the spec: labels "No reply in 3 days" (the number follows the setting: "No reply in N days", "No reply in 1 day") and "Waiting on you"; composer "Follow-up: on (asks a question)" / "Follow-up: off"; snooze presets "Tomorrow morning", "Monday morning", "Next week", "Pick a date…"; morning = 9:00 local.
- Defaults: feature on, both kinds on, follow-up wait 3 working days, forgot-to-reply wait 1 working day. Waits are whole working days, 1 to 30.
- Label folder paths: `Warpmail/No reminder` and `Warpmail/Follow up` (joined with the account's delimiter; Gmail uses `/`).
- Shortcuts (free today, not `Mod+J`): Dismiss reminder `Shift+D`; Snooze reminder `Shift+H`; composer follow-up switch `Mod+Shift+O`. `H` stays free for roadmap feature 8 (whole-conversation snooze).
- Commits: conventional subjects as in `git log`; run `engineering-skills:pre-commit-security` (its script with `bash`) before each; end every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never add `docs/superpowers/briefs/`.

## Builder decisions (not in the spec; report them)

- **Lookback:** reminders consider threads whose latest person message is from the last 30 days (`reminderLookbackDays = 30`), plus any thread with a snooze. Without it, the first launch would raise every unreplied inbox email from past years to the top. 30 days matches the Sent prefetch window the ask-check relies on.
- **"Latest message" means the latest message from a person:** automated messages (the Important rule, including the always and never lists) neither count as a reply nor start a reminder. That is how out-of-office replies "don't count".
- **Labels are written only when Khyati's final choice differs from the main-process ask-check on the sent HTML,** the same check the other laptop runs on the Sent copy. Same outcome as the spec's two labels, robust to the renderer and main extracting slightly different text.
- **Returning an archived follow-up moves only the thread's archive-role locations (All Mail on Gmail) to Inbox,** never the Sent copy, through `service.mutate` with a new `fromRoles` filter. It happens once per reminder (recorded locally), so archiving it again doesn't loop. Its undo is offered in a toast.
- **Dismiss has an Undo toast** (removes the label), per inlark's "recoverable mistakes should be easy to undo".

## Review Focus

1. **A reminder whose thread gets a new message while it is shown** (reply arrives, or Khyati replies from the phone): the reminder must disappear or change kind on the next index change, and a dismissal or snooze of the old message must not carry over to the new one. Covered in Task 4 (derive keyed by `messageId`) and Task 6 (engine invalidates on `changed`).
2. **Paging with due reminders across accounts:** a reminder from account B must not repeat or vanish between page 1 and page 2 of the unified inbox. Covered in Task 5 (`mergePages` sort key, keyset on the sort key).
3. **Gmail duplicates and label copies:** the label folder copy must never be the copy shown, never count as an extra conversation, and never be "the latest message". Covered in Task 3 (excluded mailboxes) and Task 7 (`locationRank`, hidden folders).
4. **Time zones and DST weekends:** a Friday 15:00 email in Montréal is due Monday 15:00 local, including the weekend clocks change. Covered in Task 2.
5. **Feature switched off or an account that is JMAP:** nothing moves, no labels, no SQL change to the inbox query (identical SQL to today when no reminders are due). Covered in Task 5 (unchanged SQL without boost) and Task 12.

---

### Task 1: The ask-check (core, pure)

**Files:**

- Create: `packages/core/src/ask-check.ts`
- Modify: `packages/core/src/index.ts` (one export line)
- Test: `tests/reminders-ask-check.test.ts`

**Interfaces:**

- Produces:
  - `ownText(text: string): string` — Khyati's own words from a plain-text email body.
  - `askCheck(text: string): { asks: boolean; reason?: 'question' | 'phrase' }` — runs `ownText` first.
  - `requestPhrases: readonly string[]` (exported for tests and the settings copy).

`ownText` removes, in this order:

1. Everything from the first reply-attribution or forward marker line: English `On … wrote:` (may wrap over two lines), French `Le … a écrit :` (with or without the space before the colon), `-----Original Message-----`, `---------- Forwarded message ----------`, `De :`/`From:` header blocks introduced by `________________`.
2. Lines starting with `>`.
3. Everything from a signature delimiter line `-- ` (or `--`) on.
4. A plain closing at the end: the last non-empty line(s) starting with `Thanks`, `Thank you`, `Merci`, `Cheers`, `Best`, `Regards`, `Cordialement`, `Bonne journée` when that line is the closing word(s) plus optional punctuation, and any lines after it (the name). "Thanks in advance" and "Merci d'avance" are **not** a plain closing.

`askCheck` is `asks: true` when the own text contains `?` (reason `question`), or, case- and accent-insensitive, one of the request phrases (reason `phrase`). Phrases (English and French, curly or straight apostrophes): let me know, can you, could you, would you, please confirm, please advise, please send, please review, please let, any update, any news, when can, when could, when will you, thanks in advance, thank you in advance, looking forward to hearing, pouvez-vous, pourriez-vous, peux-tu, pourrais-tu, merci de confirmer, merci de me, tenez-moi au courant, tiens-moi au courant, merci d'avance, d'avance merci, j'attends votre retour, dans l'attente de votre retour, qu'en pensez-vous, des nouvelles. Matching is on word boundaries so "scan you" doesn't match "can you".

- [ ] **Step 1: Write the failing tests**

```ts
describe('askCheck', () => {
  it.each([
    ['Can we meet Tuesday?', 'question'],
    ['Let me know when it ships.', 'phrase'],
    ['Pouvez-vous envoyer le devis.', 'phrase'],
    ['Merci d’avance pour le retour', 'phrase'],
    ['Thanks in advance', 'phrase'],
    ['Tenez-moi au courant', 'phrase'],
    ['ANY UPDATE on this', 'phrase'],
  ])('asks: %s', (text, reason) => expect(askCheck(text)).toEqual({ asks: true, reason }))
  it.each([
    'Here is the file.\n\nThanks,\nKim',
    'Voici le fichier.\n\nMerci,\nKim',
    'Done.\n\nOn Tue, 3 Nov 2026 at 10:00, Ada <ada@example.com> wrote:\n> Can you send it?',
    'Fait.\n\nLe mar. 3 nov. 2026 à 10:00, Ada <ada@example.com> a écrit :\n> Pouvez-vous ?',
    'Sent.\n-- \nKim · Studio · Need help? Call us',
    'I scan your files daily.',
  ])('does not ask: %j', (text) => expect(askCheck(text).asks).toBe(false))
  it('keeps text above a closing that is not plain', () =>
    expect(ownText('See attached.\n\nThanks in advance,\nKim')).toContain('Thanks in advance'))
})
```

- [ ] **Step 2: Run** `corepack pnpm exec vitest run tests/reminders-ask-check.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `ownText`, `askCheck`, `requestPhrases` in `packages/core/src/ask-check.ts`; normalize with `normalize('NFD').replace(/\p{M}/gu, '')`, lowercase and `’`→`'` before matching. Export from `packages/core/src/index.ts`.
- [ ] **Step 4: Run the test** — PASS. Typecheck `@inlark/core`.
- [ ] **Step 5: Commit** `feat(core): ask-check for emails that ask for something`

### Task 2: Working days and snooze presets (core, pure)

**Files:**

- Create: `packages/core/src/working-days.ts`
- Modify: `packages/core/src/index.ts`
- Test: `tests/reminders-working-days.test.ts`

**Interfaces:**

- Produces:
  - `addWorkingDays(ms: number, days: number): number` — local time zone of the process.
  - `snoozePresets(now: number): { id: 'tomorrow' | 'monday' | 'nextWeek'; label: string; until: number }[]`
  - `snoozeAt(date: { year: number; month: number; day: number }): number` — 9:00 local on that date (for "Pick a date…").
  - `const reminderMorningHour = 9`

`addWorkingDays`: if `ms` falls on Saturday or Sunday (local), start from the next Monday 00:00 local. Then, `days` times, step to the same local wall-clock time on the next calendar day, skipping Saturday and Sunday. Use `Date` local setters (`setDate`), never adding 86 400 000, so DST changes keep wall-clock time.

Presets: Tomorrow morning = tomorrow 9:00; Monday morning = the next Monday 9:00 strictly after today (on a Monday it is next week's Monday); Next week = 7 days from today at 9:00.

- [ ] **Step 1: Write the failing tests.** Set `process.env.TZ = 'America/Toronto'` at the top of the file (Node reads it at runtime). Cases, written with a local-time helper `at(y, m, d, h, min)`:
  - Wed 2026-11-04 10:00 + 1 → Thu 2026-11-05 10:00
  - Fri 2026-11-06 15:00 + 1 → Mon 2026-11-09 15:00
  - Thu 2026-11-05 15:00 + 3 → Tue 2026-11-10 15:00
  - Sat 2026-11-07 10:00 + 1 → Tue 2026-11-10 00:00
  - Fri 2026-10-30 15:00 + 1 → Mon 2026-11-02 15:00 (clocks change Sun 2026-11-01; elapsed ms ≠ 3×24 h, wall clock 15:00)
  - `snoozePresets(at(2026,11,9,14,0))` (a Monday) → tomorrow Tue 11-10 9:00, monday Mon 11-16 9:00, nextWeek Mon 11-16 9:00; and from Fri 11-06: monday → Mon 11-09 9:00, nextWeek → Fri 11-13 9:00.
  - A second `describe` with `TZ = 'Europe/Paris'` repeating the Friday case, proving the result follows the zone.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** in `packages/core/src/working-days.ts`.
- [ ] **Step 4: Run** — PASS. Typecheck core.
- [ ] **Step 5: Commit** `feat(core): working-day arithmetic and snooze presets`

### Task 3: Index schema v5 and reminder facts

**Files:**

- Create: `apps/desktop/src/main/imap-index/reminder-schema.ts` (migration), `apps/desktop/src/main/imap-index/reminder-sql.ts` (queries)
- Modify: `apps/desktop/src/main/imap-index/sqlite-index.ts` (`SCHEMA_VERSION = 5`, `migrations` entry, three methods, `methodTable`), `apps/desktop/src/main/imap-index/split-sql.ts` (export `person`), `packages/imap/src/metadata-index.ts` (three interface methods), `packages/core/src/reminders.ts` (new: types) + `packages/core/src/index.ts`
- Test: `tests/reminders-index.test.ts`

**Interfaces:**

- Produces (core `reminders.ts`):

```ts
export type ReminderKind = 'followUp' | 'reply'
export type ReminderLabel = 'noReminder' | 'followUp'
export const reminderLabelNames: Record<ReminderLabel, string> = {
  noReminder: 'No reminder',
  followUp: 'Follow up',
}
export const reminderLabelRoot = 'Warpmail'
export const reminderLookbackDays = 30
export interface ReminderFacts {
  threadId: string
  /** The thread's latest message from a person (see Important), as indexed. */
  messageId: string | null // Message-ID header, no brackets
  receivedAt: string // ISO
  fromEmail: string | null // lowercase
  to: string[] // lowercase addresses on its To line
  inInbox: boolean // any message of the thread is in INBOX
  labels: { noReminder: boolean; followUp: boolean } // a copy with this Message-ID is in the label folder
  asks: boolean | null // stored ask-check of this message; null when never checked
}
```

- Produces (`MetadataIndex`, all `Promise`-returning, synchronous in `SqliteMetadataIndex`):
  - `reminderFacts(accountId: string, query: ReminderFactsQuery): ReminderFacts[]` with
    `ReminderFactsQuery = { inboxId: string; mailboxIds: string[]; labelIds: Partial<Record<ReminderLabel, string>>; important: Extract<SplitScope, { kind: 'important' }>; sinceMs: number; threadIds?: string[] }` (exported from `packages/imap/src/metadata-index.ts`). `mailboxIds` are the mailboxes whose messages count (the caller leaves out Drafts, Trash, Junk and the label folders).
  - `askChecksNeeded(accountId: string, sentId: string, sinceMs: number, limit: number): { id: string; messageId: string }[]` — Sent messages received at or after `sinceMs`, with a Message-ID and no `reminder_checks` row, newest first.
  - `setAskChecks(accountId: string, rows: { messageId: string; asks: boolean }[]): void` — upsert.

Schema v5 (`migrateToV5`, written to run again over a v5 file like v4):

```sql
CREATE TABLE IF NOT EXISTS reminder_checks (
  account_id TEXT NOT NULL, message_id TEXT NOT NULL, asks INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)) WITHOUT ROWID;
```

Keyed by Message-ID so Gmail's copies and the other laptop's copy share one answer. Add no other index unless the plan check below shows a scan; `messages_thread`, `messages_mailbox_received`, `messages_mailbox_thread` and `messages_message_id` already cover the query. Rows are not deleted with messages (small; a Message-ID is stable).

`reminderFacts` SQL shape (in `reminder-sql.ts` as `reminderFactsQuery(accountId, query): SqlFragment`): a materialized `recent` set of thread ids (from `json_each(mailboxIds) CROSS JOIN messages` on `account_id, mailbox_id, received_ms >= sinceMs`, `UNION` the given `threadIds` resolved through `thread_aliases`); per thread the latest message (bare-column `max(received_ms)` trick as in `conversationSource`) among `mailboxIds` that passes `person(important, 'm')` from `split-sql.ts`; then for that row `message_id`, `received_at`, `from_email`, `to_addr`, `EXISTS` an INBOX row of the thread, `EXISTS` a row with the same `message_id` in each label folder, and `asks` from `reminder_checks`. Parse `to_addr` JSON in TS into lowercase addresses. Threads whose latest person message is older than `sinceMs` are kept only when listed in `threadIds`.

- [ ] **Step 1: Write the failing tests** (copy `folder()`/`message()` helpers from `tests/split-index.test.ts`; own address `me@example.com`; mailboxes INBOX, `[Gmail]/All Mail` (`specialUse: '\\All'`), `[Gmail]/Sent Mail` (`\\Sent`), `Warpmail/No reminder`, `Warpmail/Follow up`). One `it` per row:
  - person email to me in INBOX → one fact, `inInbox: true`, `to: ['me@example.com']`, `fromEmail` lowercase.
  - me only on Cc → fact has `to` without me (derivation decides; the index reports).
  - automated latest (List-Unsubscribe / `Auto-Submitted: auto-replied` via `automation`) after my sent message → fact is my sent message (out-of-office ignored).
  - colleague `bo@example.org` replies after my sent message → fact is the colleague's message.
  - Gmail duplicates: the same email (same `emailId`, same Message-ID) in INBOX and All Mail → one fact.
  - label copy in `Warpmail/No reminder` with the fact's Message-ID → `labels.noReminder: true`, and the label copy never becomes the fact (its mailbox is not in `mailboxIds`).
  - `setAskChecks('a', [{ messageId, asks: true }])` → fact `asks: true`; `askChecksNeeded` no longer lists it; a Sent message without a row is listed.
  - thread older than `sinceMs` → no fact, unless its id is in `threadIds`.
  - Important never list containing the sender → that message is skipped as automated.
  - migration: make a v4 file by opening a new index, adding a message, closing it, then with `DatabaseSync` running `DROP TABLE reminder_checks; PRAGMA user_version = 4`; reopening gives v5, keeps the message and has `reminder_checks`. `SCHEMA_VERSION === 5`.
  - plan: `EXPLAIN QUERY PLAN` of `reminderFactsQuery` (run through a `DatabaseSync` with `registerSplitFunctions`) has no detail matching `/^SCAN m\b/` or `/^SCAN messages\b/`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the migration, `reminderFactsQuery`, the three methods, the interface additions and the core types. Update any test fakes of `MetadataIndex` that the typecheck flags (the worker client proxies by `indexMethods`, so `methodTable` is the only list).
- [ ] **Step 4: Run** the new test plus `tests/split-index.test.ts tests/imap-index.test.ts` — PASS. Typecheck desktop, imap, core.
- [ ] **Step 5: Commit** `feat(index): schema v5 with reminder facts and stored ask-checks`

### Task 4: Deriving a reminder (core, pure)

**Files:**

- Modify: `packages/core/src/reminders.ts`
- Test: `tests/reminders-derive.test.ts`

**Interfaces:**

- Consumes: `ReminderFacts` (Task 3), `addWorkingDays` (Task 2).
- Produces:

```ts
export interface ReminderSettings {
  enabled: boolean
  followUp: boolean
  forgotToReply: boolean
  followUpDays: number
  replyDays: number
}
export const defaultReminderSettings: ReminderSettings // true, true, true, 3, 1
export interface ReminderSnooze {
  accountId: string
  threadId: string
  messageId: string
  until: number
}
export interface Reminder {
  kind: ReminderKind
  threadId: string
  messageId: string
  /** When it shows: the due time, or the end of a snooze. */
  dueMs: number
}
export function reminderSettingsOf(settings: Pick<Settings, 'reminders'>): ReminderSettings
export function deriveReminder(
  facts: ReminderFacts,
  context: { own: string[]; settings: ReminderSettings; snooze?: ReminderSnooze },
): Reminder | null
export function reminderLabelText(kind: ReminderKind, settings: ReminderSettings): string
```

Rules: `null` when the feature is off, `messageId` is null, or `labels.noReminder`. From one of `own` → follow-up when `followUp` is on and (`labels.followUp` or `asks === true`); due = `addWorkingDays(received, followUpDays)`. Otherwise → reply when `forgotToReply` is on, `inInbox`, and `to` contains one of `own`; due = `addWorkingDays(received, replyDays)`. A snooze applies only when its `messageId` equals the fact's: `dueMs = max(due, until)`. `reminderSettingsOf` clamps days to whole numbers 1–30 and fills defaults. `reminderLabelText`: `'Waiting on you'` for reply; `'No reply in N days'` (`'1 day'` when 1) for follow-up.

- [ ] **Step 1: Write the failing tests**: own sent + `asks: true` → followUp due +3 wd; `asks: false` → null; `asks: false` + `labels.followUp` → followUp; `asks: true` + `labels.noReminder` → null; person + inInbox + me on To → reply +1 wd; me only on Cc (`to` lacks me) → null; not inInbox → null; `followUp: false` → null for own; `enabled: false` → null; snooze with same messageId → `dueMs === until`; snooze with another messageId → ignored; alias in `own` counts as me; `reminderSettingsOf({ reminders: { followUpDays: 99 } as never })` clamps to 30; label texts.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Add `reminders?: Partial<ReminderSettings>` and `reminderSnoozes?: ReminderSnooze[]` to `Settings` in `packages/core/src/model.ts` (one block, comment `// Reminders`), and to `settingsSchema` in `schemas.ts` (one block: `reminders` object of optional booleans and ints 1–30; `reminderSnoozes` array max 500 of `{ accountId: id, threadId: id, messageId: z.string().max(998), until: z.number().int() }`).
- [ ] **Step 4: Run** — PASS. Typecheck core.
- [ ] **Step 5: Commit** `feat(core): derive follow-up and forgot-to-reply reminders`

### Task 5: Inbox order with due reminders

**Files:**

- Modify: `apps/desktop/src/main/imap-index/sqlite-index.ts` (`conversationSource`/`conversations`), `packages/imap/src/metadata-index.ts` (`ConversationFilter.boost`, `ConversationRow.sortMs`, `ConversationCursor.sortMs`), `packages/imap/src/provider.ts` (`query`: pass boost, set `c.reminder`, cursor), `packages/core/src/model.ts` (`Conversation.reminder`, `ProviderQuery.reminders`), `packages/core/src/mail.ts` (`mergePages` sort key)
- Test: `tests/reminders-order.test.ts`; extend `tests/split-bench.test.ts` with a reminders case

**Interfaces:**

- Consumes: `Reminder`, `ReminderKind` (Task 4).
- Produces:
  - `ConversationFilter.boost?: { threadId: string; sortMs: number }[]` — threads in the result sort by `sortMs` instead of their latest date.
  - `ConversationRow.sortMs?: number` (set only for boosted rows); `ConversationCursor.sortMs?: number`.
  - `ProviderQuery.reminders?: { threadId: string; kind: ReminderKind; dueAt: string; messageId: string }[]`
  - `Conversation.reminder?: { kind: ReminderKind; dueAt: string; messageId: string }`
  - `conversationSortKey(c: Conversation): string` in `mail.ts` = `c.reminder?.dueAt ?? c.receivedAt`, used by `mergePages`.

With `boost` absent or empty, `conversations` must run **exactly today's SQL** (assert with a test that compares the prepared SQL text or the plan to the no-boost call). With boost: `g` gains `k = coalesce(b.k, r)` via `LEFT JOIN (SELECT value ->> 0 AS t, value ->> 1 AS k FROM json_each(?)) b ON b.t = g.t`; order by `k DESC, t`; keyset `k < ? OR (k = ? AND t > ?)` using `after.sortMs ?? time(after.receivedAt)`; the page carries `k` back so `sortMs` is set where `k ≠ r`. Totals unchanged. In `provider.query`, apply `boost` only when `tabApplies(query)` and the scope is the inbox (same condition as `split`), map `query.reminders` to `{ threadId, sortMs: Date.parse(dueAt) }`, attach `c.reminder` to matching items, and store the cursor's `sortMs`. Thread ids need no alias resolution: the engine reads them from the same index.

- [ ] **Step 1: Write the failing tests** (index level and provider level with `FakeImapServer` as in `tests/imap-provider.test.ts`):
  - 120 inbox threads, boost the 3 oldest with due times newer than everything → page 1 (limit 50) starts with those 3 in due order; `total` is 120.
  - keyset: walk pages of 50 with `after` cursors → every thread exactly once, boosted ones only on page 1.
  - offset paging gives the same order.
  - boosted thread not in the filtered set (e.g., `unseen: true` and it's read) → not added.
  - boost with a split Important scope → only Important threads, boosted first.
  - no boost → identical plan and order to today; with boost, plan has no `/^SCAN m\b/`.
  - `mergePages` with account A item `receivedAt` newer and account B item with `reminder.dueAt` newer still → B first; next cursors consistent.
  - provider: `query({ view: 'inbox', reminders: [...] })` returns `reminder` on the item and puts it first; `view: 'sent'` ignores `reminders`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test plus `tests/imap-index.test.ts tests/split-index.test.ts tests/imap-provider.test.ts tests/core.test.ts` — PASS.
- [ ] **Step 5: Bench.** Add to `tests/split-bench.test.ts` a timing of the inbox page with 50 boosted threads vs none, and of `reminderFacts` (30-day window), at the bench's 100k messages. Run `INLARK_BENCH=1 corepack pnpm exec vitest run tests/split-bench.test.ts`; record the numbers in the commit message. The boosted page must be within 20% of the plain inbox page.
- [ ] **Step 6: Commit** `feat(inbox): due reminders sort to the top of Inbox and its tabs`

### Task 6: The reminder engine (main)

**Files:**

- Create: `apps/desktop/src/main/reminders/engine.ts`, `apps/desktop/src/main/reminders/own-text.ts`
- Modify: `packages/core/src/model.ts` (`MailProvider.reminderFacts?`, `askChecksNeeded?`, `setAskChecks?`; `MutationInput.fromRoles?`; `AppEvent` `remindersReturned`), `packages/imap/src/provider.ts` (implement the three provider methods: resolve inbox, Sent, label folders and counted mailboxes from roles), `apps/desktop/src/main/service.ts` (construct engine; one block in `query`; one line in the provider subscription; one line in `setSettings`; `fromRoles` filter in `mutate`; start after connections in `init`)
- Test: `tests/reminders-engine.test.ts`

**Interfaces:**

- Consumes: Tasks 3–5.
- Produces:
  - `htmlOwnText(html: string): string` in `own-text.ts`: `html-to-text` `convert` with `wordwrap: false` and skip selectors `img`, `blockquote`, `.gmail_quote`, `.gmail_attr`, `.gmail_signature`, `[data-inlark-signature]`, `[data-inlark-signature-text]`, `[data-smartmail="gmail_signature"]`; input capped at 200 000 chars; then `ownText`.
  - `mainAskCheck(message: { html?: string; text?: string }): boolean` = `askCheck(html ? htmlOwnText(html) : text).asks`.
  - `class ReminderEngine` with:
    - `constructor(deps: { accounts(): Account[]; settings(): Settings; provider(accountId: string): MailProvider | undefined; returnToInbox(accountId: string, threadId: string): Promise<string | undefined /* undoId */>; emit(event: AppEvent): void; store: { read<T>(key: string, fallback: T): Promise<T>; write(key: string, value: unknown): Promise<void> }; now?: () => number })`
    - `due(accountId: string): Promise<Reminder[]>` — cached per account; derives on first call after `invalidate`.
    - `invalidate(accountId?: string): void` — drops the cache and schedules a recompute (debounced 500 ms) that also runs the ask scan and the returns.
    - `start(): void`, `dispose(): void`.
  - Provider methods (core `MailProvider`, optional):
    - `reminderFacts?(account: Account, query: { important: Extract<SplitScope, { kind: 'important' }>; sinceMs: number; threadIds?: string[] }): Promise<ReminderFacts[]>`
    - `askChecksNeeded?(account: Account, sinceMs: number, limit: number): Promise<{ id: string; messageId: string }[]>`
    - `setAskChecks?(account: Account, rows: { messageId: string; asks: boolean }[]): Promise<void>`
  - `MutationInput.fromRoles?: string[]` — only message locations in mailboxes of these roles take part (`archive` for returning a follow-up).
  - `AppEvent` gains `{ type: 'remindersReturned'; count: number; undoId?: string }`.

Engine behaviour:

- Due list = `deriveReminder` over `reminderFacts` (Important scope from `resolveTab(settings, accounts, 'important')`, own = `ownAddresses(accounts)`, `sinceMs = now − 30 days`, `threadIds` = snoozed threads of the account) filtered to `dueMs ≤ now`. IMAP accounts only; off when `reminderSettingsOf(settings).enabled` is false.
- A timer fires at the earliest future `dueMs` (capped at 1 hour, re-armed) and calls `invalidate()` then `emit({ type: 'changed' })`.
- Ask scan per recompute: up to 25 `askChecksNeeded` from the last 30 days → `provider.messages(account, ids, true)` → `mainAskCheck` → `setAskChecks`. A message whose body can't be read stays unchecked and is skipped for the rest of the session (a `Set` of skipped ids), so a later session retries it. The scan runs in the background and never blocks `due`.
- Returns: for each due follow-up with `inInbox: false` whose key `accountId|threadId|messageId` is not in the `reminders-returned` store entry (array, capped at 500, oldest dropped), call `returnToInbox`; record the key; emit one `remindersReturned` with the count and the undo id when one move happened (several moves: the latest undo id).
- Logging: none beyond `this.log('reminders-failed')`-style event names; never subjects, addresses or ids.

Service wiring (`service.ts`, each a small block marked `// Reminders`):

- `returnToInbox(accountId, threadId)` = `this.mutate({ targets: [{ accountId, threadId }], action: 'move', mailboxId: <inbox id from provider.mailboxes>, fromRoles: ['archive'] })` → `undoId`.
- `query`: when `tabApplies(query)` (and the tab plan isn't empty), for each IMAP account add `reminders` (from `await this.reminders.due(a.id)`, mapped to `{ threadId, kind, dueAt: new Date(dueMs).toISOString(), messageId }`) to the per-account provider query.
- Provider `changed` event → `this.reminders.invalidate(accountId)`. `setSettings` → `this.reminders.invalidate()`.
- `init`: `this.reminders.start()` after providers are created (catch-up on launch). `dispose`: `this.reminders.dispose()`.
- `mutate`: when `input.fromRoles` is set, keep only messages whose mailbox role is in it before `planMutation`.

- [ ] **Step 1: Write the failing tests** with a fake `MailProvider` (facts returned from a fixture array, `messages` returning `{ html }`) and a fake clock:
  - due list has the reply 1 wd after receipt and not before.
  - follow-up with `asks: null` → scan calls `setAskChecks` with `asks: true` for "Can you confirm?" and the next `due` includes it.
  - archived due follow-up → `returnToInbox` called once; second recompute doesn't call it again; `remindersReturned` emitted with the undo id.
  - catch-up: engine started with `now` 5 working days after a follow-up → due at start, no event needed.
  - snoozed until later → absent; after `now` passes `until` → present with `dueMs === until`.
  - `enabled: false` → `due` is `[]`, provider not asked.
  - `mutate` with `fromRoles: ['archive']` on a thread with Sent and All Mail locations plans a change only for the All Mail location (test in `tests/mail-mutations.test.ts` style or through the service with the IMAP fake from `tests/service-imap.test.ts`).
  - `htmlOwnText` drops `<div class="gmail_quote">`, `<blockquote>`, `<div data-inlark-signature>` and `<p data-inlark-signature-text>` content.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test plus `tests/service.test.ts tests/service-imap.test.ts tests/split-service.test.ts` — PASS. Typecheck all touched packages.
- [ ] **Step 5: Commit** `feat(desktop): work out reminders from the index and return due follow-ups`

### Task 7: Gmail label folders (provider)

**Files:**

- Create: `packages/imap/src/labels.ts`
- Modify: `packages/imap/src/provider.ts` (`locationRank`, `mailboxes()`, new `labelMessage` method, `reminderFacts` mailbox selection), `packages/core/src/model.ts` (`MailProvider.labelMessage?`)
- Test: `tests/reminders-labels.test.ts`

**Interfaces:**

- Produces:
  - `labels.ts`: `isWarpmailFolder(path: string, delimiter: string): boolean` (the root `Warpmail` or anything under `Warpmail<delimiter>`); `labelPath(label: ReminderLabel, delimiter: string): string`.
  - `MailProvider.labelMessage?(account: Account, label: ReminderLabel, messageId: string, add: boolean): Promise<void>`

`labelMessage` (one queued task on the command connection): add → find the message's best location by Message-ID (`index.findByMessageId`, prefer All Mail, then INBOX, then Sent; never a label folder), create the label folder if the index doesn't list it (`port.createMailbox`, then `refreshFolders`), `select` the source and `copy([uid], labelPath)` unless a copy with that Message-ID is already in the label folder, then sync the label folder (`syncMailbox`) so the index sees it at once. Remove → select the label folder, `search({ header: { 'Message-ID': messageId } })`, `expunge` those UIDs, `removeUids` in the index. No message found → `ProviderError('notFound', 'This email is no longer on the server.')`.
`mailboxes()` leaves out `isWarpmailFolder` boxes. `locationRank` ranks a Warpmail folder 5 (below All Mail's 3 and unknown's 4). `scope()` for non-role views leaves Warpmail folders out of `boxes` and adds them to `excludeMailboxIds`, so they never add rows to All mail, Starred or search. `reminderFacts`' counted mailboxes leave out Drafts, Trash, Junk and Warpmail folders.

- [ ] **Step 1: Write the failing tests** on `FakeImapServer` (check `tests/support/fake-imap.ts` supports `createMailbox`, `copy`, `expunge`, header search; extend the fake minimally if header search is missing):
  - first `labelMessage(add)` creates `Warpmail/No reminder` and copies the message; a second call doesn't copy twice.
  - after add, `reminderFacts` reports `labels.noReminder: true`; after remove, `false` and the folder is empty.
  - `mailboxes()` lists neither `Warpmail` nor `Warpmail/No reminder`.
  - a conversation whose email is in INBOX and the label folder shows the INBOX copy (`onePerEmail` picks rank 1 over 5), and the All mail view counts it once.
  - unknown Message-ID → rejects with `notFound`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test plus `tests/imap-provider.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(imap): Warpmail label folders for reminder choices`

### Task 8: Choices saved as labels (after sending, dismiss)

**Files:**

- Modify: `apps/desktop/src/main/reminders/engine.ts` (`afterSend`, `dismiss`, `restore`), `apps/desktop/src/main/service.ts` (one call in `finishSend`; `dismissReminder`/`restoreReminder` methods), `packages/core/src/model.ts` (`Draft.followUp?: boolean` in one block; `DesktopMailAPI` entries), `packages/core/src/schemas.ts` (draft schema `followUp: z.boolean().optional()` in one block; `ipcSchemas` entries), `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/index.ts`
- Test: extend `tests/reminders-engine.test.ts`; `tests/service-imap.test.ts` style for the send hook

**Interfaces:**

- Consumes: `labelMessage` (Task 7), `mainAskCheck` (Task 6).
- Produces:
  - `ReminderEngine.afterSend(input: { accountId: string; messageId: string; sentCopy?: string; followUp?: boolean; html: string; text: string }): Promise<void>` — only when `sentCopy` is `'filed'` or `'server'`; `guess = mainAskCheck({ html, text })`; `setAskChecks(messageId, guess)`; when `followUp !== undefined && followUp !== guess`, `labelMessage(followUp ? 'followUp' : 'noReminder', messageId, true)`. Errors are swallowed and logged by event name only.
  - `ReminderEngine.dismiss(target: { accountId: string; threadId: string; messageId: string }): Promise<void>` → `labelMessage('noReminder', messageId, true)` then `invalidate(accountId)`.
  - `ReminderEngine.restore(target)` → `labelMessage('noReminder', messageId, false)` then `invalidate`.
  - Service + IPC + preload + `DesktopMailAPI`: `dismissReminder(target)`, `restoreReminder(target)`; zod: `z.tuple([z.object({ accountId: id, threadId: id, messageId: z.string().min(1).max(998) })])`.

The send hook, in `finishSend` right after `if (journal.sentCopy) await this.fileSentCopy(journal, outgoing)`:
`void this.reminders.afterSend({ accountId: journal.accountId, messageId: journal.messageId!, sentCopy: journal.sentCopy, followUp: draft.followUp, html: draft.html, text: draft.text }) // Reminders`. That is the only send-flow change. A Sent copy that fails to file gets no label (the guess applies once it is filed later); report this.

- [ ] **Step 1: Write the failing tests:** `afterSend` with `followUp: true` and an HTML body without a question → `labelMessage('followUp', …, true)`; `followUp: false` and "Can you send it?" → `noReminder`; equal to guess → no label; `sentCopy: 'failed'` → nothing; `dismiss` → label added and the next `due` lacks the reminder; `restore` brings it back. Through the service: sending a draft with `followUp: false` and a question on the IMAP fake ends with the Sent copy's Message-ID in `Warpmail/No reminder`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests plus `tests/service.test.ts tests/service-imap.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(desktop): save follow-up switches and dismissals as Gmail labels`

### Task 9: Snooze picker (reusable) and the reminder label

**Files:**

- Create: `apps/desktop/src/renderer/src/snooze/SnoozePicker.tsx`, `apps/desktop/src/renderer/src/reminders/ReminderLabel.tsx`
- Modify: `apps/desktop/src/renderer/src/ConversationRow.tsx` (one line mounting `ReminderLabel` next to the "Draft" label)
- Test: `tests/reminders-ui.test.tsx` (happy-dom; follow an existing renderer test such as `tests/split-tabs.test.ts` for setup)

**Interfaces:**

- Produces:
  - `SnoozePicker({ open, onClose, onPick, now? }: { open: boolean; onClose(): void; onPick(until: number): void; now?: number })` — a small menu-style dialog with the three `snoozePresets` (label plus the day and time as `shortDate` shows it) and "Pick a date…" opening a native `<input type="date">` (min tomorrow), confirmed with Enter; arrow keys move, Enter picks, Escape closes. No reminder-specific text inside, so feature 8 can reuse it.
  - `ReminderLabel({ reminder, settings }: { reminder?: Conversation['reminder']; settings: ReminderSettings })` — nothing when absent; else a small label in the row's existing label style (as "Draft", using the accent or muted colour already defined) with `reminderLabelText`.

- [ ] **Step 1: Write the failing tests:** label text for both kinds and for `followUpDays: 1`; picker lists three presets with the right times from a fixed `now`, ArrowDown+Enter picks the second, the date input picks 9:00 of that date, Escape calls `onClose`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS. Typecheck desktop. Prettier.
- [ ] **Step 5: Commit** `feat(renderer): reminder label and a reusable snooze picker`

### Task 10: Dismiss and snooze everywhere (shortcuts, menus, command menu, reader)

**Files:**

- Create: `apps/desktop/src/renderer/src/reminders/useReminders.ts`, `apps/desktop/src/renderer/src/reminders/ReminderBar.tsx`
- Modify: `apps/desktop/src/renderer/src/shortcuts.tsx` (two definitions in `Organize`), `apps/desktop/src/renderer/src/App.tsx` (call the hook; spread its `shortcutHandlers` and `commands` next to `split`'s; render `SnoozePicker`; toast for `remindersReturned`), `apps/desktop/src/renderer/src/Reader.tsx` (one line mounting `ReminderBar`; two `MenuItem`s in the "More conversation actions" menu passed as a prop or a fragment from the hook)
- Test: extend `tests/reminders-ui.test.tsx`; `tests/shortcuts.test.ts` (no conflicts)

**Interfaces:**

- Consumes: `api.dismissReminder`, `api.restoreReminder` (Task 8), settings save path used by `useSplitInbox` (`savePreferences`), `SnoozePicker`, `ReminderLabel`.
- Produces:
  - Shortcut ids `dismissReminder` (label "Dismiss reminder", default `[['Shift+D']]`) and `snoozeReminder` (label "Snooze reminder…", default `[['Shift+H']]`).
  - `useReminders({ settings, conversation: () => Conversation | undefined, savePreferences, notify, showToast })` → `{ shortcutHandlers, commands, menuItems, picker, bar }` where the target is the open thread, else the focused row, and only when it carries `reminder`.

Behaviour: Dismiss → `api.dismissReminder` then toast "Reminder dismissed" with Undo (`api.restoreReminder`); errors via `notify` with `friendlyError`. Snooze → picker → append `{ accountId, threadId, messageId, until }` to `settings.reminderSnoozes` (drop entries for the same thread, drop entries whose `until` is over 30 days past, cap 500) via `savePreferences`; toast "Snoozed until <day time>" with Undo (restore the previous list). The conversation leaves the top on the next query (main invalidates on `setSettings`). Command menu: "Dismiss reminder" and "Snooze reminder…" with their keys, only when a target has a reminder. `ReminderBar` in the reader: one quiet line above the messages — the label text, then "Dismiss" and "Snooze…" buttons with shortcut hints — in the existing reader banner style (match how the reader shows its other notices). `remindersReturned` event → toast "N follow-up(s) back in Inbox" with Undo (`api.undo(undoId)`) when `undoId` is set.

- [ ] **Step 1: Write the failing tests:** hook returns no commands without a reminder; with one, both commands exist and `Shift+D` calls `api.dismissReminder` with the conversation's `accountId`, `id`, `reminder.messageId`; snooze pick saves the snooze list as described; `tests/shortcuts.test.ts` still finds no duplicate default bindings.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests plus `tests/shortcuts.test.ts tests/command-rank.test.ts` — PASS. Typecheck. Prettier.
- [ ] **Step 5: Commit** `feat(renderer): dismiss and snooze reminders from keys, menus and the command menu`

### Task 11: The composer's follow-up switch

**Files:**

- Create: `apps/desktop/src/renderer/src/reminders/FollowUpSwitch.tsx`, `apps/desktop/src/renderer/src/reminders/draft-text.ts`
- Modify: `apps/desktop/src/renderer/src/Composer.tsx` (mount the switch beside the Send button; one line in `send()` setting `followUp`), `apps/desktop/src/renderer/src/shortcuts.tsx` (`toggleFollowUp`, section `Write`, label "Follow-up on or off", default `[['Mod+Shift+O']]`)
- Test: `tests/reminders-composer.test.ts`

**Interfaces:**

- Produces:
  - `draftOwnText(html: string, text: string): string` (renderer): parse `html` with `DOMParser` when present, remove `blockquote`, `.gmail_quote`, `[data-inlark-signature]`, `[data-inlark-signature-text]` and the reply attribution paragraph directly before a removed `blockquote`, take `textContent` by block (newline per block); else use `text`; then core `ownText`.
  - `followUpGuess(draft: Pick<Draft, 'html' | 'text'>): boolean` = `askCheck(draftOwnText(...)).asks`.
  - `FollowUpSwitch({ draft, onChange }: { draft: Draft; onChange(followUp: boolean): void })` — an `IconButton`-sized toggle in the footer, `aria-pressed`, text "Follow-up: on (asks a question)" when on by the guess, "Follow-up: on" when switched on by hand, "Follow-up: off" when off; shortcut hint `toggleFollowUp`. Hidden when the account isn't IMAP, the feature or the follow-up kind is off, or the draft has no recipients.

`send()` sets `followUp: draft.followUp ?? followUpGuess(draft)` on the draft it passes on (one line, before `onSend`), so main always knows the shown choice. The guess is memoized on `draft.html`; it must not run more than once per keystroke burst (reuse the composer's existing debounced value if it has one).

- [ ] **Step 1: Write the failing tests:** `draftOwnText` drops a reply's quote, the HTML signature block and the marked text signature; `followUpGuess` is true for "Could you review?" and false for "Here it is.\n\nThanks," in a reply whose quote asks a question; the switch shows the three texts and `Mod+Shift+O` flips it.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests plus `tests/composer-document.test.ts tests/shortcuts.test.ts` — PASS. Typecheck. Prettier.
- [ ] **Step 5: Commit** `feat(composer): follow-up switch with the ask-check's guess`

### Task 12: Settings → Reminders, and catching up on launch

**Files:**

- Create: `apps/desktop/src/renderer/src/reminders/RemindersSettings.tsx`
- Modify: `apps/desktop/src/renderer/src/Settings.tsx` (one entry in the sections list, one line rendering the section)
- Test: `tests/reminders-settings.test.ts`; extend `tests/reminders-engine.test.ts`

**Interfaces:**

- Consumes: `reminderSettingsOf`, `defaultReminderSettings`, the settings save path used by `InboxSettings`.
- Produces: `RemindersSettings({ settings, save })` with, in inlark's settings style: "Reminders" main switch with one line of explanation; "Follow-ups" switch with "Remind me after [3] working days without a reply to an email that asks for something"; "Forgot to reply" switch with "Remind me after [1] working day when a person is waiting on my reply"; number inputs 1–30; the two kind rows are disabled while the main switch is off. A short note: "Dismissals and follow-up switches are saved as Gmail labels under Warpmail, so your other computer agrees. Snoozes stay on this computer."

- [ ] **Step 1: Write the failing tests:** the section saves `reminders: { enabled: false }` when the main switch is flipped; days outside 1–30 are refused (input keeps the last valid value); engine: with settings changed to `forgotToReply: false`, `due` drops replies after `invalidate()`; launch catch-up: engine `start()` with due reminders already past derives them without waiting for a timer, and the first `service.query` for Inbox has them on top.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS. Typecheck. Prettier.
- [ ] **Step 5: Commit** `feat(settings): Reminders section`

### Task 13: Finish

- [ ] Full suite: `corepack pnpm exec vitest run` (compare with the baseline), typecheck desktop, core, imap, `corepack pnpm exec prettier --check` on every changed file.
- [ ] Run the app (`env -u ELECTRON_RUN_AS_NODE corepack pnpm --filter @inlark/desktop dev`) if a display is available; otherwise say so in the report.
- [ ] Final review of the whole branch against the spec (subagent).
- [ ] `git fetch origin && git rebase origin/main`; resolve keeping both features; re-run every check.
- [ ] Report: head hash, done/left against the brief's priority list, check numbers, differences from the design (the "Builder decisions" above and anything new), a manual test checklist.
