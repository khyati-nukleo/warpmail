# Split inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A row of inbox tabs (Inbox, Important, user tabs) above the conversation list, filtered in the local SQLite index so switching, paging and counts stay as fast and correct as Inbox today.

**Architecture:** Pure rule logic (parsing, matching, own-address refusal, automated-sender detection) lives in a new `packages/core/src/split.ts`. The IMAP index gains schema v4: a `participants` table and automation columns, plus a `split` condition on `ConversationFilter` that becomes SQL. The main process turns the renderer's `tab` id into that condition using settings, and the renderer gets a self-contained `split/` folder (tab row, editors, picker, settings section) wired into `App.tsx` with small edits.

**Tech Stack:** TypeScript, Electron, React 19, TanStack Router/Query/Hotkeys, zod, `node:sqlite` in a worker, imapflow, Vitest (node environment only: no DOM tests).

**Spec:** [docs/superpowers/specs/2026-11-05-split-inbox-design.md](../specs/2026-11-05-split-inbox-design.md). Also binding: roadmap Constraints and Anti-goals (`docs/superpowers/specs/2026-11-03-warpmail-roadmap-design.md`), `AGENTS.md`, and the brief (`docs/superpowers/briefs/2026-11-05-split-inbox-brief.md`).

## Global Constraints

- Keep inlark's look, not Superhuman's: reuse inlark's tokens (`bg-selected`, `text-muted`, `text-strong`, `border-border-strong`, `rounded-sm`, 12px type, `h-7.5` items as in `SegmentedControl.tsx`), `Modal`, `Dropdown`, `MenuItem`, `Button`, `EmptyState` from `@inlark/ui`.
- Every action works from keyboard and mouse (AGENTS.md "keyboard and mouse parity").
- Never log subjects, addresses or bodies; add no network calls beyond IMAP header fetches; no telemetry.
- Stay mergeable with upstream inlark: new logic in new modules; edits to `App.tsx`, `service.ts`, `provider.ts`, `sqlite-index.ts`, `Settings.tsx`, `Reader.tsx` stay small and local.
- Matching is case-insensitive. A domain rule `@x.example` also covers subdomains (`a.x.com`).
- Tabs cover the inbox only (INBOX mailbox of IMAP accounts). Tabs are views; nothing is moved on the server.
- Index schema becomes v4 (one-way, like v3; the existing "created by a newer version" guard covers older builds).
- Shortcuts (all rebindable): Ctrl+1 Inbox, Ctrl+2 Important, Ctrl+3–Ctrl+9 user tabs in order, Ctrl+Tab next, Ctrl+Shift+Tab previous, Shift+T "Add sender to tab…".
- Automated sender = local part with `.`, `-`, `_` removed starts with `noreply`, `donotreply` or `bounce`, or local part is `mailer-daemon` or `postmaster`; or List-Unsubscribe or List-Id present; or Precedence is `bulk`, `list` or `junk`; or Auto-Submitted present and not `no`.
- Starting tabs: none built in. The owner imports them once from a private file outside the repo, in the export format (design "Export file format"). The repo is public: never put real addresses, client names or project names in code, tests, fixtures, docs or commit messages; use example.com addresses.
- Commands: `corepack pnpm exec vitest run <files>`, `corepack pnpm --filter @inlark/desktop typecheck` (plus `--filter @inlark/core`, `--filter @inlark/imap` typecheck when touched), `corepack pnpm exec prettier --check <files>`.
- Each commit: run the `engineering-skills:pre-commit-security` check, conventional-commit subject, never stage `design/` or `docs/superpowers/briefs/`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, merge or rebase.

## Decisions this plan makes (the spec leaves them open)

- **Tab ids.** `'inbox'` and `'important'` are reserved; user tabs get `crypto.randomUUID()`. The route and `MailQuery.tab` carry the id; absent means Inbox.
- **Rules are strings** in settings, exactly as typed after normalisation: `name@host` or `@host`. Order of `splitTabs` is the tab order.
- **Unread count unit** = unread INBOX emails in the tab's conversations, each server identity once (same unit as the sidebar's folder counts). The Inbox tab reuses the sidebar's inbox unread number already computed in `App.tsx` (`mailboxCounts`).
- **Domain storage.** Participants store `domain` label-reversed (`mail.client.example` → `example.client.mail`), so "domain or subdomain of R" is `domain = R OR (domain >= R || '.' AND domain < R || '/')`, an index range.
- **Membership is per conversation.** A tab filter is a predicate on `thread_id`, so the tab's rows, order, representative message and keyset paging are identical to Inbox's, just fewer.
- **Own addresses** = every account's `email` plus its aliases' emails, across all accounts. Refusal is checked in the renderer (with the reason shown) and again in the main process when resolving a tab (refused rules are dropped, so an imported file can't break the rule).
- **Search hides the tab row.** With a search (`route.q`) or a folder selected, or outside the Inbox view, no tab applies.
- **Import merges and never deletes** (design); export writes one JSON file.
- **Header backfill** marks a requested message as checked even if the server returned nothing for it, so the job always finishes.

## File Structure

| File                                                                                                                                      | Responsibility                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/split.ts` (new)                                                                                                        | Types `SplitTab`, `ImportantSettings`, `SplitScope`, `InboxExport`; pure `parseRule`, `parseRuleLines`, `refusalReason`, `isFreeMailDomain`, `domainKey`, `isAutomatedAddress`, `isAutomatedMessage`, `ruleMatches`, `resolveSplitScope`, `inboxExport`, `parseInboxExport` |
| `packages/core/src/model.ts`, `schemas.ts`, `index.ts`                                                                                    | `Settings` fields, `MailQuery.tab`, `ProviderQuery`, optional `MailProvider.tabCounts`, new `DesktopMailAPI` methods, zod schemas                                                                                                                                           |
| `packages/imap/src/metadata-index.ts`, `convert.ts`, `provider.ts`                                                                        | `ConversationFilter.split`, `NewMessage.automation`, new index methods, new headers in `metadataQuery`, provider `query`/`tabCounts`/header backfill                                                                                                                        |
| `apps/desktop/src/main/imap-index/sqlite-index.ts`, `client.ts`                                                                           | v4 migration, participants writes, split SQL, `tabCounts`, header backfill methods, worker client wrappers                                                                                                                                                                  |
| `apps/desktop/src/main/split-inbox.ts` (new)                                                                                              | `ownAddresses(accounts)`, tab resolution from settings, export/import file dialogs                                                                                                                                                                                          |
| `apps/desktop/src/main/service.ts`, `index.ts`, `apps/desktop/src/preload/index.ts`                                                       | Thin `tabCounts`, `tabMatchCount`, `exportInbox`, `importInbox`; `query` resolves `tab`                                                                                                                                                                                     |
| `apps/desktop/src/renderer/src/split/` (new folder)                                                                                       | `tab-model.ts` (pure), `TabRow.tsx`, `TabEditor.tsx`, `AddToTab.tsx`, `ImportantException.tsx`, `InboxSettings.tsx`, `ImportOffer.tsx`, `useSplitInbox.ts`                                                                                                                  |
| `apps/desktop/src/renderer/src/App.tsx`, `main.tsx`, `shortcuts.tsx`, `Reader.tsx`, `Settings.tsx`, `recipient-suggestions.ts`, `demo.ts` | Small wiring edits                                                                                                                                                                                                                                                          |
| `tests/split-rules.test.ts`, `tests/split-index.test.ts`, `tests/split-service.test.ts`, `tests/split-tabs.test.ts` (new)                 | Tests per layer; plus additions to `tests/imap-index.test.ts`, `tests/imap-provider.test.ts`, `tests/shortcuts.test.ts`, `tests/recipient-suggestions.test.ts`                                                                                                              |

## Review Focus

1. **A route or remembered location names a tab that no longer exists** (deleted, or replaced by an import): the app must show Inbox, not a blank list or an error. Pinned in Task 5 (`activeTabId`) and Task 4 (unknown id → empty page, never all mail).
2. **A tab whose rules are all refused or empty** must show nothing and count 0, never fall back to everything. Pinned in Task 3 (empty `rules` scope) and Task 4.
3. **Messy rule input** (`"  Y@Gmail.COM "`, `"client.example."`, `"<k@client.example>"`, blank lines, `"hello"`): normalised or reported line by line, never silently dropped. Pinned in Task 1 (`parseRuleLines`).
4. **Messages with no From, or an address without `@`, during v4 backfill** must not abort the migration. Pinned in Task 2.
5. **JMAP account in the account filter while a tab is active**: empty list with an explanatory note, not "account failed". Pinned in Task 4 (no `failedAccounts`) and Task 6 (note in empty state).

---

## Priority 1: index v4, matcher, SQL filter

### Task 1: Shared split rules in core

**Files:**

- Create: `packages/core/src/split.ts`
- Modify: `packages/core/src/index.ts` (export), `packages/core/src/model.ts` (`Settings`, `MailQuery`), `packages/core/src/schemas.ts` (`querySchema`, `settingsSchema`)
- Modify: `apps/desktop/src/renderer/src/recipient-suggestions.ts` (use `isAutomatedAddress`)
- Test: `tests/split-rules.test.ts`, existing `tests/recipient-suggestions.test.ts` must still pass

**Interfaces:**

- Produces (all exported from `@inlark/core`):
  - `type SplitRule = { kind: 'address'; value: string } | { kind: 'domain'; value: string }` (`value` lowercased; domain without `@`, no trailing dot)
  - `interface SplitTab { id: string; name: string; rules: string[] }`
  - `interface ImportantSettings { always: { address: string; words?: string[] }[]; never: string[] }`
  - `type SplitScope = { kind: 'rules'; addresses: string[]; domains: string[] } | { kind: 'important'; always: { address: string; words: string[] }[]; never: string[] }` (domains here are `domainKey` form)
  - `parseRule(text: string): SplitRule | undefined` — trims, lowercases, strips surrounding `<>` and a trailing `.`; `@host` or bare `host.tld` → domain; `local@host` → address; otherwise `undefined`
  - `formatRule(rule: SplitRule): string` → `name@host` or `@host`
  - `parseRuleLines(text: string, own: string[]): { rules: string[]; problems: { line: number; text: string; reason: string }[] }` — one rule per line, blank lines ignored, duplicates collapsed, each refused or unparseable line reported with its 1-based line number
  - `refusalReason(rule: SplitRule, own: string[]): string | undefined`
  - `isFreeMailDomain(domain: string): boolean` (list: gmail.com, googlemail.com, outlook.com, hotmail.com, hotmail.fr, live.com, live.ca, msn.com, yahoo.com, yahoo.fr, yahoo.ca, ymail.com, icloud.com, me.com, mac.com, aol.com, proton.me, protonmail.com, pm.me, gmx.com, gmx.de, mail.com, zoho.com, yandex.com, fastmail.com, hey.com, videotron.ca, sympatico.ca)
  - `domainKey(domain: string): string` — label-reversed, lowercased
  - `isAutomatedAddress(email: string): boolean` (the rule moved from `recipient-suggestions.ts`)
  - `isAutomatedMessage(m: { fromEmail?: string; unsubscribe?: unknown; listId?: string | null; precedence?: string | null; autoSubmitted?: string | null }): boolean`
  - `ruleMatches(rule: SplitRule, email: string): boolean` (domain matches itself and subdomains)
  - `resolveSplitScope(tabId: string | undefined, settings: Settings, own: string[]): SplitScope | null | undefined` — `undefined` for Inbox/absent; `null` for an unknown id; `'important'` → important scope from `settings.important` (lowercased, words lowercased and trimmed, empty words dropped); a user tab → `rules` scope built from its rules minus refused/unparseable ones
  - `Settings` gains `splitTabs?: SplitTab[]`, `important?: ImportantSettings`, `splitImportOffered?: boolean`; `MailQuery` gains `tab?: string`
  - zod: `querySchema.tab = z.string().min(1).max(64).optional()`; `settingsSchema` adds `splitTabs` (max 50 tabs; `id` 1–64 chars; `name` trimmed 1–60; `rules` max 500 strings ≤ 320), `important` (`always` max 500 of `{address ≤ 320, words?: max 20 strings ≤ 100}`, `never` max 500 strings ≤ 320), `splitImportOffered: z.boolean().optional()`

Refusal reasons (exact copy, `X` is the rule as written):

- address equal to an own address: `X is your own address, so every conversation would match.`
- address or domain inside an own **non-free-mail** domain (e.g. `@work.example`, `ana@work.example`, `@eu.work.example`): `X is on your own domain, so every conversation would match. Tabs are decided by the people you write with.`
- domain that covers any own address (e.g. `@gmail.com` when an account is on Gmail, `@com`): `X includes your own address, so every conversation would match.`

- [ ] **Step 1: Write the failing tests** in `tests/split-rules.test.ts`:

```ts
const own = ['me@work.example', 'x@gmail.com']
it('parses addresses and domains', () => {
  expect(parseRule('  Y@Gmail.COM ')).toEqual({
    kind: 'address',
    value: 'y@gmail.com',
  })
  expect(parseRule('<k@client.example>')).toEqual({ kind: 'address', value: 'k@client.example' })
  expect(parseRule('@Client.Example.')).toEqual({
    kind: 'domain',
    value: 'client.example',
  })
  expect(parseRule('client.example')).toEqual({
    kind: 'domain',
    value: 'client.example',
  })
  expect(parseRule('hello')).toBeUndefined()
  expect(parseRule('a@')).toBeUndefined()
})
it('reports problems line by line', () => {
  const r = parseRuleLines(
    'y@gmail.com\n\n@work.example\nhello\nY@gmail.com',
    own,
  )
  expect(r.rules).toEqual(['y@gmail.com'])
  expect(r.problems.map((p) => p.line)).toEqual([3, 4])
})
it('refuses own addresses and domains but allows free-mail clients', () => {
  expect(refusalReason(parseRule('me@work.example')!, own)).toMatch(/your own address/)
  expect(refusalReason(parseRule('ana@work.example')!, own)).toMatch(/own domain/)
  expect(refusalReason(parseRule('@eu.work.example')!, own)).toMatch(/own domain/)
  expect(refusalReason(parseRule('@gmail.com')!, own)).toMatch(/includes your own address/)
  expect(refusalReason(parseRule('y@gmail.com')!, own)).toBeUndefined()
})
it('matches domains and subdomains only', () => {
  const d = parseRule('@tools.example')!
  expect(ruleMatches(d, 'x@tools.example')).toBe(true)
  expect(ruleMatches(d, 'x@noreply.Tools.example')).toBe(true)
  expect(ruleMatches(d, 'x@nottools.example')).toBe(false)
  expect(domainKey('mail.Client.example')).toBe('example.client.mail')
})
it('detects automated senders', () => {
  for (const e of [
    'no-reply@asana.com',
    'no_reply@x.example',
    'do.not.reply@x.example',
    'bounces+1@x.example',
    'MAILER-DAEMON@x.example',
    'postmaster@x.example',
  ])
    expect(isAutomatedAddress(e)).toBe(true)
  expect(isAutomatedAddress('y@gmail.com')).toBe(false)
  expect(isAutomatedMessage({ fromEmail: 'a@b.example', listId: '<list.b.example>' })).toBe(true)
  expect(isAutomatedMessage({ fromEmail: 'a@b.example', precedence: 'Bulk' })).toBe(true)
  expect(isAutomatedMessage({ fromEmail: 'a@b.example', autoSubmitted: 'no' })).toBe(false)
  expect(isAutomatedMessage({ fromEmail: 'a@b.example', autoSubmitted: 'auto-generated' })).toBe(true)
  expect(
    isAutomatedMessage({ fromEmail: 'a@b.example', unsubscribe: { url: 'x', oneClick: false } }),
  ).toBe(true)
  expect(isAutomatedMessage({ fromEmail: 'a@b.example' })).toBe(false)
})
it('resolves tabs from settings', () => {
  const settings = {
    ...defaultSettings,
    splitTabs: [
      {
        id: 't1',
        name: 'Client A',
        rules: ['Y@gmail.com', '@work.example', '@Client.example'],
      },
    ],
    important: {
      always: [{ address: 'Alerts@X.example', words: [' Crash ', ''] }],
      never: ['Bot@Y.example'],
    },
  }
  expect(resolveSplitScope(undefined, settings, own)).toBeUndefined()
  expect(resolveSplitScope('inbox', settings, own)).toBeUndefined()
  expect(resolveSplitScope('gone', settings, own)).toBeNull()
  expect(resolveSplitScope('t1', settings, own)).toEqual({
    kind: 'rules',
    addresses: ['y@gmail.com'],
    domains: ['example.client'],
  })
  expect(resolveSplitScope('important', settings, own)).toEqual({
    kind: 'important',
    always: [{ address: 'alerts@x.example', words: ['crash'] }],
    never: ['bot@y.example'],
  })
})
it('keeps the new settings and query fields through the schemas', () => {
  expect(querySchema.parse({ view: 'inbox', tab: 'important' }).tab).toBe('important')
  const parsed = settingsSchema.parse({
    ...defaultSettings,
    splitTabs: [{ id: 't', name: 'A', rules: ['@a.example'] }],
    important: { always: [], never: [] },
    splitImportOffered: true,
  })
  expect(parsed.splitTabs).toHaveLength(1)
  expect(parsed.splitImportOffered).toBe(true)
})
```

- [ ] **Step 2: Run** `corepack pnpm exec vitest run tests/split-rules.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `split.ts`, the model fields and schema fields. `recipient-suggestions.ts` imports `isAutomatedAddress` and deletes its local `undeliverable`.
- [ ] **Step 4: Run** `corepack pnpm exec vitest run tests/split-rules.test.ts tests/recipient-suggestions.test.ts tests/core.test.ts` — expect PASS; `corepack pnpm --filter @inlark/core typecheck` and `--filter @inlark/desktop typecheck` clean.
- [ ] **Step 5: Commit** `feat(core): split inbox rules, matcher and automated-sender detection`

### Task 2: Index schema v4 (participants and automation columns)

**Files:**

- Modify: `packages/imap/src/metadata-index.ts` (`NewMessage.automation`), `packages/imap/src/convert.ts` (`metadataQuery`, `toNewMessage`)
- Modify: `apps/desktop/src/main/imap-index/sqlite-index.ts` (migration v4, insert path)
- Test: `tests/split-index.test.ts` (new), `tests/imap-convert.test.ts`, existing `tests/imap-index.test.ts`

**Interfaces:**

- Consumes: `domainKey`, `isAutomatedMessage` from Task 1.
- Produces:
  - `NewMessage.automation?: { listId: string | null; precedence: string | null; autoSubmitted: string | null }` — present means these headers were fetched for this message.
  - `metadataQuery.headers` adds `'list-id'`, `'precedence'`, `'auto-submitted'`; `toNewMessage` always sets `automation` from them (values trimmed, `null` when absent).
  - `SCHEMA_VERSION = 4`. New `messages` columns: `from_email TEXT` (lowercased first From address, or NULL), `list_id TEXT`, `precedence TEXT`, `auto_submitted TEXT`, `headers_checked INTEGER NOT NULL DEFAULT 0`, `automated INTEGER NOT NULL DEFAULT 0`.
  - New table `participants (account_id TEXT NOT NULL, message_seq INTEGER NOT NULL REFERENCES messages (seq) ON DELETE CASCADE, address TEXT NOT NULL, domain TEXT NOT NULL, role TEXT NOT NULL)` with indexes `participants_message (message_seq)`, `participants_address (account_id, address)`, `participants_domain (account_id, domain)`. Roles: `'from'`, `'to'`, `'cc'`. Addresses lowercased; `domain` is `domainKey(part after the last @)`. Addresses without `@` are skipped.
  - Index for Important: `messages_mailbox_sender ON messages (account_id, mailbox_id, from_email)`.

Migration mechanics: let entries of `migrations` be `string | ((db: DatabaseSync) => void)`; the loop calls a function entry with the open db inside the existing per-version transaction. v4 is a function: run the DDL, then one pass over `SELECT seq, account_id, from_addr, to_addr, cc_addr, unsubscribe FROM messages` (iterate, don't load all rows) inserting participants and setting `from_email` and `automated` (address rule plus List-Unsubscribe; other headers unknown yet, `headers_checked = 0`). Malformed JSON in an address column is treated as an empty list. `upsertMessages` insert branch writes the new columns and participants; its update branch, when `message.automation` is given and the row has `headers_checked = 0`, stores the three headers, sets `headers_checked = 1` and recomputes `automated`.

- [ ] **Step 1: Write failing tests** in `tests/split-index.test.ts` (reuse the `folder`/`message` helper shapes from `tests/imap-index.test.ts`, copied locally):
  - `migrates a v3 index and backfills participants`: build a v3 file by opening a fresh index, inserting messages (one with `from: []`, one with an address lacking `@`, one with To and Cc, one with `unsubscribe`, one from `no-reply@asana.com`), then `ALTER TABLE ... DROP`/`DROP TABLE participants` and set `PRAGMA user_version = 3` as the existing migration tests do (copy their technique at `tests/imap-index.test.ts:690-730`). Reopen; assert `user_version` is 4, participants rows per message equal from+to+cc with roles, `domain` is reversed, the no-`@` address has no row, `automated` is 1 exactly for the unsubscribe and no-reply messages, `headers_checked` is 0 everywhere.
  - `stores participants and automation for new mail`: `upsertMessages` with `automation: { listId: '<x>', precedence: null, autoSubmitted: null }` gives `headers_checked = 1`, `automated = 1`; without `automation` gives `headers_checked = 0`.
  - `fills automation on an existing location once`: upsert without `automation`, then again with it; `headers_checked` becomes 1 and `automated` is recomputed.
  - `drops participants with their message`: `removeUids` and `resetMailbox` leave no orphan participant rows (`SELECT count(*) FROM participants WHERE message_seq NOT IN (SELECT seq FROM messages)` is 0).
  - In `tests/imap-convert.test.ts`: `toNewMessage` reads `List-Id`, `Precedence`, `Auto-Submitted` header lines into `automation`, `null` when missing.
    Read rows straight from the file with `new DatabaseSync(path)` after `index.close()`, as the existing migration tests do.
- [ ] **Step 2: Run** `corepack pnpm exec vitest run tests/split-index.test.ts tests/imap-convert.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the migration, insert/update paths and converter changes. Update the existing `SCHEMA_VERSION` expectations in `tests/imap-index.test.ts` only if they hardcode 3 (they import the constant).
- [ ] **Step 4: Run** `corepack pnpm exec vitest run tests/split-index.test.ts tests/imap-convert.test.ts tests/imap-index.test.ts tests/imap-provider.test.ts tests/service-imap.test.ts` — PASS; desktop and imap typecheck clean.
- [ ] **Step 5: Commit** `feat(imap-index): schema v4 with participants and automated-sender columns`

### Task 3: Tab filter in SQL, with paging, counts and query plans

**Files:**

- Modify: `packages/imap/src/metadata-index.ts` (`ConversationFilter.split`, `MetadataIndex.tabCounts`)
- Modify: `apps/desktop/src/main/imap-index/sqlite-index.ts` (`conversationSource`, `tabCounts`, `methodTable`), `apps/desktop/src/main/imap-index/client.ts` (wrapper)
- Test: `tests/split-index.test.ts`

**Interfaces:**

- Consumes: `SplitScope` (Task 1), v4 tables (Task 2).
- Produces:
  - `ConversationFilter.split?: SplitScope` — only valid with exactly one `mailboxIds` entry (the inbox); otherwise `conversationSource` throws `'A tab needs the inbox scope.'`.
  - `MetadataIndex.tabCounts(accountId: string, inboxId: string, scopes: Record<string, SplitScope>): Promise<Record<string, { conversations: number; unread: number }>>` — one SQL statement (a `UNION ALL` of one `SELECT` per scope over a materialised CTE of the inbox's rows). `conversations` = distinct threads with an inbox message; `unread` = distinct `coalesce(email_id, id)` among unseen inbox messages. Empty `scopes` returns `{}` without querying.

SQL shape (the implementer writes it; these are the decisions):

- Rules scope → `m.thread_id IN (SELECT t.thread_id FROM participants p JOIN messages t ON t.seq = p.message_seq WHERE p.account_id = ? AND (p.address IN (SELECT value FROM json_each(?)) OR <one range term per domain>))`. A rules scope with no addresses and no domains → the filter matches nothing (return `null` from `conversationSource`, as it does for an empty `mailboxIds`).
- Important scope → `m.thread_id IN (SELECT t.thread_id FROM messages t WHERE t.account_id = ? AND t.mailbox_id = <inbox> AND (t.automated = 0 OR <always>) AND (t.from_email IS NULL OR t.from_email NOT IN (SELECT value FROM json_each(?))))`, where `<always>` is `t.from_email IN (...)` for entries without words plus `(t.from_email = ? AND (instr(lower(t.subject), ?) > 0 OR ...))` per entry with words. A message with no From counts as a person unless automated by headers.
- Keep the predicate in `WHERE` before `GROUP BY`, so `total`, keyset `after`, and `offset` paging work unchanged.

- [ ] **Step 1: Write failing tests** (fixture: INBOX + Archive + Sent; threads built with `references`):
  - `rules tab matches any participant on any message of the thread`: thread A inbox message from `julia@client.example`; thread B inbox message from a colleague with `cc: julia@mail.client.example`; thread C whose inbox message is from a work colleague but an archived message in the same thread is from `y@gmail.com`; thread D only archived (no inbox message) from the client person; thread E from `x@notclient.example`. Scope `{kind:'rules', addresses:['y@gmail.com'], domains:[domainKey('client.example')]}` → threads A, B, C; total 3.
  - `Gmail duplicates count once`: the same email (same `emailId`) in INBOX and `[Gmail]/All Mail`, unseen; `tabCounts` unread = 1, conversations = 1.
  - `important leaves out automated mail and honours always and never`: inbox threads from a person, from `no-reply@asana.com`, from a sender with `unsubscribe`, from `alerts@crashlytics.com` subject "New crash in app" and another subject "Weekly digest", and from `colleague@work.example`; scope always `[{address:'alerts@crashlytics.com', words:['crash','failure']}]`, never `['colleague@work.example']` → only the person thread and the crash thread.
  - `important looks only at inbox messages`: a thread whose inbox message is automated but whose Sent message is from Khyati is not in Important.
  - `pages a tab with keyset and offset`: 120 matching inbox threads; page of 50, then `after` cursor, then `offset: 100`: no duplicates, union = all 120, `total` 120 on every page.
  - `an empty rules scope matches nothing`: `{kind:'rules', addresses:[], domains:[]}` → `{ items: [], total: 0 }`; `tabCounts` gives `{conversations: 0, unread: 0}`.
  - `tab counts in one call`: `tabCounts` for two rules scopes and Important equals `conversations(...).total` for each and the expected unread numbers.
  - `split needs the inbox scope`: `conversations('a', { split }, ...)` without a single mailbox throws.
  - `tab queries stay indexed on a large mailbox` (extend the 50k-message idea from `tests/imap-index.test.ts:735`, timeout 60 s): vary senders across 200 domains and 2,000 addresses, 40% of messages in INBOX; for a rules scope with 3 addresses and 2 domains and for an Important scope, `explainConversations` details contain no `SCAN p`, no `SCAN m` and no `SCAN t`, and mention `participants_address` or `participants_domain` for the rules scope.
- [ ] **Step 2: Run** `corepack pnpm exec vitest run tests/split-index.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `split` in `conversationSource`, `tabCounts`, the `methodTable` entry and the worker client wrapper.
- [ ] **Step 4: Run** the same file plus `tests/imap-index.test.ts` — PASS. Then measure: add `tests/split-bench.test.ts` with `describe.skipIf(!process.env.INLARK_BENCH)` that builds a 100k-message fixture (40k in INBOX), and prints (via `console.log`, numbers only, no addresses) the median of 20 runs for: Inbox first page, a rules tab first page, Important first page, a deep keyset page, `tabCounts` for 7 tabs + Important, and the v3→v4 migration time. Run `INLARK_BENCH=1 corepack pnpm exec vitest run tests/split-bench.test.ts` and record the numbers in the commit message body. A tab page must be within 2× of the Inbox page time and under 50 ms; if not, try the correlated `EXISTS` form and keep whichever is faster, noting why in a code comment.
- [ ] **Step 5: Commit** `feat(imap-index): filter conversations by tab in SQL with grouped tab counts`

### Task 4: Main-process wiring (query, counts, match count, IPC)

**Files:**

- Create: `apps/desktop/src/main/split-inbox.ts`
- Modify: `packages/core/src/model.ts` (`ProviderQuery`, `MailProvider.query` parameter type, optional `MailProvider.tabCounts`, `DesktopMailAPI`), `packages/core/src/schemas.ts` (`ipcSchemas`)
- Modify: `packages/imap/src/provider.ts` (`query`, `tabCounts`)
- Modify: `apps/desktop/src/main/service.ts` (`query`, new thin methods), `apps/desktop/src/main/index.ts` (handlers), `apps/desktop/src/preload/index.ts` (method names), `apps/desktop/src/renderer/src/demo.ts` (demo implementations)
- Test: `tests/split-service.test.ts`

**Interfaces:**

- Consumes: Task 1 `resolveSplitScope`, `refusalReason`, `parseRule`; Task 3 `ConversationFilter.split`, `MetadataIndex.tabCounts`.
- Produces:
  - `interface ProviderQuery extends MailQuery { split?: SplitScope }`; `MailProvider.query(account, query: ProviderQuery, position?, limit?)`.
  - `MailProvider.tabCounts?(account: Account, scopes: Record<string, SplitScope>): Promise<Record<string, { conversations: number; unread: number }>>`. `ImapProvider` applies `split` only when its scope resolves to the inbox (view `inbox`, no `mailboxId`, no search fields); otherwise ignores it. `ImapProvider.tabCounts` finds the INBOX box and calls the index; no INBOX → zeros.
  - `split-inbox.ts`: `ownAddresses(accounts: Account[]): string[]` (emails + alias emails, lowercased, unique); `resolveTab(settings, accounts, tab?: string): SplitScope | null | undefined` (wraps `resolveSplitScope`).
  - `DesktopMailAPI` additions (each with an `ipcSchemas` entry, a preload name, an `index.ts` handler and a `demo.ts` implementation):
    - `tabCounts(accountId?: string): Promise<Record<string, number>>` — unread for `'important'` and every user tab id, summed over connected IMAP accounts (narrowed by `accountId`). Schema `z.tuple([id.optional()])`.
    - `tabMatchCount(rules: string[]): Promise<number>` — conversations in the inbox matching these rules (parsed and refusal-filtered as in `resolveSplitScope`), summed over IMAP accounts. Schema `z.tuple([z.array(z.string().max(320)).max(500)])`.
  - `service.query`: when `query.tab` resolves to a scope and `query.view === 'inbox'` and no `mailboxId`/`text`: IMAP accounts get `{ ...query, split }`; JMAP accounts are skipped (contribute nothing, not listed in `failedAccounts`). `null` (unknown tab) → `{ items: [], total: 0, failedAccounts: [] }`. `mutateAll` inherits this through `query`.

- [ ] **Step 1: Write failing tests** in `tests/split-service.test.ts`, building the service the way `tests/service-imap.test.ts` does (fake IMAP server from `tests/support/fake-imap.ts`, two IMAP accounts where it already supports that; otherwise one IMAP plus a fake JMAP provider as in `tests/service.test.ts`):
  - `a tab query returns only matching inbox conversations`, with `settings.splitTabs` holding `@client.example`.
  - `an own-domain rule never decides a tab`: tab rules `['@work.example']` with account email `me@work.example` → empty.
  - `an unknown tab id is empty, never all mail`.
  - `JMAP accounts are skipped in tabs without failing`: page has no JMAP items and `failedAccounts` is `[]`; the Inbox (no tab) still includes them.
  - `tab counts and match counts sum across accounts`, unread numbers as expected, keys `'important'` and each tab id.
  - `archive all in a tab archives only that tab's conversations` via `mutateAll({ view: 'inbox', tab }, 'archive')`.
- [ ] **Step 2: Run** `corepack pnpm exec vitest run tests/split-service.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Keep `service.ts` additions to a few lines each, delegating to `split-inbox.ts`. Demo: `tabCounts` and `tabMatchCount` compute from the demo conversations with `ruleMatches` and `isAutomatedAddress`; demo `query` honours `tab` the same way.
- [ ] **Step 4: Run** `corepack pnpm exec vitest run tests/split-service.test.ts tests/service.test.ts tests/service-imap.test.ts tests/imap-provider.test.ts` — PASS; core, imap and desktop typecheck clean.
- [ ] **Step 5: Commit** `feat: resolve inbox tabs in the main process and expose tab counts`

## Priority 2: the tab row

### Task 5: Tab model, route parameter and shortcuts

**Files:**

- Create: `apps/desktop/src/renderer/src/split/tab-model.ts`
- Modify: `apps/desktop/src/renderer/src/main.tsx` (`RouteSearch.tab`, `validateSearch`), `apps/desktop/src/renderer/src/shortcuts.tsx`
- Test: `tests/split-tabs.test.ts`, `tests/shortcuts.test.ts`

**Interfaces:**

- Produces:
  - `interface TabEntry { id: string; name: string; user: boolean }`
  - `tabEntries(settings: Settings): TabEntry[]` → Inbox, Important, then `splitTabs` in order
  - `activeTabId(routeTab: string | undefined, entries: TabEntry[]): string` → the route's id if it exists, else `'inbox'`
  - `tabForShortcut(n: number, entries: TabEntry[]): string | undefined` (n = 1–9)
  - `adjacentTab(current: string, entries: TabEntry[], step: 1 | -1): string` (wraps around)
  - `moveTab(tabs: SplitTab[], id: string, toIndex: number): SplitTab[]` (index among user tabs; clamps)
  - `RouteSearch.tab?: string`, kept by `validateSearch` so back and forward follow tabs. The last-location restore on launch does **not** restore `tab`: Inbox always opens on launch (spec decision 4).
  - Shortcut section `'Tabs'` (after `'Go to'`) with ids `goTab1`…`goTab9` (defaults `Mod+1`…`Mod+9`; labels `Inbox tab`, `Important tab`, `Tab 3`…`Tab 9`), `nextTab` (`Control+Tab`), `previousTab` (`Control+Shift+Tab`), `addToTab` (section `'Organize'`, label `Add sender to tab…`, default `Shift+T`).

- [ ] **Step 1: Write failing tests:**
  - `tests/split-tabs.test.ts`: `tabEntries` order; `activeTabId('deleted-id', entries)` is `'inbox'`; `tabForShortcut(3, …)` is the first user tab and `tabForShortcut(9, …)` is `undefined` with three user tabs; `adjacentTab` wraps both ways; `moveTab` reorders and clamps.
  - `tests/shortcuts.test.ts`: every new default is valid (`validateHotkey`) and `findConflicts` finds none against the existing defaults; rebinding `goTab3` to `Mod+Shift+3` survives `overridesFor`/`resolveShortcuts`.
- [ ] **Step 2: Run** `corepack pnpm exec vitest run tests/split-tabs.test.ts tests/shortcuts.test.ts` — FAIL.
- [ ] **Step 3: Implement.** If `Control+Tab` is rejected by `validateHotkey`, use the spelling the library accepts for the Ctrl key on every platform and note it in the test.
- [ ] **Step 4: Run** the same — PASS; desktop typecheck clean.
- [ ] **Step 5: Commit** `feat(desktop): tab model, tab route parameter and tab shortcuts`

### Task 6: TabRow in the list, with counts, keyboard and drag to reorder

**Files:**

- Create: `apps/desktop/src/renderer/src/split/TabRow.tsx`, `apps/desktop/src/renderer/src/split/useSplitInbox.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx` (call the hook, render `TabRow` under the list heading, put `tab` in `query`, add `'tabCounts'` to `refresh`'s keys, shortcut handlers, tab-aware empty state)
- Test: typecheck plus manual check in dev (no DOM test environment)

**Interfaces:**

- Consumes: Task 5 model and shortcut ids; Task 4 `api.tabCounts`.
- Produces:
  - `useSplitInbox({ settings, accounts, route, go, inboxUnread, notify, saveSettings })` returning `{ entries, active, counts, visible, select(id), saveTabs(tabs), shortcutHandlers, commands }`. `visible` is true only for `view === 'inbox'` with no `folder` and no `q`. `counts` = `{ inbox: inboxUnread, ...api.tabCounts(route.account) }` via `useQuery({ queryKey: ['tabCounts', route.account, tabsKey] })`, where `tabsKey` is a JSON of the tabs and Important lists so edits refetch. `saveSettings(patch)` saves through `api.settings({ ...settings, ...patch })` and writes the result into the `['bootstrap']` query data, as `Settings.tsx` `update` does.
  - `select(id)` → `go({ view: 'inbox', account: route.account, tab: id === 'inbox' ? undefined : id })`.
  - `<TabRow entries active counts onSelect onReorder onMenu onAdd />`.

TabRow behaviour:

- `role="tablist"`, each tab a `button role="tab"` with `aria-selected`, roving `tabIndex`; ArrowLeft/ArrowRight/Home/End move focus; Enter/Space select; `ContextMenu` key or Shift+F10 opens that tab's menu (Task 7 fills it).
- Look: `SegmentedControl`'s option tokens (h-7.5, 12px, `text-muted`, chosen `bg-selected text-strong font-medium`); unread count after the name in `text-faint` tabular numerals, hidden at 0; row scrolls horizontally without a visible scrollbar when it overflows; a trailing "+" `IconButton` labelled "New tab".
- User tabs are `draggable`; dropping onto another user tab moves it there via `moveTab`; Inbox and Important neither drag nor accept drops. A drop indicator (2px `bg-primary` bar) shows where it lands.
- Shortcuts: `goTab1…9`, `nextTab`, `previousTab` registered with `ignoreInputs: ignoreInputsForCommand`, enabled when the row is visible or (for `goTab*`) from any view: `goTab*` goes to the Inbox view with that tab.
- Empty state in a tab: title `Nothing in <name>`, description `Conversations in your inbox from this tab's people show here.` (Important: `Mail from people in your inbox shows here.`). When any account in scope is JMAP, add the line `<account name> isn't included in tabs yet. Its mail is in Inbox.`

- [ ] **Step 1: Implement** `useSplitInbox.ts` and `TabRow.tsx`; wire into `App.tsx` with the fewest lines possible (one hook call, one element, `tab` in the `query` memo and its deps, one key in `refresh`, spread `shortcutHandlers` into the existing `useShortcutHandlers` call, a tab branch in the empty state).
- [ ] **Step 2: Run** desktop typecheck, `corepack pnpm exec vitest run` (whole suite) — expect PASS (611+ passed).
- [ ] **Step 3: Manual check** with `env -u ELECTRON_RUN_AS_NODE corepack pnpm --filter @inlark/desktop dev` (or the demo mode if no account is set up): the row shows in Inbox only; Ctrl+1/2, Ctrl+Tab/Ctrl+Shift+Tab switch; back/forward follows tabs; dragging a user tab reorders and persists after restart; the account filter narrows tabs.
- [ ] **Step 4: Commit** `feat(desktop): inbox tab row with unread counts, shortcuts and drag to reorder`

## Priority 3: creating and editing tabs

### Task 7: Tab editor ("+" box, edit rules, rename, delete) with live match count

**Files:**

- Create: `apps/desktop/src/renderer/src/split/TabEditor.tsx`
- Modify: `apps/desktop/src/renderer/src/split/TabRow.tsx` (tab menu), `apps/desktop/src/renderer/src/split/useSplitInbox.ts` (editor state, commands for the active tab)
- Test: `tests/split-tabs.test.ts`

**Interfaces:**

- Consumes: `parseRuleLines` (Task 1), `api.tabMatchCount` (Task 4), `moveTab` (Task 5).
- Produces: `<TabEditor open tab? own onSave(tab: SplitTab) onClose focus?: 'name' | 'rules' />`; pure `editorState(name: string, rulesText: string, own: string[], existing: SplitTab[], editingId?: string): { rules: string[]; problems: …; nameError?: string; canSave: boolean }` in `tab-model.ts` (name required, max 60, unique case-insensitively among user tabs, and not `Inbox`/`Important`).

Behaviour:

- `Modal` titled `New tab` or `Edit <name>`: name field, then a textarea "Addresses and domains, one per line" with placeholder `y@gmail.com\n@client.example`. Problems list under the textarea (`Line 3: …reason`). Below it, live: `Matches 12 conversations in your inbox` (debounced 300 ms; `Checking…` while loading; hidden when there are no valid rules).
- Tab menu (right-click, the keyboard keys from Task 6, and Ctrl+K commands `Edit tab rules`, `Rename tab`, `Delete tab`, `Move tab left`, `Move tab right` for the active user tab): items Edit rules…, Rename…, Move left, Move right, Delete tab. Delete asks `Delete the tab “<name>”? Its rules are removed. No mail is moved or deleted.` and returns to Inbox if it was active. If `Dropdown` can't be opened programmatically, add optional `open`/`onOpenChange` props to `Dropdown` in `packages/ui/src/index.tsx` (pass-through to `Menu.Root`), nothing else.

- [ ] **Step 1: Write failing tests** for `editorState`: duplicate name refused; `Inbox` refused; refused rule reported and `canSave` false while any problem exists; valid input yields normalised rules.
- [ ] **Step 2: Run** `corepack pnpm exec vitest run tests/split-tabs.test.ts` — FAIL.
- [ ] **Step 3: Implement** the editor, menu and commands.
- [ ] **Step 4: Run** tests and desktop typecheck — PASS. Manual: create a tab with "+", see the match count change while typing, rename, delete; all from the keyboard too.
- [ ] **Step 5: Commit** `feat(desktop): create, edit, rename and delete inbox tabs`

### Task 8: "Add sender to tab…" from an email

**Files:**

- Create: `apps/desktop/src/renderer/src/split/AddToTab.tsx`
- Modify: `apps/desktop/src/renderer/src/Reader.tsx` (one optional prop and one menu item), `apps/desktop/src/renderer/src/App.tsx` (pass the prop, `addToTab` shortcut handler via the hook), `useSplitInbox.ts` (command `Add sender to tab…`)
- Test: `tests/split-tabs.test.ts`

**Interfaces:**

- Produces:
  - `senderOf(messages: Pick<Message, 'from' | 'receivedAt'>[], own: string[]): Address | undefined` — From of the newest message not sent by an own address.
  - `addRule(tabs: SplitTab[], target: { id?: string; name?: string }, rule: string): { tabs: SplitTab[]; tabId: string; already: boolean }` — appends to an existing tab, or creates a tab named `name` with that rule; `already` when the tab had it.
  - `Reader` prop `onAddToTab?: () => void` rendering `MenuItem` "Add sender to tab…" with `<ShortcutHint id="addToTab" />`.
- Behaviour: the picker is a small `Modal` titled `Add <name or address> to a tab`: a text field (autofocus) filtering the tab list; first option `New tab “<typed>”` when the text matches no tab name (or `New tab…` when empty, which opens Task 7's editor prefilled with the rule); arrow keys + Enter pick, mouse click picks. A checkbox `Add everyone at @<domain> instead`, shown only when the domain is not free mail and not refused. Refused senders show the refusal reason instead of the list. Success toast: `Added <address> to <tab>` (or `Already in <tab>`). Works on the open conversation, or the focused one in the list (Shift+T, Ctrl+K).

- [ ] **Step 1: Write failing tests** for `senderOf` (skips own, picks newest) and `addRule` (new tab, existing tab, duplicate).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** tests + typecheck — PASS; manual: Shift+T in the list and in the reader, menu item, Ctrl+K command, whole-domain checkbox hidden for a gmail.com sender.
- [ ] **Step 5: Commit** `feat(desktop): add a sender or their domain to a tab from an email`

## Priority 4: Important

### Task 9: Background header fetch for existing inbox mail

**Files:**

- Modify: `packages/imap/src/metadata-index.ts` (two methods), `apps/desktop/src/main/imap-index/sqlite-index.ts`, `apps/desktop/src/main/imap-index/client.ts`, `packages/imap/src/provider.ts` (job in `syncLoop`), `tests/support/fake-imap.ts` (serve arbitrary header lines)
- Test: `tests/split-index.test.ts`, `tests/imap-provider.test.ts`

**Interfaces:**

- Produces:
  - `MetadataIndex.uncheckedHeaders(accountId: string, mailboxId: string, limit: number): Promise<{ uid: number; uidValidity: string }[]>` — newest first, `headers_checked = 0`.
  - `MetadataIndex.setAutomationHeaders(accountId: string, mailboxId: string, rows: { uid: number; listId: string | null; precedence: string | null; autoSubmitted: string | null }[]): Promise<void>` — stores headers, sets `headers_checked = 1`, recomputes `automated`.
  - `ImapProvider` private `checkHeaders()`: after `syncPass` and before `prefetchBodies` in `syncLoop`; for the INBOX box, batches of 500 as background tasks (`this.run(…, true)`): `select`, `fetch(uidSet, { headers: ['list-id', 'precedence', 'auto-submitted'] })`, then `setAutomationHeaders` for every requested UID (missing ones with nulls). Stops when `this.pending !== 'none'` or on disposal; emits `{ type: 'changed', historical: true }` once if anything was written. Skips rows whose `uidValidity` no longer matches the selected one.
- [ ] **Step 1: Write failing tests:** index methods round trip (a List-Id makes `automated` 1; nulls keep it 0 for a person); provider test: an INBOX of 3 indexed messages without headers, the fake server serving `List-Id` for one, after one sync loop the Important query excludes that one; a second loop fetches nothing.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (extend the fake's message type with `headers?: Record<string, string>` and emit requested lines). **Step 4: Run** `tests/split-index.test.ts tests/imap-provider.test.ts tests/service-imap.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(imap): fetch list and auto-submitted headers for inbox mail in the background`

### Task 10: "Always show" and "Never show" in Important from an email

**Files:**

- Create: `apps/desktop/src/renderer/src/split/ImportantException.tsx`
- Modify: `Reader.tsx` (two optional props, two menu items), `App.tsx` (pass props), `useSplitInbox.ts` (commands, state)
- Test: `tests/split-tabs.test.ts`

**Interfaces:**

- Produces: pure `setAlways(important: ImportantSettings | undefined, address: string, words: string[]): ImportantSettings` (replaces an entry for the same address; removes it from `never`), `setNever(important, address, on: boolean): ImportantSettings` (removes it from `always` when turning on), `parseWords(text: string): string[]` (comma-separated, trimmed, lowercased, empties dropped, max 20).
- Reader menu items: `Always show in Important…` (or `Edit Always show…` when present) and `Never show in Important` / `Show in Important again`. The Always dialog: sender shown read-only; field `Only when the subject contains` (comma-separated, optional), hint `Leave empty to always show this sender.` Never is immediate with a toast `<address> won't show in Important` and an Undo that restores the previous settings. Both also in Ctrl+K for the open conversation's sender.
- [ ] **Step 1: Failing tests** for `setAlways`, `setNever`, `parseWords`. **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** + typecheck — PASS; manual: a newsletter let in with words shows only on matching subjects.
- [ ] **Step 5: Commit** `feat(desktop): always and never show a sender in Important`

## Priority 5: settings, export and import

### Task 11: Settings → Inbox with export and import

**Files:**

- Create: `apps/desktop/src/renderer/src/split/InboxSettings.tsx`
- Modify: `Settings.tsx` (nav entry `['inbox', 'Inbox', Inbox]` after General, one render line), `split-inbox.ts` (dialogs), `service.ts`, `index.ts`, preload, `model.ts`, `schemas.ts`, `demo.ts`, `packages/core/src/split.ts` (`inboxExport`, `parseInboxExport`)
- Test: `tests/split-rules.test.ts`, `tests/split-service.test.ts`

**Interfaces:**

- Produces:
  - `type InboxExport = { version: 1; tabs: { name: string; rules: string[] }[]; important: { always: { sender: string; subjectWords?: string[] }[]; never: string[] } }` (the design's "Export file format"); `inboxExport(settings: Settings): InboxExport`; `parseInboxExport(text: string): InboxExport` (throws `Error('This file isn’t a Warpmail inbox export.')` on bad JSON, wrong version, or schema failure; validated with a zod schema reusing the `settingsSchema` pieces).
  - `DesktopMailAPI.exportInbox(): Promise<boolean>` (save dialog, default name `warpmail-inbox.json`, written with mode `0o600`; `false` when cancelled) and `importInbox(): Promise<InboxExport | undefined>` (open dialog, refuse files over 1 MB, parse; `undefined` when cancelled). Schemas `z.tuple([])`. `exportInbox` reads the service's current settings.
  - Inbox settings sections: **Tabs** (each user tab: name, rule count, Edit… opening Task 7's editor, Delete; "New tab" button); **Always show in Important** (address, words, edit words inline, remove); **Never show in Important** (list with remove, plus an add field that validates with `parseRule` as an address); **Move to another computer** (Export…, Import…). Import adds tabs, merging rules into a tab of the same name (case-insensitive), never deletes anything: new tabs get fresh ids; an Always entry for an existing sender merges its words (an entry without words means always and wins); imported entries that would conflict with a local Always/Never are skipped and counted. No replace confirmation; a toast says what was added.
- [ ] **Step 1: Failing tests:** `parseInboxExport(JSON.stringify(inboxExport(settings)))` round trip; rejects `{}` and invalid JSON; service `exportInbox` writes a file that `importInbox` reads back (mock `electron` `dialog` as `tests/electron.stub.ts` allows).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** + typecheck — PASS; manual: export, change a tab, import, see it restored.
- [ ] **Step 5: Commit** `feat(desktop): Settings → Inbox with export and import`

### Task 12: One-time starting-tabs offer

Dropped: the design (decision 18, changed 2026-11-05) replaced the one-time offer with importing a private file through Task 11.

### Task 13: Final verification and report

- [ ] Run `corepack pnpm exec vitest run` (re-run the known flaky JMAP test and `tests/reader-body.test.ts` alone if they fail), all typechecks (`@inlark/core`, `@inlark/imap`, `@inlark/ui` if touched, `@inlark/desktop`), and `corepack pnpm exec prettier --check` on every changed file.
- [ ] Re-run the bench (`INLARK_BENCH=1 …split-bench.test.ts`) and record numbers.
- [ ] Whole-branch review against the spec, then report per the brief (head hash, done/left by priority, check numbers, differences from the design, manual test checklist).
