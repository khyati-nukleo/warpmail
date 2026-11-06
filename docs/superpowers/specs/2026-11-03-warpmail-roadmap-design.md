# Warpmail roadmap: Superhuman features on top of inlark

Date: 2026-11-03
Owner: Khyati
Status: draft, awaiting approval

## Why

Superhuman costs roughly $30 a month. Khyati wants the same daily workflow for free (or close to it) by extending Warpmail, which is a fork of [inlark](https://github.com/inlark/inlark), an open-source, keyboard-first desktop mail client that already takes Superhuman as its reference for email workflows.

**Success:** Khyati cancels Superhuman and uses Warpmail every day without missing it. Everything Khyati relies on has to work; matching every Superhuman feature is the long-term goal, not the bar for switching.

## Who it's for

One person: Khyati, on their work Google Workspace account (mail hosted by Google). Khyati typically works on 4–7 client projects at the same time. Other accounts (Outlook, self-hosted) come later.

## Goals

All 11 gaps between Warpmail and Superhuman, delivered in the order below. Each one gets its own short design pass before it is built (see "How to use this file").

## Non-goals (for now)

- Distributing Warpmail to other people, or hosting it for anyone else.
- Contributing these features back to inlark. inlark's own scope deliberately excludes AI, snooze, scheduled sending and calendars, so this fork will keep diverging from it.

## Anti-goals (failure even if it "works")

- **False "read" status.** Telling Khyati a client read a message when we can't actually tell.
- **Client email leaking somewhere unexpected.** Any service that sees message content (AI, read-status server) must be a deliberate, known choice.
- **Losing the speed.** Every new feature must work from the keyboard and must not slow down the inbox.
- **Breaking what inlark already does well:** crash-safe drafts, unambiguous send status, undo, large-mailbox performance.

## Starting point (already in Warpmail)

Keyboard navigation and command menu (`J`/`K`, `E`, `R`/`A`/`F`, `C`, `/`, `Ctrl K`, `G`+letter, `X` multi-select, rebindable keys), undo for organizing actions (`Z`), unified multi-account inbox, server-side search across all folders and years, unsubscribe, star, spam, move, read/unread, aliases, signatures, crash-safe drafts, attachments, notifications and tray unread count, dark and light themes, verification-code copying, optional OpenPGP, and fast handling of very large mailboxes.

Protocols today: JMAP, IMAP and SMTP with passwords only. **No Google or Microsoft sign-in.** The IMAP layer already understands some Gmail behaviour (Gmail message IDs, the same message appearing under several labels).

## Constraints

- **Cost:** free where possible. Where something can't be free (AI), keep it to a few dollars a month and make it a visible choice.
- **Desktop app:** anything time-based (reminders, snooze, scheduled send) only runs while the app is running, unless a server does it. Missed timers must fire when the app next opens.
- **Small server only:** read status needs something online at all times. Keep it as small as possible so Khyati can host it anywhere (a small server or a free Cloudflare Worker). No website.
- **License:** AGPL-3.0. Fine for personal use and changes. If Warpmail is ever shared or hosted for others, the changes must stay open source.
- **Keep inlark's look, not Superhuman's.** Khyati prefers inlark's interface: it's close to Gmail, so switching is easy. Superhuman is the reference for _what_ features do, never for how they look. New features fit into inlark's existing layout and design language (tabs, lists, menus), with no Superhuman-style restyling.
- **Keep inlark's standards:** see `AGENTS.md` (design quality, keyboard and mouse parity, reliability, no telemetry). The read-status service is a deliberate, owner-controlled exception to "no hosted service".

## Roadmap and status

| #   | Feature                                            | Status                                |
| --- | -------------------------------------------------- | ------------------------------------- |
| 0   | Speed and reliability on Gmail over IMAP           | Done (see "Speed work" below)         |
| 1   | Connect Google accounts (app password)             | Done: connected and working           |
| 1b  | Optional Google sign-in (Gmail API mode)           | Documented below, not started         |
| 2   | Split inbox per project                            | Designed; build session ready         |
| 3   | Follow-up nudges + "you forgot to reply" reminders | Designed; build after split inbox     |
| 4   | Draft improvement (AI)                             | Designed; build when API key is ready |
| 5   | Read status, per recipient                         | Designed; send test comes first       |
| 6   | Undo send                                          | Not started                           |
| 7   | Snippets (reusable text)                           | Not started                           |
| 8   | Snooze                                             | Not started                           |
| 9   | Scheduled send                                     | Not started                           |
| 10  | Gmail labels                                       | Not started                           |
| 11  | AI summaries                                       | Not started                           |
| 12  | Calendar                                           | Not started                           |
| 13  | Contact side panel                                 | Not started                           |
| 14  | Team thread sharing and comments                   | Not started                           |
| 15  | Outlook / Microsoft sign-in                        | Not started                           |
| 16  | Mobile app                                         | Not started                           |

Items 1–5 are Khyati's order. Items 6–16 are my proposed order (cheapest and most self-contained first, biggest last); Khyati can reorder. The original "11 missing features" list grouped some of these together; they are split here so each can be tracked.

## App icon

**Decided (2026-11-05):** Warpmail's icon is the dark navy tile with a white envelope flying up and to the right, trailing cyan and violet speed streaks over a warped grid. This replaces inlark's purple chevron icon going forward.

- **Source:** `design/icon/build.mjs` generates every file into `design/icon/out/` (`node design/icon/build.mjs`). Edit the script, not the output files.
- **Versions:** the full icon for 64px and up; a simplified one (envelope and three streaks, no grid or sparkles) for 16–48px, the tray and the small Windows sizes; and a white single-colour mark for the 24px sidebar logo.
- **Not yet in the app.** To switch over, copy the files from `design/icon/out/` over the matching ones in `apps/desktop/resources/` (`icon.png`, `icon.svg`, `icon-mark.svg`, `tray*.png`), add `icon.ico`, and point `win.icon` in `apps/desktop/electron-builder.yml` at `resources/icon.ico` so Windows uses the simplified art at small sizes. The app name in `electron-builder.yml` is still `inlark` and can change at the same time.

## Features

### 1. Connect Google accounts (app password)

**Why first:** nothing else can be used on Khyati's accounts without it.

**Decided (2026-11-03):** use Warpmail's existing account setup (IMAP and SMTP with a password) with a **Google app password**. No "Sign in with Google". This works for both work (Workspace) and personal Gmail accounts, on both work and personal laptops, and keeps the same flow as every other provider.

**How it works:**

- On the Google account: 2-Step Verification on, then create an app password at myaccount.google.com/apppasswords.
- In Warpmail: Settings → Accounts → Add account, enter the address, paste the app password. Setup already accepts app passwords, and the password is stored in the OS keyring.
- **My call:** one app password per laptop, so one device can be revoked without affecting the other.

**Trade-offs accepted:**

- An app password gives full mail access and doesn't expire until revoked.
- Gmail labels are still reachable over IMAP (Gmail's label extension), so feature 10 isn't blocked.
- Calendar and contacts (features 12–13) can't use an app password. Those will need an optional "Sign in with Google" later, added alongside the password flow, not replacing it. See 1b.

**Work for this feature:** mostly testing and polish. Confirm setup finds Gmail's servers, then test sending, archiving, the "All Mail" and label folders, and large-mailbox indexing on a real account. Optionally add a hint linking to Google's app password page when a Gmail or Workspace address is entered.

**Risk / open:** a Workspace admin can turn app passwords off. Check that the work Workspace allows them before anything else. _(Checked 2026-11-03: it does.)_

### 1b. Optional Google sign-in (Gmail API mode)

**What it is:** an optional second way to connect a Gmail or Google Workspace account. It uses "Sign in with Google" and talks to Gmail through Google's own Gmail API, instead of IMAP and SMTP. It sits **alongside** the app-password connection, not in place of it. Other providers, and anyone who prefers app passwords, keep using IMAP. This is how Superhuman connects to Gmail (inferred: it only offers Google sign-in for Gmail; its blog describes a local-first design on top).

**Why it's faster: measured today on IMAP (timing log, 2026-11-04, Khyati's Windows laptop, Gmail)**

| What                                          | IMAP today                                                                                                                             | Why it's slow on IMAP                                                                                  | With the Gmail API (expected, to be measured)                                                                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every request to Gmail                        | About 170 ms each, **one at a time** on a single connection                                                                            | IMAP runs one command at a time per connection, so the user's actions queue behind background sync     | Requests run in parallel over HTTPS. Up to 100 can be combined into one batch request. The user's actions never queue behind sync.                                                                                            |
| Opening a conversation                        | 2.5 s typical, up to 5.5 s, after the 2026-11-04 fixes (6.3 s typical before)                                                          | Each message needs "open folder" + "download", per folder the message is in, one message after another | One request returns the whole conversation (`threads.get`). Expected well under 1 s on a cold open, and instant once the ahead-of-time download (fix 4) has it.                                                               |
| Gmail's duplicate copies                      | One email shows up as 2–3 copies (Inbox, All Mail, Important). Every action touches each copy.                                         | IMAP shows Gmail labels as separate folders                                                            | The API has one message with several labels. No duplicates, no extra trips, no copy-specific conflicts.                                                                                                                       |
| Mark read, star, archive                      | Silently failed on Gmail until the imapflow fix. Each copy is changed separately.                                                      | Conditional flag change per folder copy, sent in the wrong order by imapflow 2.0.6                     | One call (`messages.modify`, or `batchModify` for many emails) that removes the UNREAD label. Nothing to get wrong per copy.                                                                                                  |
| Saving a draft                                | About 9 s per save (check old 1.7 s, upload 1.9 s, read back 1.6–1.9 s, delete old 3.2–3.6 s)                                          | IMAP has no "update draft". Each save uploads a new copy and deletes the old one.                      | One call (`drafts.update`) replaces it in place.                                                                                                                                                                              |
| Sending                                       | 7.7 s after the save: check draft 1.6 s, send 1.5 s, file Sent copy 1.7 s, delete draft 2.9 s                                          | SMTP sends, then IMAP files the Sent copy and cleans up separately                                     | One call (`drafts.send` or `messages.send`). Gmail files the Sent copy and removes the draft itself.                                                                                                                          |
| Checking for new mail                         | A pass checks every folder (about 23 on this account, ~170 ms each, ~4 s per pass) every 2 minutes, plus a full check every 15 minutes | IMAP has no "what changed since last time" across folders                                              | One call (`history.list`) returns only what changed since the last check, so it can poll often and cheaply. (Instant push needs Google Cloud Pub/Sub, which a desktop app can't receive directly. Polling is enough for now.) |
| Search                                        | Runs over IMAP search                                                                                                                  |                                                                                                        | Gmail's own search syntax (`from:`, `has:attachment`, …), the same results as Gmail on the web                                                                                                                                |
| Downloading recent mail ahead of time (fix 4) | One message at a time on the shared connection                                                                                         |                                                                                                        | Batches of up to 100 messages per request, so it fills much faster                                                                                                                                                            |

The "expected" column comes from how the Gmail API works, not from measurements. Measure it with the same timing log once it's built, and update this table with real numbers.

**What it also unlocks:** Gmail labels as real labels (feature 10), plus Google Calendar and Contacts (features 12–13) with the same sign-in.

**Costs and trade-offs:**

- **Setup:** a Google Cloud project with an OAuth client for a desktop app (sign-in through the system browser with PKCE). Tokens go in the OS keyring, like passwords today.
- **Google's rules for full Gmail access (to verify before building):**
  - **Work account:** an app marked **Internal** to the work Workspace needs no Google review, but only works for that Workspace's accounts.
  - **Personal Gmail:** needs an **External** app. In "testing" mode it's limited to a short list of test users, and sign-ins expire after about 7 days, so it would need re-signing weekly. Publishing it for real needs Google's verification and a yearly security assessment for full Gmail access, which is costly.
  - So the realistic start is Internal for the work account, with personal accounts staying on app passwords unless that changes.
- **Work:** a new Gmail provider package alongside the existing IMAP and JMAP providers (same `MailProvider` interface in packages/core), plus sign-in screens. This is a sizeable feature, bigger than any single fix so far.
- **Upstream:** inlark lists Gmail sign-in as "not supported yet". If inlark adds it, line up with their approach instead of diverging.

**Open:** whether Khyati wants Internal-only (work account) first; whether the work account should switch over completely or keep IMAP as a fallback; and when to schedule it relative to features 2–5.

## Speed work (item 0)

Done and tested by Khyati on 2026-11-05 (branch `fix/gmail-speed`, PR #1). Measured with a temporary timing log, removed afterwards.

|                            | Before                               | After                                                         |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| Opening an email (typical) | 7.9 s                                | 0.13 s                                                        |
| Opening, slowest seen      | 64 s                                 | 1.1 s                                                         |
| Mark read                  | failed on Gmail                      | instant on screen; Gmail confirms in ~3.6 s in the background |
| Sending (until "Sent")     | 5–7.7 s, composer stuck on "Sending" | 1.8 s; composer closes immediately                            |
| Single-email downloads     | 144 in 30 min                        | 15 in 4.5 h (the rest batched ahead of time)                  |

What changed: imapflow upgraded to 2.2.11 (2.0.6 put the mark-read condition in the wrong place, so Gmail refused it); recent Inbox and Sent mail downloaded ahead of time and kept on disk (up to 300 MB per account); Gmail's duplicate copies merged; "read" shows instantly; sending reports "Sent" as soon as Gmail accepts; drafts save to Gmail less often; no-reply addresses kept out of To suggestions; auto-update off.

Follow-up: the app's background process still freezes for 1–5 s now and then (17 times in 4.5 h). Not noticeable so far; look again if the app feels sticky.

### 2. Split inbox per project

**Decided:** one tab per project, 4–7 at a time. A project is defined by **the people involved**: a conversation belongs to a project when it includes one of that project's people.

**Khyati uses most:** the project tabs (two current client projects) and **Important**.

**Important, decided so far:**

- Important holds **mail from people**. Automated senders (no-reply addresses such as Asana and GitHub) are left out.
- **Exceptions are let in:** some automated mail matters, for example Crashlytics crash and failure alerts. Proposed: an "Always show in Important" action on a message that adds its sender, plus optionally a subject match, since Crashlytics shares Firebase's sender address with less urgent mail.
- **The current all-mail Inbox stays** as a tab, and stays the tab that opens on launch, until Important is tuned to Khyati's liking.
- **Who belongs to a project:** a whole company domain (for example everyone at a client's domain) plus individual addresses (for example a freelancer on Gmail). A domain rule catches new people at the client without extra setup.
- **One match is enough:** a conversation joins a project as soon as any one person on it (sender, To or Cc, in any message) is a project member. Example: a five-person thread with the client's CEO on it is in that project.
- **Only client people define projects.** Khyati's own team (the work domain's addresses) never decides a project. A conversation with clients from two projects shows in both tabs.
- **Starting rules, from Khyati's Superhuman splits (2026-11-05):**
  - The real addresses are kept out of this repo, which is public. They live in a private file outside it, `/home/khyati/me/warpmail-private/starting-tabs.json`, imported once through the app's Import.
  - One client project is defined by two individual addresses (the client uses a Gmail address, so a domain rule wouldn't work); the other by the client's company domain.
  - Superhuman also has tool splits: GitHub, Asana, Google Docs, Calendar (sender rules, plus .ics attachments for Calendar), and Shared (a Superhuman-only feature).
- **No built-in tabs.** Every tab (projects, and tool tabs such as GitHub or Asana) is one Khyati creates in the app, using the same rule type: people, domains or sender addresses. Creating a tab must be quick and easy. Calendar and Google Docs tabs aren't wanted.
- **Two ways to create and edit tabs:** "Add sender to tab…" on an email (menu and shortcut; pick a tab or type a new name), and a "+" at the end of the tab bar (name plus addresses or domains). Each tab's own menu edits, renames or deletes it.
- **Project mail shows in both** its project tab and Important. Important is the "everything from people" view; project tabs are filters on top.

**Full design:** [2026-11-05-split-inbox-design.md](2026-11-05-split-inbox-design.md) (tabs switched with Ctrl+1 to Ctrl+9; tabs only cover the inbox and never move mail; saved per computer with export and import).

### 3. Follow-up nudges and "you forgot to reply" reminders

**Decided:**

- **Follow-up:** when Khyati sent a message and the client hasn't replied after some number of days, Warpmail prompts Khyati to follow up.
- **Forgot to reply:** when Khyati received a message and hasn't answered, Warpmail reminds Khyati.
- Khyati can pause or snooze any reminder.
- Both run inside the app, no server needed.
- **Which mail counts (2026-11-05):** mail from people, the same rule as Important (automated senders left out, Khyati's Important exceptions apply). "Forgot to reply" only when Khyati is on the To line, not only Cc.
- **When (2026-11-05):** follow-up after **3 working days** without a reply to Khyati's email; forgot-to-reply after **1 working day**. Weekends don't count. Both numbers are editable in Settings. One setting for all mail, not per project.
- **How a reminder shows (2026-11-05):** the conversation comes back to the top of the inbox with a small label ("No reply in 3 days", "Waiting on you"), in inlark's look. An archived follow-up returns to the inbox (this re-adds it to Gmail's Inbox, unlike tabs, which never move mail). No separate Reminders tab; desktop notifications not chosen.
- **Every reminder can be dismissed** from the conversation (stops reminders for it), besides being snoozed to come back later.
- **Archiving counts as handled for "forgot to reply" (2026-11-05):** only conversations still in the inbox get "Waiting on you". Follow-ups still come back after archiving.
- **Which sent emails get a follow-up (2026-11-05):** only emails that **ask for something**: a question mark, or request phrases in English or French ("let me know", "can you", "could you", "please confirm", "any update", "pouvez-vous", "merci de confirmer", "tenez-moi au courant", …), checked in Khyati's own text, not the quoted reply. Khyati often sends the last email in a thread, so reminding on everything would be noise. The composer shows "Follow-up: on/off" with the reason, and one click or shortcut flips it before sending. Once feature 4's AI provider exists, AI can replace this check (an upgrade, not a requirement).
  - A plain closing "Thanks," / "Merci," is ignored (Khyati ends every email with it), as are the signature and quoted text. "Thanks in advance" / "merci d'avance" count as requests.
- **What cancels a follow-up (2026-11-05):** a reply from anyone on the thread except Khyati, from any device (Gmail is the source of truth). Automatic replies (out-of-office, `Auto-Submitted`) don't count.
- **Two laptops (2026-11-05):** reminders are worked out from the mail itself, so both laptops show the same ones. Khyati's choices (dismissing a reminder, switching follow-up off for an email) are saved as a Gmail label ("Warpmail/No reminder") so both laptops see them; the label is visible in Gmail on the web. Snoozes stay on the laptop where they're set.
- **On/off switch in Settings (2026-11-05):** the reminders feature can be turned off entirely.

**Full design:** [2026-11-05-reminders-design.md](2026-11-05-reminders-design.md). Builds on split inbox (reuses its automated-sender check), so it is built after split inbox is merged.

### 4. Draft improvement (AI)

**Decided:** this is the feature Khyati uses most. It improves a draft Khyati has written.

**Facts established:**

- Gmail's built-in Gemini "Help me write" can't be called from another app.
- A Claude subscription can't power a button inside Warpmail. It _can_ be used the other way round: an MCP server for Warpmail lets Claude (desktop or Claude Code) read and rewrite Warpmail drafts. That works through Claude's window, not a key in Warpmail.
- Google's free Gemini API tier is enough for one person, but its terms (to re-verify) allow Google to use what's sent to improve its products. That would include client emails. The paid tier doesn't, and costs very little at this volume.

**Decided (2026-11-03):**

- Build the **Improve** button now.
- **No free Gemini tier.** Client emails can contain sensitive information, and Google must not be able to use them.
- Which AI service powers the button is decided later.

**My call:** build the button against a swappable AI provider, so the service can be chosen or changed without touching the button. Options to weigh when choosing: a paid API (Claude or Gemini paid tier: content isn't used for training, but it still leaves the computer), or a model running on Khyati's own computer (fully private, weaker writing). Add the Warpmail MCP server later as a second way in through Khyati's Claude subscription.

**What "improve" means (2026-11-05):** one Improve button polishes the draft (grammar, wording, clarity) while keeping Khyati's tone and length. A small menu next to it offers one-click styles: shorter, more formal, friendlier. Drafts are written in **English**.

**Review (2026-11-05):** the improved text appears as a preview with the changes highlighted. Enter accepts, Escape keeps the original, and another style can be tried from the preview. Nothing changes until Khyati accepts.

**AI service (2026-11-05):** Anthropic's Claude API with Khyati's own key; only Khyati's draft text is sent (not the quoted email, signature or recipients). **Full design:** [2026-11-05-improve-draft-design.md](2026-11-05-improve-draft-design.md). Build once Khyati has the key.

### 5. Read status, per recipient

**Decided:**

- Shows whether a client read a message, and **who** in a thread read it.
- No website. The service must be as small as possible.
- **Hosting: a Cloudflare Worker** (decided 2026-11-03).
- The three statuses below are accepted for now. Better Apple Mail detection is a later refinement.

**How it works:**

- **Server:** one address that serves an invisible 1×1 image and records each load (time, network address, client), plus one address Warpmail polls to collect the records. Roughly 50 lines, protected with a secret so only Warpmail can read the records. Runs on any small server or a free Cloudflare Worker.
- **Per recipient:** every recipient sees the same message with the same To and Cc lines, but each copy carries its own image so opens can be told apart. Only one copy should land in Sent.
- **Apple Mail (and similar auto-loading):** Apple's servers load images on delivery, whether or not anyone reads the message. Loads from Apple's published network ranges shortly after delivery are classed as automatic, not as reads. Each recipient shows one of:
  - **Opened:** a real open
  - **Delivered to Apple Mail, can't tell:** only an automatic load was seen
  - **No signal:** for example, images blocked
  - A reply always counts as opened.

**Which emails are tracked (2026-11-05):** on by default for emails to people, with an off switch in the composer ("Read status: on", one click to turn off), like the follow-up switch. Automated addresses are never tracked.

**Where it shows (2026-11-05):** in the conversation, under each sent email, a status per recipient (for example "Opened 2× · last today 3:12 pm" or "No signal yet"), plus a small eye marker in the list for emails someone opened. No desktop notifications.

**How opens are counted:** one count per image load, with loads less than a minute apart merged, automatic loads (Apple Mail) excluded, and Khyati's own Sent copy carrying no image. Caveats to show in small print: Gmail recipients often show 1× even after several opens (Google caches the image); blocked images mean "No signal" even if read; several devices count separately; forwarded copies count as the original recipient. "Opened or not" and the first-open time are the reliable signals; the count is a rough guide.

**Colleagues too (2026-11-05):** emails to Khyati's own company are tracked like any other, with the composer switch to turn it off.

**Full design:** [2026-11-05-read-status-design.md](2026-11-05-read-status-design.md). Sending one copy per recipient is tested against Gmail first; encrypted emails are never tracked; the Worker stores no IP addresses and deletes records after 90 days.

### 6–16. Later features

Not designed yet. Notes so far:

- **Undo send (6):** a short delay after pressing send, during which the send can be cancelled. Fits inlark's existing send journal.
- **Snippets (7):** reusable text inserted from the keyboard while writing.
- **Snooze (8):** hide a conversation until a chosen time. Gmail's own snooze isn't available to other apps, so Warpmail keeps the timer; it fires when the app is open (or on next launch).
- **Scheduled send (9):** Gmail doesn't let other apps schedule sends, so either the app must be running at send time or the read-status server also sends scheduled mail (which would mean giving it mail access). To decide in its design pass.
- **Gmail labels (10):** inlark works with folders. May come partly for free with feature 1.
- **AI summaries (11):** reuses the AI provider from feature 4.
- **Calendar (12) and contact side panel (13):** Google Calendar and Contacts, reusing the Google sign-in.
- **Team sharing (14):** needs a shared server for work teammates; the biggest privacy and hosting question of the list.
- **Outlook sign-in (15):** same approach as feature 1 for Microsoft accounts.
- **Mobile (16):** a separate app; inlark plans one but hasn't started.

## Open questions across the roadmap

Raised by the review on 2026-11-03, not answered yet. Each blocks the design pass noted.

1. **Other devices.** Does Khyati also read or send mail on a phone, another computer or Gmail on the web? If yes, projects, reminders and read-status data need to sync, and replies sent elsewhere must count. Superhuman's phone app goes away on cancelling. _Blocks: 2, 3._
2. ~~**Company approval.**~~ **Answered 2026-11-05:** Khyati's company has approved both sending client email to an AI service and tracking opens on client mail. _No longer blocks 4 or 5._
3. **Where Warpmail runs.** Native Windows, or inside WSL? This affects secure password storage, notifications, and whether the app stays open all day. _Blocks: 1 (testing), 3._
4. **Switch point.** Which features must exist before cancelling Superhuman? If undo send, snooze or snippets are daily habits, they move ahead of read status. _Affects: order._

## Calls made without Khyati (can be overridden)

- **Stay mergeable with inlark.** New features live in their own modules with small, contained edits to inlark's core files, so later inlark updates (for example, if inlark adds its own Gmail sign-in) can still be pulled in. This costs little even if no merge ever happens.
- **Read-status fallback.** If sending one copy per recipient breaks Gmail's Sent folder or threading, fall back to one image per message ("opened by someone", no names), and keep per-person status only for messages with a single recipient. Revisit in feature 5's design pass.

## Left to the builder

Code structure, where new data is stored, how new settings screens look (follow inlark's existing design language), test approach (follow the repo's existing Vitest setup and `pnpm check`).

## How to use this file

- Before building a feature, run a short design pass for it: settle its "Open" questions, then update its section here.
- Update the status table as each feature moves through: needs design pass, designed, planned, in progress, done.
- Each feature gets its own implementation plan and its own branch.
