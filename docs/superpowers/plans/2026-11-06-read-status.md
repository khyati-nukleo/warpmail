# Read status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, per recipient of each email Khyati sends, whether it was opened (Opened / Delivered to Apple Mail, can't tell / No signal yet), using a 1×1 image per recipient served by her own Cloudflare Worker.

**Architecture:** A dependency-free Worker (`services/read-status-worker/`) serves the image and hands out records behind a password. Sending builds one MIME copy per recipient (identical headers, own image), sends them over one SMTP session with per-recipient journal progress, then replaces Gmail's merged Sent copy with one clean copy. The main process polls the Worker into its own store file and answers lookups by recomputing each recipient's keyed-hash code; the renderer derives statuses (including replies) and shows them under sent emails, as an eye in the list, and as a switch in the composer.

**Tech Stack:** TypeScript, Electron, React 19, TanStack Query, zod, nodemailer `smtp-connection` + `mail-composer`, imapflow, Vitest (node environment), plain-JS Cloudflare Worker with D1.

**Spec:** [docs/superpowers/specs/2026-11-05-read-status-design.md](../specs/2026-11-05-read-status-design.md). Also binding: roadmap Constraints and Anti-goals (`docs/superpowers/specs/2026-11-03-warpmail-roadmap-design.md`), `AGENTS.md`, and the briefs `docs/superpowers/briefs/2026-11-06-read-status-brief.md` and `2026-11-06-parallel-sessions.md` (ownership of shared files).

## Global Constraints

- Work only in `/home/khyati/me/warpmail-read-status` on `feat/read-status`. Never push, merge or rebase during tasks (the final rebase is done by the controller).
- Ownership (parallel-sessions note): we own the send flow (`service.ts` journal/send, `prepareSubmission`/`submit`/`fileSentCopy` in `provider.ts`, `smtp.ts`, `composeMime`), `Reader.tsx` and `remote-image.ts`. In shared files (`Composer.tsx`, `ConversationRow.tsx`, `Settings.tsx`, `model.ts`, `schemas.ts`, `preload/index.ts`, `main/index.ts`, `demo.ts`, `App.tsx`, `tests/support/fake-imap.ts`) add **one small block** each, with a one-line comment `// Read status` where a comment fits. Never touch the SQLite index schema (`apps/desktop/src/main/imap-index/`) or Gmail label code.
- The Worker lives in `services/read-status-worker/`: plain JavaScript ES modules, **no dependencies, no package.json in the pnpm workspace** (no `pnpm-workspace.yaml` change, no lockfile change). Its tests live in the root `tests/` folder so the root vitest runs them.
- No new dependencies anywhere.
- Privacy: never log codes together with recipients, subjects, addresses or bodies; `MailService.log(event, state)` only with fixed strings. The Worker never stores or logs IPs and never calls `console.log`.
- Public repo: only `example.com`/`example.org` addresses, made-up codes, `https://read.example.com` as a Worker address and `test-password` style secrets in code, tests, docs and commits.
- Copy (exact): statuses `Opened`, `Delivered to Apple Mail, can't tell`, `No signal yet`; composer `Read status: on` / `Read status: off`; Settings section title `Read status`.
- Constants (exact): records deleted after **90 days**; polling every **2 minutes** (120 000 ms) while running, at launch, and on settings change; fetches **less than 60 s** after the last counted one are not counted again; image is a 1×1 transparent GIF.
- Keep inlark's look: 11–12px muted text (`text-muted`, `text-secondary`), existing `Button`, `IconButton`, `Switch`/toggle and input components from `@inlark/ui`; icons from `@inlark/ui/icons` (lucide `Eye`).
- Sending stays honest and fast: the composer's "Sending…" lasts until every copy is accepted or settled; "Sent" only when all were accepted.
- Commands: `corepack pnpm exec vitest run <files>`; `corepack pnpm --filter @inlark/desktop typecheck` plus `--filter @inlark/core` / `--filter @inlark/imap` when touched; `corepack pnpm exec prettier --check <files>` (use `--write` to fix).
- Each commit: run the `engineering-skills:pre-commit-security` check (its script with `bash`), conventional-commit subject (`feat(read-status): …`, `test(…)`, `docs(…)`), never stage `docs/superpowers/briefs/`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions this plan makes (the spec leaves them open)

- **Storage: D1, not KV.** KV's free tier allows 1 000 list operations a day; two laptops polling every 2 minutes need ~1 440. D1 reads only new rows by an autoincrement id cursor.
- **Tracked marker in the Message-ID.** A tracked email's Message-ID is `<uuid>.<tag>@<domain>` where `tag` = first 10 hex chars of `HMAC-SHA256(password, "message:" + uuid)`. Either laptop can tell a tracked email from the Message-ID alone (no header fetch, no index change, nothing stored), and to anyone without the password it looks random. Untracked emails keep `<uuid>@<domain>`.
- **Image code** = `base64url(HMAC-SHA256(password, messageId + "\n" + recipient.trim().toLowerCase()))`, first 22 chars. Changing the password hides statuses of older emails (said in Settings).
- **The clean Sent copy keeps the Bcc header**, so the other laptop can compute Bcc recipients' codes from the Sent copy. Recipient copies never carry Bcc.
- **Never tracked, in addition to the design:** signed emails (the signature covers the body, so per-recipient copies can't be made from one signed message); emails with no HTML body; more than **25** recipients (25 transactions is the most that stays quick); providers without per-copy sending (JMAP). Automated recipients (`isAutomatedAddress`) get their own copy without an image; if every recipient is automated the email is untracked.
- **Partial outcomes.** A copy is `accepted`, `rejected` (server refused), `uncertain` (connection ended during DATA) or `notSent` (never transmitted). All accepted → `sent`. Some accepted → `partial`: `rejected` lists refused and not-sent recipients (the existing "recover refused recipients" draft covers them); uncertain ones are listed in `unconfirmed` and excluded from recovery, so nobody can get it twice. None accepted: any uncertain → `uncertain`; otherwise `rejected` (nothing left the device or everything was refused). After a dropped connection the remaining copies are `notSent`; no automatic reconnect.
- **Crash recovery.** Before each copy the journal is persisted with that copy `sending`. On restart a `submitting` journal with copies maps `sending` → `uncertain`, `pending` → `notSent`, then settles as above.
- **No keyboard shortcut for the composer switch** (the parallel-sessions note says read status needs none); it is a focusable button, so Tab + Enter/Space toggles it.
- **Apple and Google detection.** A fetch is `apple` when its IP is in Apple's ranges or `request.cf.asn` is 714 or 6185; `google` when the User-Agent contains `GoogleImageProxy` or the IP is in Google's ranges; otherwise `other`. Ranges live in `services/read-status-worker/src/ranges.js`, regenerated by `scripts/update-ranges.mjs` from Google's `goog.json` (Apple's list is hand-kept with its source in a comment).
- **Counting.** Non-Apple fetches sorted by time; a fetch counts when it is ≥ 60 000 ms after the previous counted one. Apple fetches never count; they only make "Delivered to Apple Mail".
- **Reply = opened** when the conversation has a message from that recipient received after the sent email.

## File Structure

| File                                                                                                                   | Responsibility                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/read-status-worker/src/index.js` (new)                                                                       | Worker `fetch` (`/p/<code>.gif`, `/records`) and `scheduled` (90-day clean-up); creates its D1 table on first use                                                                                                          |
| `services/read-status-worker/src/classify.js`, `ranges.js` (new)                                                       | CIDR matching (IPv4/IPv6), `classify(ip, userAgent, asn)`                                                                                                                                                                  |
| `services/read-status-worker/wrangler.toml`, `README.md`, `scripts/update-ranges.mjs` (new)                            | Deploy config with placeholders; step-by-step setup; range refresh                                                                                                                                                         |
| `tests/support/fake-d1.ts` (new), `tests/read-status-worker.test.ts` (new)                                             | D1 stand-in on `node:sqlite`; Worker tests                                                                                                                                                                                 |
| `packages/core/src/read-status.ts` (new), `index.ts`                                                                   | Pure rules: settings type, `workerBase`, `pixelUrl`, `isWorkerImage`, `addPixel`, `stripPixels`, `trackingBlock`, `trackedRecipients`, `countOpens`, `recipientStatus`, `replyTimes`; IPC types                            |
| `packages/core/src/model.ts`, `schemas.ts`                                                                             | `Settings.readStatus`, `Draft.readStatus`, `OutgoingMessage.copies/replaceServerCopies`, `CopyOutcome`, `SubmissionTracking`, `MailProvider.submitCopies?`, `DesktopMailAPI` methods, `AppEvent` `readStatus`, zod schemas |
| `apps/desktop/src/main/read-status/codes.ts`, `secret.ts`, `tracked-send.ts`, `worker-client.ts`, `collector.ts` (new) | HMAC codes and tracked Message-IDs; password in secure storage; copy-outcome settling; Worker HTTP; polling + records store + lookups                                                                                      |
| `packages/imap/src/provider.ts`, `smtp.ts`, `port.ts`, `sent-replace.ts` (new)                                         | Per-recipient MIME; one-session copies; Gmail Sent-copy replacement                                                                                                                                                        |
| `apps/desktop/src/main/service.ts`, `remote-image.ts`, `index.ts`; `apps/desktop/src/preload/index.ts`                 | Tracked send + journal; collector wiring; Worker image block; IPC                                                                                                                                                          |
| `apps/desktop/src/renderer/src/read-status/` (new folder)                                                              | `useReadStatus.ts`, `ReadStatusPanel.tsx`, `ReadStatusEye.tsx`, `ReadStatusSwitch.tsx`, `ReadStatusSettings.tsx`, `read-status-text.ts`                                                                                    |
| `Reader.tsx`, `ConversationRow.tsx`, `Composer.tsx`, `Settings.tsx`, `App.tsx`, `demo.ts`                              | One-block mounts                                                                                                                                                                                                           |

## Review Focus

1. **A quoted Worker image in a reply or forward** (a recipient's reply quotes their own copy, Khyati replies-all): the outgoing copies must not carry the old image, or other people's opens count as that recipient's. Pinned in Task 2 (`stripPixels`) and Task 6 (service strips before composing, tracked or not).
2. **Gmail's merged copy not yet visible when filing starts** (search lag): the replacement must look again after the grace period and also scan the newest All Mail envelopes, never leave two Sent copies when the copy shows up late. Pinned in Task 5 (`finds a late server copy after the grace period`).
3. **The connection drops after the first of three copies**: recipient 1 is `sent`, the rest are recoverable, the Sent copy is still replaced, and no retry ever sends to recipient 1 again. Pinned in Task 4 (outcomes) and Task 6 (journal + `recoverRejected` draft contents).
4. **Worker unreachable, wrong password, or returns junk** (offline laptop, typo in the address, HTML error page): collection backs off, keeps existing records, shows a plain error in Settings, never throws into the send path. Pinned in Task 7.
5. **Mixed-case or duplicated recipients** (`Alex@Example.org` on To and `alex@example.org` on Cc): one copy, one code, the same code on both laptops and in the lookup. Pinned in Task 2 (`trackedRecipients`, `imageCode`) and Task 3.

---

### Task 1: The Worker

**Files:**

- Create: `services/read-status-worker/src/index.js`, `src/classify.js`, `src/ranges.js`, `wrangler.toml`, `README.md`, `scripts/update-ranges.mjs`, `.gitignore` (`.wrangler/`, `.dev.vars`)
- Create: `tests/support/fake-d1.ts`, `tests/read-status-worker.test.ts`

**Interfaces:**

- Produces (HTTP, used by Task 7):
  - `GET /p/<code>.gif` → 200, body = 43-byte transparent GIF, headers `Content-Type: image/gif`, `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`, `Pragma: no-cache`, `Expires: 0`. Records `{code, at: Date.now(), source}` via `ctx.waitUntil` only when `code` matches `/^[A-Za-z0-9_-]{16,64}$/` and the method is GET. `HEAD` → same headers, no body, no record.
  - `GET /records?since=<id>&limit=<n>` with `Authorization: Bearer <PASSWORD>` → 200 `{"records":[{"id":number,"code":string,"at":number,"source":"apple"|"google"|"other"}],"next":number}` ordered by id ascending, `id > since`, `limit` default and max 1000, `next` = last id or `since`. Wrong/missing password → 401 `{"error":"unauthorized"}` (constant-time comparison of SHA-256 digests). Missing `PASSWORD` secret → 500 `{"error":"not configured"}`.
  - Anything else → 404 (empty body).
  - `scheduled` → `DELETE FROM records WHERE at < now - 90 days`.
- Env: `DB` (D1 binding), `PASSWORD` (secret).
- Table (created with `CREATE TABLE IF NOT EXISTS` once per isolate): `records(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL)`, index on `at`.
- `classify(ip: string, userAgent: string, asn?: number): 'apple'|'google'|'other'`; `inRanges(ip: string, ranges: string[]): boolean` (IPv4 and IPv6 CIDR, also IPv4-mapped IPv6).

- [ ] **Step 1: Write `tests/support/fake-d1.ts`**: `createFakeD1(): D1Like` backed by `new DatabaseSync(':memory:')` from `node:sqlite`, implementing `prepare(sql).bind(...values)` with `.all()` → `{results}`, `.run()` → `{meta:{changes}}`, `.first()`, and `db.exec(sql)`, `db.batch(stmts)`.
- [ ] **Step 2: Write the failing tests** in `tests/read-status-worker.test.ts` (import `../services/read-status-worker/src/index.js`; call `worker.fetch(new Request(url, init), env, ctx)` where `ctx.waitUntil` collects promises the test awaits):
  - `serves a no-cache GIF and records time and source` — GET `/p/AbCdEfGhIjKlMnOpQrStUv.gif` with header `CF-Connecting-IP: 17.58.0.1` → 200, `image/gif`, 43 bytes, `no-store` in Cache-Control; one row with source `apple`, `at` within the test's `Date.now()` window, and **no column holding an IP** (`PRAGMA table_info(records)` names are exactly `id, code, at, source`).
  - `classifies Google's image proxy and others` — UA `Mozilla/5.0 (via ggpht.com GoogleImageProxy)` → `google`; IP `203.0.113.9` → `other`; `request.cf.asn = 714` with other IP → `apple`.
  - `does not record malformed codes or HEAD requests but still serves the image`.
  - `returns records after a cursor, oldest first, behind the password` — 3 fetches; `/records?since=0` with `Bearer test-password` → 3 records, `next` = third id; `since=next` → `[]`, `next` unchanged; `limit=2` → 2.
  - `rejects a missing or wrong password with 401` and `answers 500 when PASSWORD is not set`.
  - `the scheduled job deletes records older than 90 days` — insert rows at `now - 91 days` and `now - 89 days`; run `worker.scheduled({scheduledTime: now}, env, ctx)`; only the 89-day row remains.
  - `inRanges` table: `17.0.0.1` in `17.0.0.0/8`; `18.0.0.1` not; `2620:149::1` in `2620:149::/32`; `::ffff:17.1.2.3` in `17.0.0.0/8`; garbage → false.
- [ ] **Step 3: Run** `corepack pnpm exec vitest run tests/read-status-worker.test.ts` → FAIL (module not found).
- [ ] **Step 4: Implement** `src/index.js`, `src/classify.js`, `src/ranges.js` (export `appleRanges`, `googleRanges` arrays of CIDR strings, each with a comment naming its published source and date), JSDoc types only. The client IP comes from `CF-Connecting-IP`; it is passed to `classify` and never stored.
- [ ] **Step 5: Run the tests** → PASS.
- [ ] **Step 6: Write `scripts/update-ranges.mjs`** (Node ≥ 20, no deps): fetches `https://www.gstatic.com/ipranges/goog.json`, rewrites the `googleRanges` block of `src/ranges.js`, leaves `appleRanges` untouched. Not run in tests.
- [ ] **Step 7: Write `wrangler.toml`** (`name = "read-status"`, `main = "src/index.js"`, `compatibility_date = "2026-10-01"`, `[[d1_databases]] binding = "DB" database_name = "read-status" database_id = "REPLACE_WITH_YOUR_DATABASE_ID"`, `[triggers] crons = ["17 3 * * *"]`) and `README.md`: what it stores and doesn't; numbered setup for Khyati's Cloudflare account on the free tier with **both** paths — (A) dashboard: create D1 database, create Worker, paste `src/index.js` + `classify.js` + `ranges.js` (or upload), bind `DB`, add secret `PASSWORD`, add cron trigger; (B) CLI from this folder with `npx wrangler@4`: `login`, `d1 create read-status`, put the id into `wrangler.toml` **locally without committing it**, `secret put PASSWORD`, `deploy`; optional custom domain (`t.<domain>` via Workers → Settings → Domains & Routes); how to check (`curl -I https://<address>/p/TESTTESTTESTTESTTEST.gif`, `curl -H "Authorization: Bearer …" https://<address>/records?since=0` — the latter run by Khyati with her own password); local run with `npx wrangler@4 dev` + `.dev.vars`; refreshing ranges. Never ask for the password in chat; generate it with `openssl rand -base64 32`.
- [ ] **Step 8: Prettier, security check, commit** `feat(read-status): add the read status Worker with setup steps`.

### Task 2: Sending rules, codes and the password store

**Files:**

- Create: `packages/core/src/read-status.ts`; export from `packages/core/src/index.ts`
- Modify: `packages/core/src/model.ts` (`Settings.readStatus?: ReadStatusSettings`, `Draft.readStatus?: boolean` — one block each), `packages/core/src/schemas.ts` (`settingsSchema.readStatus`, `draftSchema.readStatus`)
- Create: `apps/desktop/src/main/read-status/codes.ts`, `apps/desktop/src/main/read-status/secret.ts`
- Test: `tests/read-status-rules.test.ts`, `tests/read-status-codes.test.ts`

**Interfaces:**

- Produces (core):
  - `interface ReadStatusSettings { enabled: boolean; workerUrl?: string }` (absent → treated as `{ enabled: true }`); schema `z.object({ enabled: z.boolean(), workerUrl: z.string().max(2048).optional() }).optional()`; draft schema `readStatus: z.boolean().optional()` (`false` = switched off for this email).
  - `workerBase(url?: string): string | undefined` — the URL's origin when it is `https:` (or `http:` to `localhost`/`127.0.0.1`), has no credentials, and its path is empty or `/`; else undefined.
  - `pixelUrl(base: string, code: string): string` → `${base}/p/${code}.gif`.
  - `isWorkerImage(src: string, base?: string): boolean` — same origin as `base` (host case-insensitive, default ports normalised).
  - `addPixel(html: string, src: string): string` — inserts `<img src="SRC" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">` before the last `</body>` (case-insensitive), else appends.
  - `stripPixels(html: string, base?: string): string` — removes every `<img …>` whose `src` is a Worker image; unchanged when `base` is undefined.
  - `type TrackingBlock = 'off' | 'notConfigured' | 'switchedOff' | 'protected' | 'noHtml' | 'automated' | 'tooMany' | 'unsupported'`.
  - `trackingBlock(input: { settings?: ReadStatusSettings; passwordSet: boolean; draft: Pick<Draft, 'to'|'cc'|'bcc'|'html'|'readStatus'>; protection: 'none'|'encrypt'|'sign'; perCopySending: boolean }): TrackingBlock | undefined` — checks in this order: `off` (settings.enabled false), `notConfigured` (no valid base or no password), `unsupported` (!perCopySending), `switchedOff` (draft.readStatus === false), `protected` (protection ≠ none), `noHtml` (html trimmed empty), `automated` (no non-automated recipient), `tooMany` (> `readStatusLimits.recipients`).
  - `readStatusLimits = { recipients: 25 }`.
  - `trackedRecipients(draft): string[]` — every To/Cc/Bcc address trimmed and lowercased, de-duplicated, in order.
- Produces (main): `imageCode(password: string, messageId: string, recipient: string): string`; `trackedMessageId(password: string, domain: string): string`; `isTrackedMessageId(password: string, messageId: string): boolean`; `class ReadStatusSecret { constructor(store: JsonStore); load(): Promise<void>; get(): string | undefined; set(password: string | null): Promise<void> }` storing `{ password: encryptSecret(value) }` under store name `read-status-secret` (throws the existing secure-storage error when unavailable; an empty string clears).

- [ ] **Step 1: Write failing tests** `tests/read-status-rules.test.ts`:
  - `workerBase` accepts `https://read.example.com`, `https://read.example.com/` → `https://read.example.com`; `http://localhost:8787` → origin; rejects `http://read.example.com`, `https://u:p@read.example.com`, `https://read.example.com/x`, `''`, `'nonsense'`.
  - `addPixel` puts the image right before `</BODY>` and appends when there is no body tag.
  - `stripPixels` removes `<img src="https://READ.example.com/p/abc.gif" width=1>` and `<IMG SRC='https://read.example.com:443/p/x.gif'>`, keeps `<img src="https://cdn.example.com/a.png">`, and with base undefined returns the input.
  - `isWorkerImage` true for the base host in any case, false for `https://read.example.com.evil.example/p/x.gif`.
  - `trackingBlock` returns each reason in the stated order (one case per reason) and `undefined` for an eligible draft; `{ settings: undefined }` with a base and password → eligible (default on).
  - `trackedRecipients` with `Alex@Example.org` on To and ` alex@example.org` on Cc → `['alex@example.org']`.
- [ ] **Step 2: Write failing tests** `tests/read-status-codes.test.ts`:
  - `imageCode` is 22 chars of `[A-Za-z0-9_-]`, identical across two calls (two "laptops"), identical for `Alex@Example.org` and `alex@example.org`, different per recipient, per message ID and per password; does not contain the address, local part or message ID.
  - `trackedMessageId('test-password','example.com')` matches `/^[0-9a-f-]{36}\.[0-9a-f]{10}@example\.com$/`; `isTrackedMessageId` true for it, false with another password, false for a plain `uuid@example.com`, false for garbage.
  - `ReadStatusSecret` round-trips through a `JsonStore` in a temp dir (electron stub's `safeStorage`), survives a new instance + `load()`, `set(null)` clears; the stored file does not contain the plain password.
- [ ] **Step 3: Run** both files → FAIL.
- [ ] **Step 4: Implement** `read-status.ts` (core, no Node imports), the model/schema fields, `codes.ts` (`node:crypto` `createHmac`), `secret.ts`.
- [ ] **Step 5: Run** both files plus `tests/core.test.ts` → PASS; typecheck core and desktop.
- [ ] **Step 6: Commit** `feat(read-status): add tracking rules, image codes and the password store`.

### Task 3: One MIME copy per recipient

**Files:**

- Modify: `packages/core/src/model.ts` (`OutgoingMessage.copies?`, `OutgoingMessage.replaceServerCopies?`, `interface OutgoingCopy`, `interface SubmissionTracking`, `prepareSubmission`'s optional 5th parameter — one block)
- Modify: `packages/imap/src/provider.ts` (`prepareSubmission` only)
- Test: `tests/read-status-mime.test.ts`

**Interfaces:**

- Consumes: `addPixel`, `trackedRecipients` (Task 2).
- Produces:
  - `interface OutgoingCopy { recipient: string; mime: Uint8Array }`
  - `interface SubmissionTracking { imageFor(recipient: string): string | undefined }` — returns the image URL, or undefined for a copy without an image.
  - `OutgoingMessage.copies?: OutgoingCopy[]` (one per `trackedRecipients` entry, in that order); `OutgoingMessage.replaceServerCopies?: boolean`.
  - `ImapProvider.prepareSubmission(account, draft, messageId, precomposed?, tracking?)` — with `tracking` and no `precomposed`: one fixed `date`; `mime` = clean copy composed with `keepBcc: true` and no image; each copy composed with `keepBcc: false` and `html = imageFor(r) ? addPixel(draft.html, url) : draft.html`; `envelope.to` unchanged. Without `tracking`: exactly today's behaviour.

- [ ] **Step 1: Write failing tests** (build an `ImapProvider` with a `FakeImapServer` port as `tests/imap-provider.test.ts` does; draft To `alex@example.org`, Cc `sam@example.org`, Bcc `kim@example.org`, html `<p>Hi</p>`; `imageFor = (r) => r === 'kim@example.org' ? undefined : 'https://read.example.com/p/' + r.split('@')[0].padEnd(22,'x') + '.gif'`):
  - `builds one copy per recipient with identical headers` — 3 copies, recipients in To, Cc, Bcc order; parse each with `parseMime`; `messageId`, `date`, `subject`, `from`, `to`, `cc`, `inReplyTo`, `references` deep-equal across copies; `bcc` empty in every copy; the raw header blocks (text up to the first blank line, with `boundary=` values and `Content-Type` boundary parameters removed) are byte-identical.
  - `each copy carries only its own image` — Alex's HTML contains Alex's URL and not Sam's; Kim's contains no `read.example.com`.
  - `the clean copy has no image and keeps Bcc` — `parseMime(mime).bcc` = Kim, html has no `read.example.com`.
  - `without tracking nothing changes` — no `copies`, no Bcc header in `mime`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (extend the private `compose` with optional `html` and `date` overrides rather than duplicating it).
- [ ] **Step 4: Run** the new file + `tests/imap-provider.test.ts` + `tests/mime.test.ts` → PASS; typecheck core, imap, desktop (JMAP provider compiles unchanged: the parameter is optional).
- [ ] **Step 5: Commit** `feat(read-status): build one copy per recipient with identical headers`.

### Task 4: All copies over one SMTP session

**Files:**

- Modify: `packages/imap/src/smtp.ts` (new export `submitSmtpCopies`; `session` passes its `dropped` promise to `work` as a third argument)
- Modify: `packages/core/src/model.ts` (`interface CopyOutcome`, `MailProvider.submitCopies?` — one block)
- Modify: `packages/imap/src/provider.ts` (`submitCopies`, `ImapProviderOptions.smtp.submitCopies?`)
- Test: `tests/smtp-copies.test.ts`, `tests/read-status-send-bench.test.ts`

**Interfaces:**

- Produces:
  - `interface CopyOutcome { recipient: string; result: 'accepted' | 'rejected' | 'uncertain' | 'notSent'; reason?: string }`
  - `submitSmtpCopies(settings: SmtpSettings, from: string, copies: OutgoingCopy[], progress?: (recipient: string, previous?: CopyOutcome) => Promise<void>): Promise<CopyOutcome[]>` — validates like `submitSmtp` (throws `submissionRejected` before connecting); connects and signs in once (failures throw exactly as `submitSmtp`); for each copy in order: `await progress(recipient, previousCopysOutcome)` (a throw on the first copy rejects with that error and sends nothing; later, the rest become `notSent`), then one transaction `MAIL FROM:<from>` / `RCPT TO:<recipient>` / DATA. Definite refusals (`EENVELOPE`, `EMESSAGE` 4xx/5xx after DATA) → `rejected` with the reason text `sendFailure` builds, then `RSET` (`conn.reset`) before the next copy (a failed RSET → rest `notSent`). Connection lost during DATA → `uncertain`, before DATA → `notSent`; every later copy → `notSent` with reason `Not sent: the connection to <host> ended first.`. One `QUIT` at the end. Never retries a copy.
  - `MailProvider.submitCopies?(account: Account, message: OutgoingMessage, progress: (recipient: string, previous?: CopyOutcome) => Promise<void>): Promise<CopyOutcome[]>`; `ImapProvider.submitCopies` calls `(this.options.smtp?.submitCopies || submitSmtpCopies)(this.smtpSettings(), message.envelope.from, message.copies!, progress)`; throws `ProviderError('submission', …)` without copies.

- [ ] **Step 1: Write failing tests** in `tests/smtp-copies.test.ts` with `smtp-server` (copy the TLS/auth setup from `tests/smtp.test.ts`), counting connections (`onConnect`) and recording each transaction's envelope and data:
  - `sends every copy in one session, one recipient per transaction` — 3 copies → 1 connection, 3 transactions, each `rcptTo` exactly its recipient, each body exactly that copy's bytes; all `accepted`; `progress` called in order before each transaction.
  - `a refused recipient does not stop the others` — server rejects RCPT for `sam@example.org` (550) → outcomes `accepted, rejected (reason mentions the server's text), accepted`, still 1 connection.
  - `the connection dropping during the second copy's DATA leaves it uncertain and the rest not sent` — server destroys the socket in `onData` for the second copy → `accepted, uncertain, notSent`.
  - `a sign-in failure throws and sends nothing` — wrong password → rejects with code `outgoingAuthentication`, `progress` never called.
  - `a progress failure on the first copy sends nothing`.
- [ ] **Step 2: Write** `tests/read-status-send-bench.test.ts`: smtp-server whose `onMailFrom`, `onRcptTo` and `onData` end each wait 40 ms (stand-in for a real server's processing); time `submitSmtp` with 3 recipients vs `submitSmtpCopies` with 3 copies (median of 5 runs each) and `console.info` both numbers; assert tracked ≤ untracked + 3 × 200 ms (a regression guard, not the real-world figure).
- [ ] **Step 3: Run** both → FAIL.
- [ ] **Step 4: Implement** `submitSmtpCopies`, the `session` change, core types and `ImapProvider.submitCopies`.
- [ ] **Step 5: Run** the two new files + `tests/smtp.test.ts` → PASS; note the bench numbers for the report; typecheck core, imap, desktop.
- [ ] **Step 6: Commit** `feat(read-status): send each recipient's copy over one SMTP session`.

### Task 5: Replace Gmail's Sent copy with one clean copy

**Files:**

- Create: `packages/imap/src/sent-replace.ts`
- Modify: `packages/imap/src/port.ts` (`SearchCriteria.gmraw?: string`), `packages/imap/src/provider.ts` (`fileSentCopy` branches on `message.replaceServerCopies`)
- Modify: `tests/support/fake-imap.ts` (one opt-in block: `gmail` mode)
- Test: `tests/read-status-sent-copy.test.ts`

**Interfaces:**

- Consumes: `OutgoingMessage.replaceServerCopies` (Task 3).
- Produces: `ImapProvider.fileSentCopy(account, message)` with `replaceServerCopies: true` always ends with exactly one copy of `message.mime` in Sent, returns `'filed'`, calls `requestSync('all')`; without the flag, unchanged.
  - Gmail (capability `X-GM-EXT-1` and both an All Mail (`\All`) and Trash box): in All Mail find UIDs by `search({ gmraw: 'rfc822msgid:' + id })` ∪ `withMessageId`; `move` them to Trash; in Trash find by `withMessageId` (plain `HEADER Message-ID`) and `expunge`; `append(sent, mime, ['\\Seen'])`.
  - Other servers: in Sent find by `withMessageId`; `expunge` them when UIDPLUS is offered (otherwise leave them); append.
  - If the first look finds nothing, wait `sentCopyGraceMs` **outside** `this.run` (as today), then look again inside the replacing run.
  - Append failures map to `filingUncertain` / `filing` exactly as today. Every step is safe to repeat after a crash.
- Fake: `server.gmail = true` adds `X-GM-EXT-1`, answers `gmraw` `rfc822msgid:<id>` searches in the selected folder, and when messages leave the All Mail folder by `move`, removes messages with the same Message-ID from every other folder except the destination (Gmail label semantics).

- [ ] **Step 1: Write failing tests** (provider over the fake with folders `INBOX`, `[Gmail]/Sent Mail` `\Sent`, `[Gmail]/All Mail` `\All`, `[Gmail]/Trash` `\Trash`; `timing.sentCopyGraceMs: 0`):
  - `replaces Gmail's merged copy with one clean copy` — seed the server copy (with an image URL in its body) in All Mail and Sent with the same Message-ID; call `fileSentCopy` with `replaceServerCopies` → Sent has exactly one message, its source equals `message.mime` and is `\Seen`; All Mail none with the old body; Trash none with that Message-ID.
  - `finds a late server copy after the grace period` — the copy appears only after the first lookup (hook the fake's search to add it once) → still exactly one clean copy in Sent.
  - `running it twice still leaves exactly one clean copy` (crash-retry).
  - `on a non-Gmail server with UIDPLUS it expunges its own copy in Sent and appends the clean one`.
  - `without replaceServerCopies it keeps today's behaviour` (existing server copy → `'server'`, nothing appended).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `sent-replace.ts` (`replaceSentCopy(port, boxes, messageId, mime, find)`), the `gmraw` criterion (imapflow accepts the key as-is), the fake's gmail block, the provider branch.
- [ ] **Step 4: Run** the new file + `tests/imap-provider.test.ts` + `tests/service-imap.test.ts` → PASS; typecheck imap.
- [ ] **Step 5: Commit** `feat(read-status): replace Gmail's Sent copy with one clean copy`.

### Task 6: Tracked sending in the send flow

**Files:**

- Create: `apps/desktop/src/main/read-status/tracked-send.ts`
- Modify: `apps/desktop/src/main/service.ts` (Journal fields; `sendDraft`; `init` recovery; `outgoingMessage`; `sendResult` text; secret loading)
- Test: `tests/read-status-service.test.ts` (setup copied from `tests/service-imap.test.ts`, with `smtp.submitCopies` faked)

**Interfaces:**

- Consumes: Tasks 2–5.
- Produces:
  - Journal gains `tracked?: boolean`, `copies?: { recipient: string; state: 'pending'|'sending'|'accepted'|'rejected'|'uncertain'|'notSent'; reason?: string }[]`, `unconfirmed?: string[]`.
  - `settleCopies(copies): { state: 'sent'|'partial'|'uncertain'|'rejected'; accepted: string[]; rejected: { email: string; reason: string }[]; unconfirmed: string[] }` (rules in "Decisions").
  - `recoverCopies(copies)` → same copies with `sending` → `uncertain` and `pending` → `notSent` (reason `Not sent: the app closed before sending to this recipient.`).
  - `MailService.readStatusSecret: ReadStatusSecret` loaded in `init` (a load failure only disables tracking, logged as `read-status-secret-unavailable`).
  - Send flow when `trackingBlock(…)` is undefined (protection from `draft.encryption` and `this.encryption.identity(…)?.enabled`; `perCopySending` = `!!provider.submitCopies && provider.capabilities.sentCopy === 'client'`): `messageId = trackedMessageId(password, domain)`; `prepareSubmission(…, { imageFor: r => isAutomatedAddress(r) ? undefined : pixelUrl(base, imageCode(password, messageId, r)) })`; `outgoing.replaceServerCopies = true`; journal `tracked`, `copies` all `pending`, persisted with state `submitting` before anything is sent; `provider.submitCopies(account, outgoing, progress)` where `progress(recipient, previous)` records `previous`'s result, marks this copy `sending`, then persists; afterwards copies get their outcomes, `settleCopies` sets `state`/`accepted`/`rejected`/`unconfirmed`; `rejected` with nothing accepted throws `ProviderError('submissionRejected', …)` (the first copy's reason) through the existing catch; `uncertain` goes through the existing uncertain path; `sent`/`partial` continue exactly as an untracked send (draft completion, `finishSend` → `fileSentCopy` with `replaceServerCopies`).
  - Whenever a Worker base is configured, the draft HTML passed to `protectedMime` and `prepareSubmission` is `stripPixels(html, base)` (tracked or not).
  - Untracked sends are byte-for-byte today's path (one `submit`).
  - `sendResult` for a tracked `partial`: `Sent to some recipients. N didn't get it.` plus ` Delivery to M isn't confirmed.` when `unconfirmed` is non-empty, plus the existing ` Sent copy pending.`.

- [ ] **Step 1: Write failing tests** (settings `readStatus: { enabled: true, workerUrl: 'https://read.example.com' }`, password `test-password` via `service.readStatusSecret.set`; fake `submitCopies` records copies and returns outcomes; Gmail-mode fake IMAP from Task 5):
  - `sends one copy per recipient with its own image and files one clean Sent copy` — To Alex, Cc Sam, Bcc Kim → `submitCopies` once with 3 copies; each copy's HTML has `pixelUrl(base, imageCode('test-password', messageId, r))` for its own recipient only; the journal's Message-ID passes `isTrackedMessageId`; after `sendsSettled()` Sent has one copy, no `read.example.com`, Bcc Kim present; result `status: 'sent'`.
  - `the journal is durable before each copy` — the fake awaits `progress('alex@example.org')`, then `progress('sam@example.org', { recipient: 'alex@example.org', result: 'accepted' })`, then reads the stored `submissions` file: journal `submitting`, Alex `accepted`, Sam `sending`, Kim `pending`.
  - `a crash midway never sends to anyone twice` — the fake does the two `progress` calls above and then never resolves (the app "dies"); start a second `MailService` on the same directory → journal `partial`, accepted Alex, `unconfirmed` Sam, rejected Kim with `Not sent: the app closed before sending to this recipient.`; `recoverRejected` gives a draft whose To/Cc/Bcc contain Kim only; the second service never calls `submitCopies`.
  - `a dropped connection mid-send ends partial with the unconfirmed recipient excluded from recovery` — outcomes `accepted, uncertain, notSent` → `partial`, `unconfirmed: ['sam@example.org']`, result message contains `Delivery to 1 isn't confirmed.`; recovery draft has Kim only.
  - `everything refused throws and the draft stays` — all `rejected` → send rejects with `submissionRejected`, draft status `error`.
  - `never tracked` (one case each, asserting `submit` called once and `submitCopies` never): main switch off; no password; `draft.readStatus === false`; `encryption: 'sign'`; all recipients `noreply@example.com`; 26 recipients.
  - `an automated recipient gets a copy without an image` — To Alex + `no-reply@example.org` → 2 copies, the second has no `read.example.com`.
  - `quoted Worker images are stripped from every send` — untracked (switch off) draft whose html contains `<img src="https://read.example.com/p/OLDOLDOLDOLDOLDOLDOLDO.gif">` → transmitted MIME has no `OLDOLD`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `tracked-send.ts` and the `service.ts` changes (keep the edit to the send flow in one place: a `private trackingFor(draft, account, provider)` helper and a `private async submitTracked(journal, account, outgoing)` helper beside `sendDraft`).
- [ ] **Step 4: Write** a service-level timing in `tests/read-status-send-bench.test.ts`: real `smtp-server` (40 ms per step, as Task 4) + fake IMAP, `service.send` tracked to 3 recipients vs untracked (switch off), median of 5; `console.info` both; assert tracked ≤ untracked + 600 ms.
- [ ] **Step 5: Run** new tests + `tests/service-imap.test.ts` + `tests/service.test.ts` + `tests/background-send.test.ts` → PASS; typecheck desktop.
- [ ] **Step 6: Commit** `feat(read-status): send tracked emails one copy per recipient with per-recipient journal`.

### Task 7: Collecting from the Worker, lookups and IPC

**Files:**

- Create: `apps/desktop/src/main/read-status/worker-client.ts`, `apps/desktop/src/main/read-status/collector.ts`
- Modify: `packages/core/src/read-status.ts` (IPC types), `packages/core/src/model.ts` (`DesktopMailAPI` methods, `AppEvent` `{ type: 'readStatus' }` — one block each), `packages/core/src/schemas.ts` (`ipcSchemas` entries), `apps/desktop/src/main/service.ts` (collector start/stop, four methods, `setSettings` nudge), `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/demo.ts`
- Test: `tests/read-status-collector.test.ts`

**Interfaces:**

- Produces (core types):
  - `type FetchSource = 'apple' | 'google' | 'other'`; `interface FetchRecord { at: number; source: FetchSource }`
  - `interface ReadStatusRequest { messageId: string; recipients: string[] }` (max 500 requests × 600 recipients in the schema)
  - `interface ReadStatusLookup { recipients: { email: string; fetches: FetchRecord[] }[] }`
  - `interface ReadStatusInfo { passwordSet: boolean; secureStorage: boolean; lastCollectedAt?: string; error?: string }`
- Produces (`DesktopMailAPI`, implemented on `MailService`, wired in `index.ts`/preload, stubbed in `demo.ts` returning `null`s / `{ passwordSet: false, secureStorage: true }` / `{ ok: false, message: 'Not available in the demo.' }`):
  - `readStatus(requests: ReadStatusRequest[]): Promise<(ReadStatusLookup | null)[]>` — `null` when the feature is off, not configured, or `!isTrackedMessageId(password, messageId)`; else every recipient (lowercased) with its fetches (codes via `imageCode`).
  - `readStatusInfo(): Promise<ReadStatusInfo>`
  - `setReadStatusPassword(password: string | null): Promise<ReadStatusInfo>` — saves, emits `readStatus`, collects now.
  - `testReadStatus(workerUrl: string, password?: string): Promise<{ ok: boolean; message: string }>` — uses the stored password when none is given.
- `fetchRecords(base, password, since, fetchImpl = fetch): Promise<{ records: { id: number; code: string; at: number; source: FetchSource }[]; next: number }>` with a 15 s timeout; throws `Error` with plain messages: `The Worker didn't accept the password.` (401), `The Worker address didn't answer. Check it and your connection.` (network/timeout), `The Worker answered with something unexpected.` (non-JSON or wrong shape). Never includes the password.
- `testWorker(base, password, fetchImpl)` → `{ ok: true, message: 'Connected. The Worker accepted the password.' }` or `{ ok: false, message: <the error above> }`; invalid address → `Enter the Worker's https address.`.
- `class ReadStatusCollector { constructor(store: JsonStore, config: () => { base?: string; password?: string }, onChange: () => void, options?: { fetch?: typeof fetch; now?: () => number; intervalMs?: number; maxBackoffMs?: number }); start(): void /* collects at once, then on schedule */; stop(): void; collectNow(): Promise<void>; fetches(code: string): FetchRecord[]; info(): { lastCollectedAt?: string; error?: string } }` — store name `read-status`: `{ base, cursor, records: { id, code, at, source }[] }`; a different `base` resets cursor and records; loops `fetchRecords` until a page has fewer than 1000; de-duplicates by id; drops records older than 90 days; calls `onChange` only when records were added or the error changed; schedules the next run in `intervalMs` (120 000) on success, doubling from 120 000 up to `maxBackoffMs` (1 800 000) on failure; `stop()` clears the timer; never runs two collections at once; config without base or password → does nothing and clears the error.

- [ ] **Step 1: Write failing tests** with a fake `fetch` (Response objects) and fake timers:
  - `collects new records after the cursor and persists them` — two pages (1000 + 3) → 1003 records, cursor = last id, second instance on the same store reads them back.
  - `de-duplicates and drops records older than 90 days`.
  - `backs off when the Worker is unreachable and keeps existing records` — fetch rejects → `info().error` = the unreachable message, next run after 240 000 ms, then 480 000 …, capped at 1 800 000; success resets to 120 000 and clears the error.
  - `reports a wrong password and junk answers plainly` — 401 and `<html>` cases.
  - `a new Worker address starts over`.
  - `readStatus returns null for untracked emails and per-recipient fetches for tracked ones` (service-level, with `trackedMessageId` from Task 2 and records seeded through the fake fetch).
  - `testReadStatus never puts the password in its message`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; start the collector at the end of `MailService.init`, stop it in the service's dispose path; `emit({ type: 'readStatus' })` from `onChange`; `setSettings` calls `collectNow()` when `readStatus` changed.
- [ ] **Step 4: Run** new file + `tests/service.test.ts` + `tests/core.test.ts` → PASS; typecheck core and desktop.
- [ ] **Step 5: Commit** `feat(read-status): collect records from the Worker with backoff`.

### Task 8: Status derivation

**Files:**

- Modify: `packages/core/src/read-status.ts`
- Test: `tests/read-status-status.test.ts`

**Interfaces:**

- Produces:
  - `countOpens(fetches: FetchRecord[]): { opens: number; firstAt?: number; lastAt?: number; apple: boolean }` (rules in "Decisions"; `firstAt`/`lastAt` over counted fetches).
  - `type RecipientState = 'opened' | 'apple' | 'none'`
  - `interface RecipientReadStatus { email: string; state: RecipientState; opens: number; firstAt?: string; lastAt?: string; repliedAt?: string }`
  - `recipientStatus(email: string, fetches: FetchRecord[], repliedAt?: string): RecipientReadStatus` — `opened` when opens > 0 or replied; else `apple` when an Apple fetch was seen; else `none`. ISO strings out.
  - `replyTimes(sent: { receivedAt: string }, later: { from: Address[]; receivedAt: string }[]): Map<string, string>` — lowercase sender email → earliest `receivedAt` after the sent email.
  - `conversationOpened(statuses: RecipientReadStatus[]): boolean` — any `opened`.

- [ ] **Step 1: Write failing tests**: two fetches 30 s apart → 1 open; 0 s, 59 s, 61 s → 2 opens (61 s is ≥ 60 s after the counted 0 s); 0, 61, 121 → 3; Apple-only → `apple`, 0 opens; Apple + Google → `opened`, 1 open; nothing → `none`; nothing + reply → `opened`, `repliedAt` set, opens 0; `replyTimes` ignores messages before the sent one and matches senders case-insensitively; unsorted input is handled.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(read-status): derive per-recipient statuses, counting replies as opened`.

### Task 9: Never load the Worker's images

**Files:**

- Modify: `apps/desktop/src/main/remote-image.ts` (optional `blocked?: (url: string) => boolean` checked on every hop), `apps/desktop/src/main/service.ts` (`remoteImage` passes `url => isWorkerImage(url, base)`), `apps/desktop/src/renderer/src/Reader.tsx` (in the image loop: a Worker image is removed like a tracking pixel, before any request)
- Test: `tests/remote-image.test.ts` (add cases), `tests/read-status-service.test.ts` (add one)

**Interfaces:**

- Consumes: `isWorkerImage`, `workerBase` (Task 2).
- Produces: `remoteImageData(value, fetchResource?, blocked?)`.

- [ ] **Step 1: Write failing tests**: `remoteImageData` returns `null` without calling the fetcher for a blocked URL, and stops (null) when a redirect lands on a blocked URL; `service.remoteImage('https://read.example.com/p/AbCdEfGhIjKlMnOpQrStUv.gif')` → `null` with remote images on.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (Reader reads the base from settings already in scope; the edit is the one condition plus the `workerBase` call). **Step 4: Run** the files + `tests/reader-body.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(read-status): never load the Worker's images in the app`.

### Task 10: The interface — statuses, eye and composer switch

**Files:**

- Create: `apps/desktop/src/renderer/src/read-status/useReadStatus.ts`, `read-status-text.ts`, `ReadStatusPanel.tsx`, `ReadStatusEye.tsx`, `ReadStatusSwitch.tsx`
- Modify (one-block mounts): `Reader.tsx` (panel under each message sent by an own address), `ConversationRow.tsx` (eye next to the attachment/lock markers), `Composer.tsx` (switch left of the account email in `compose-footer`), `App.tsx` (invalidate `['readStatus']` on the `readStatus` event)
- Test: `tests/read-status-text.test.ts`

**Interfaces:**

- Consumes: `api.readStatus`, `api.readStatusInfo`, `recipientStatus`, `replyTimes`, `conversationOpened`, `trackingBlock`, `ownAddresses` (core `split.ts`).
- Produces:
  - `readStatusLine(status: RecipientReadStatus, now: Date): string` — `Opened 2× · last today 3:12 pm`, `Opened 1× · today 3:12 pm`, `Opened · replied yesterday 9:05 am`, `Delivered to Apple Mail, can't tell`, `No signal yet`. Day words and times via the existing `mail-date.ts` helpers (add a small helper there only if none fits).
  - `readStatusSmallPrint: string[]` — the four caveats from the design, verbatim in meaning: Gmail often shows 1× after several opens; blocked images mean "No signal" even if read; several devices count separately; a forwarded copy's opens count as the original recipient's. Plus: "Opened or not, and the first open, are reliable; the count is a rough guide."
  - `useReadStatus(accountId: string, messages: Message[], conversation: Message[]): Map<string /*message id*/, RecipientReadStatus[]>` — only messages from own addresses with a `messageId`; one `api.readStatus` call per conversation (`queryKey: ['readStatus', accountId, ...messageIds]`, `staleTime: 60_000`).
  - `<ReadStatusPanel statuses={RecipientReadStatus[]} recipients={Address[]} />` — one row per recipient (name or address, then the line), muted 12px; an info `IconButton` toggles the small print; renders nothing for untracked emails.
  - `<ReadStatusEye conversation={Conversation} />` — lucide `Eye` 13px with `aria-label="Opened"` and a title, only when `conversationOpened`.
  - `<ReadStatusSwitch draft={Draft} protection={Protection} onChange={(readStatus: boolean) => void} />` — text button `Read status: on` / `Read status: off`; hidden when `trackingBlock` is `off`, `notConfigured` or `unsupported`; disabled with a title naming the reason for `protected`, `noHtml`, `automated`, `tooMany`; clicking toggles `draft.readStatus` (`false` = off; on = field removed or `true`).

- [ ] **Step 1: Write failing tests** for `readStatusLine` (fixed `now`, each status) and `readStatusSmallPrint` length 5.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the files and mounts. Composer: use the composer's existing draft-update path so the field saves like any edit.
- [ ] **Step 4: Run** the new test, `tests/reader-body.test.ts`, `tests/shortcuts.test.ts`; typecheck desktop; then run the app in dev (`env -u ELECTRON_RUN_AS_NODE corepack pnpm --filter @inlark/desktop dev`) with the demo or a fake account if possible and check: switch visible only when configured, panel hidden for untracked mail, no layout shift in the list. If the app can't be driven here, say so in the report.
- [ ] **Step 5: Commit** `feat(read-status): show statuses under sent emails, the eye in the list and the composer switch`.

### Task 11: Settings → Read status

**Files:**

- Create: `apps/desktop/src/renderer/src/read-status/ReadStatusSettings.tsx`
- Modify: `Settings.tsx` (one entry in the sections list + mount)

**Interfaces:**

- Consumes: `api.readStatusInfo`, `api.setReadStatusPassword`, `api.testReadStatus`, the existing settings save path, `workerBase`.
- Produces: a section titled `Read status` with: main switch (`settings.readStatus.enabled`, default on); Worker address input (saved on blur when `workerBase` accepts it, inline error `Enter the Worker's https address.` otherwise); password field (empty, placeholder `Saved` when `passwordSet`, buttons `Save password` / `Remove`; never pre-filled or echoed); `Test` button showing the returned message; last collection time and error from `readStatusInfo`; small print: "Use the same address and password on both laptops. Changing the password hides statuses of emails sent before." and a pointer to `services/read-status-worker/README.md` for setup. When secure storage is unavailable, the password field is disabled with the existing secure-storage wording.

- [ ] **Step 1:** Implement and mount. **Step 2:** Typecheck desktop, prettier, run `tests/` files touching Settings (if any) and the full suite once. **Step 3:** If the app runs in dev, check keyboard reachability (Tab through switch → address → password → Test). **Step 4: Commit** `feat(read-status): add Settings → Read status`.

### Final: whole-branch review, rebase, report

- [ ] Full suite `corepack pnpm exec vitest run` (re-run any failing timing-sensitive test alone), typecheck core/imap/desktop, `prettier --check` on every changed file.
- [ ] Final reviewer checks the branch against the spec, the Review Focus list, privacy rules and ownership rules.
- [ ] `git fetch origin && git rebase origin/main`; resolve keeping both features; re-run every check.
- [ ] Report per the brief (head hash, done/left by priority, check numbers, differences from the design, Khyati's manual checklist including Cloudflare setup).
