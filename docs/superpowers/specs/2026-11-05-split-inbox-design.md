# Split inbox: design

Feature 2 of the [Warpmail roadmap](2026-11-03-warpmail-roadmap-design.md). Decisions made with Khyati on 2026-11-05.

## What it is

A row of tabs above the conversation list. Each tab shows a slice of the inbox:

| Shortcut      | Tab               | Shows                                                                                         |
| ------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| Ctrl+1        | **Inbox**         | Everything, exactly as today. It stays the tab that opens on launch until Important is tuned. |
| Ctrl+2        | **Important**     | Mail from people. Automated mail is left out, except senders Khyati lets in.                  |
| Ctrl+3–Ctrl+9 | **Khyati's tabs** | One per client project or tool (GitHub, Asana). None come built in.                           |
| Ctrl+Tab      | Next tab          | Ctrl+Shift+Tab goes back.                                                                     |

All shortcuts can be changed in the existing shortcut settings.

## Look

inlark's look stays. Superhuman is the reference for what the feature does, not how it looks. The tab row follows inlark's existing design language (type, spacing, colours, the segmented control already used in settings), sits above the list, and works with mouse and keyboard alike. Each tab shows its unread count the way folders do today. Tabs can be dragged to reorder; Inbox and Important stay first.

## Tabs Khyati makes

A tab is a **name and a list of rules**. Each rule is either:

- an **address**, for example `someone@gmail.com`, or
- a **domain**, written `@client.example`, which covers everyone at that company (and its subdomains).

**Matching.** A conversation is in a tab when **any one person** on it (sender, To or Cc, in any message of the conversation) matches a rule. A five-person thread with a client's CEO on it is in that client's project.

**Khyati's own addresses never decide a tab.** Rules matching one of Khyati's own addresses or account domains (for example the work domain) are refused with a short explanation, since every conversation would match. A conversation with clients from two projects shows in both tabs.

**Only the inbox.** Tabs show conversations that are still in the inbox. Archiving removes a conversation from every tab. Archived mail is found through search, as today.

**Tabs are views, not folders.** A conversation in a tab also stays in Inbox (and Important if it qualifies). Nothing is moved on Gmail.

**All accounts.** Tabs cover the personal and work accounts together, and the existing account filter still narrows them.

### Creating and editing

1. **From an email:** "Add sender to tab…" in the message menu, the command menu (Ctrl+K) and a shortcut (proposed Shift+T). A small picker lists the tabs, with "New tab…" at the top; typing a new name creates the tab with that sender in it. An option in the picker adds the sender's whole domain instead, offered only when it isn't a free mail domain like gmail.com.
2. **From the tab row:** a "+" at the end opens a small box: name, then addresses and domains, one per line. Useful for setting a project up before any mail arrives.
3. **Each tab's menu** (right-click, or a keyboard action on the active tab): edit rules, rename, delete. Deleting removes only the tab and its rules, never mail.

While editing rules, the box shows how many inbox conversations match, so a mistyped domain is obvious.

### Starting tabs

Khyati's Superhuman splits become four starting tabs: two client projects, plus GitHub and Asana. **No addresses are built into the app.** This repo is public, so client addresses must never appear in code, tests or docs.

The starting tabs are saved in a private file outside the repo, `/home/khyati/me/warpmail-private/starting-tabs.json`, in the app's export format. Khyati imports it once with Settings → Inbox → Import, on each computer.

No Calendar or Google Docs tab.

## Important

A conversation is in Important when at least one message in it that's in the inbox comes from **a person**, meaning the sender isn't automated.

A sender is **automated** when any of these is true:

- The address looks like a robot: the part before `@`, with dots, dashes and underscores removed, starts with `noreply`, `donotreply` or `bounce`, or is `mailer-daemon` or `postmaster`. (The same rule autocomplete already uses, moved to shared code.)
- The message has a **List-Unsubscribe** or **List-Id** header (newsletters, mailing lists, notifications).
- The message has **Precedence: bulk, list or junk**, or **Auto-Submitted** set to anything but `no`.

**Exceptions Khyati controls:**

- **"Always show in Important"** on any email lets that sender in. Optionally, only when the subject contains certain words. This covers Crashlytics: its alerts share Firebase's sender with less urgent mail, so the rule is "this sender, subject contains _crash_ or _failure_" (Khyati edits the words).
- **"Never show in Important"** keeps a person's address out (for example a colleague's automated report sent from their own address). This is the tuning knob for anything the rules get wrong.

Both lists are edited in Settings → Inbox, and from the email's menu.

## Saving and moving between computers

Tabs, rules and the Important exceptions are saved on this computer, with the other settings. Settings → Inbox has **Export** and **Import** (one small file) to copy them to the other laptop. Automatic sync between computers is a later feature.

## Left out on purpose

Each was decided, not forgotten. Revisit any of them later.

| Left out                                     | Why                                                                                                                      | Decided by                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| Calendar and Google Docs tabs                | Not wanted. Khyati can still make them with "+" if that changes.                                                         | Khyati                    |
| Built-in tabs of any kind (GitHub, Asana, …) | Every tab is user-made, so nothing is hardcoded. The Superhuman tabs arrive through Import from a private file.          | Khyati                    |
| Superhuman's "Shared" split                  | Depends on Superhuman's team sharing (roadmap feature 14).                                                               | Claude                    |
| An "Other" tab                               | Inbox already shows everything.                                                                                          | Khyati (keep Inbox as is) |
| Tabs as folders or Gmail labels              | Tabs are views; nothing moves on Gmail, so nothing can go missing while Important is tuned.                              | Khyati                    |
| Archived mail in tabs                        | Tabs cover the inbox only, as in Superhuman. Search finds archived mail.                                                 | Khyati                    |
| Khyati's own team deciding a tab             | Own addresses and domains are refused as rules; only client people define projects.                                      | Khyati                    |
| Gmail's own "Important" marking              | Important is "mail from people" instead: predictable, and doesn't miss client mail.                                      | Khyati                    |
| Syncing tabs between computers               | Export and import cover it for now; sync is a later feature.                                                             | Khyati                    |
| Per-tab notifications or tray counts         | Notifications stay as they are.                                                                                          | Claude                    |
| Choosing which tab opens on launch           | Inbox opens until Important is tuned; then add a setting.                                                                | Khyati                    |
| JMAP accounts (non-Gmail servers) in tabs    | All of Khyati's accounts are Gmail over IMAP. JMAP accounts still show in Inbox, with a note in other tabs' empty state. | Claude                    |
| AI ranking for Important                     | Rules first; AI is a possible later refinement (reuses feature 4's AI provider).                                         | Claude                    |
| Domain rules for free mail providers         | "Add whole domain" isn't offered for gmail.com, outlook.com and similar.                                                 | Claude                    |

## Decision log

Decided with Khyati, 2026-11-05:

1. One tab per project, defined by the people involved; 4–7 projects at a time.
2. Important = mail from people. Automated senders such as Asana and GitHub are left out.
3. Exceptions are let in, for example Crashlytics failure alerts.
4. Inbox (all mail) stays as a tab and opens on launch, until Important is tuned.
5. Project mail shows in both its project tab and Important.
6. Project members: whole company domains plus individual addresses.
7. One matching person anywhere on a conversation (sender, To or Cc, any message) is enough. Example: the client's CEO on a five-person thread.
8. Only client people define projects; Khyati's own team never does. A conversation with two projects' clients shows in both.
9. No built-in tabs; every tab is created in the app. No Calendar or Google Docs tabs.
10. Both ways to create tabs: "Add sender to tab…" on an email, and "+" in the tab row.
11. Tabs cover the inbox only; tabs aren't folders; keyboard switching; unread counts; order Inbox, Important, then Khyati's tabs, draggable; deleting a tab keeps the mail; tabs cover all accounts; saved per computer with export and import.
12. Ctrl+1 to Ctrl+9 jump to tabs (inlark doesn't use these keys today).
13. Keep inlark's look, not Superhuman's (recorded as a roadmap-wide constraint).

Added by Claude in the design, approved by Khyati on review (2026-11-05):

14. "Never show in Important", the tuning knob for wrong guesses.
15. "Add sender to tab…" also offers the sender's whole domain (not for free mail domains).
16. Khyati's own addresses and domains are refused as tab rules.
17. The rule editor shows how many conversations match.
18. Khyati's Superhuman tabs (two client projects, GitHub, Asana) are provided as a private file in the export format and imported once. _Changed 2026-11-05, before building: this was first a built-in one-click import, but that would have put client addresses in the public repo's code._
19. Shift+T for "Add sender to tab…".
20. JMAP accounts left out of tabs for now.
21. Ctrl+Tab and Ctrl+Shift+Tab move between tabs.
22. Automated mail detected by address pattern, List-Unsubscribe, List-Id, Precedence and Auto-Submitted headers; headers for existing inbox mail fetched in the background.
23. Filtering done in the local index (SQL) so lists stay fast and counts stay right; index schema v4, a one-way upgrade like v3.

## How it's built (for the builder)

**Where filtering happens.** In the local index's SQL, so lists stay as fast as Inbox is today and paging and counts stay correct. Filtering after the fact in the main process or the renderer would give short pages and wrong counts.

**Index changes (schema v4):**

- **A participants table:** one row per message and address (address, domain, role), indexed on address and on domain. It is filled at index time and backfilled during migration from the address columns already stored for every message (`from_addr`, `to_addr`, `cc_addr`). No download is needed.
- **New columns for `List-Id`, `Precedence` and `Auto-Submitted`.** These headers are added to the metadata fetch for new mail. For existing mail, a background job fetches just these headers for messages in the INBOX folder (tabs only cover the inbox, so this is small). Until a message's headers arrive, Important judges it on the address rule and List-Unsubscribe, which are already stored.
- **Same one-way upgrade warning as v3.** Older builds can't open a v4 index without deleting it. Nothing on Gmail is affected.

**Query:** a new optional `tab` field on the mail query (added to the zod `querySchema`, which otherwise drops unknown keys). It is resolved in the main process to SQL conditions on the inbox scope:

- **A Khyati tab:** the thread has a participant whose address or domain matches a rule.
- **Important:** the thread has an INBOX message whose sender isn't automated or is on the always list, and isn't on the never list.

Unread counts per tab are one grouped count query.

**Rules are stored in settings** (`Settings`, with matching keys added to `settingsSchema`): tabs (id, name, rules, order) and the Important always and never lists. Matching is case-insensitive.

**Export file format** (also used for the private starting-tabs file):

```json
{
  "version": 1,
  "tabs": [{ "name": "GitHub", "rules": ["notifications@github.com", "@noreply.github.com"] }],
  "important": {
    "always": [{ "sender": "alerts@example.com", "subjectWords": ["crash"] }],
    "never": []
  }
}
```

Import adds tabs, merging rules into a tab of the same name, and never deletes anything.

**Public repo:** use `example.com` addresses in tests and fixtures. Never real ones.

**Route:** the active tab is a search parameter alongside `view`, so back and forward and the remembered last location work as they do for folders.

**Tests:**

- Matcher and automated-sender detection, as pure functions.
- Index migration and backfill, plus the SQL filters, with fixtures covering Gmail duplicates, own-address refusal, domains and subdomains.
- Paging and counts for a tab.
- Tab row keyboard behaviour (Ctrl+number, Ctrl+Tab, rebinding), the create-from-email flow, and export and import round trip.

**Speed check:** switching tabs and scrolling a tab must feel as fast as Inbox. Measure with the index test fixtures at a large mailbox size before calling it done.
