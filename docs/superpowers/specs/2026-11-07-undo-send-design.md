# Undo send: design

Status: approved by Khyati (2026-11-07), built on `feat/undo-send`.

## What it is

After pressing Send, the email waits a few seconds before it leaves, so a wrong recipient, a
missing attachment or a typo can still be caught. A bar at the bottom of the window counts down
("Sending in 10s · Undo"). Undo puts the draft back in the composer exactly as it was. Nothing
reaches the server before the countdown ends, so Undo always works while the bar shows it.

## What Khyati decided

1. **Setting "Undo send":** Off, 5, 10, 20 or 30 seconds. Default **10 seconds** (Gmail gives
   about 3 s; Khyati wants 10).
2. **Pressing Send:** the composer closes and the bar shows "Sending in 10s · Undo", counting
   down. Undo reopens the draft exactly as it was: recipients, subject, body, attachments,
   reply/thread context, encryption choice, and the Read status and follow-up switches.
3. **The email leaves only when the countdown ends.** Nothing reaches the server (SMTP or the
   IMAP Sent folder) before then. After the countdown the existing send flow runs unchanged:
   "Sending…" then "Sent", the send journal, Read status's per-recipient copies and Sent-copy
   replacement, Reminders' labelling. With the setting Off, sending behaves exactly as today.
4. **Second setting "If you close the app during the countdown":**
   - **Send it anyway** (default): the window closes straight away, but the app keeps running
     out of sight until the pending email(s) are sent, then quits.
   - **Keep it as a draft:** the email isn't sent and stays in Drafts.
5. **If the app is killed instead of closed** (crash, laptop shut mid-countdown): on the next
   launch, follow the same setting: send it, or leave it in Drafts. **Never send twice.**
6. **Scheduled send is out of scope.** It can reuse this later.

## How it works

### Where the countdown lives

The countdown runs in the **main process** (`apps/desktop/src/main/undo-send.ts`), not in the
window, so closing or reloading the window never drops a pending email. Each pending send is a
small record in the local store file `undo-sends.json`, next to the send journal
(`submissions.json`):

| Field       | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `draftId`   | The draft being sent. The draft itself stays in Drafts, unchanged.            |
| `accountId` | Its account, for the bar and to wait for the connection after a relaunch.     |
| `subject`   | Shown in the bar when several sends are pending. Never logged.                |
| `updatedAt` | The draft's version when Send was pressed.                                    |
| `dueAt`     | When the countdown ends.                                                      |
| `state`     | `waiting` (Undo still possible) or `sending` (handed to the normal send flow) |

No message content is copied into this record: the draft in Drafts is the only copy, so Undo,
"Keep it as a draft" and a crash all find it where it always was.

### Pressing Send

1. The composer saves the draft (as today) and closes.
2. The window calls `sendWithUndo(draft)`. With the setting Off, this is exactly today's `send`.
   Otherwise main saves the draft, writes the pending record (durably) and starts the timer.
3. The bar shows "Sending in 10s · Undo". `Z` (the existing Undo shortcut) also undoes it.
4. When the timer fires, main **first** marks the record `sending` (synchronously, then on disk),
   then hands the draft to the existing `send`. From that moment Undo answers "too late" and the
   bar shows "Sending…". The send journal takes over from there, exactly as today.
5. When `send` returns, the record is removed and the window shows the usual result ("Message
   sent.", a partial send, or a failure with "Open draft").

### Undo

Undo and the timer both run on main's single thread and check the record's state before changing
it, so exactly one of them wins:

- record `waiting` → the timer is cleared, the record removed, and the draft returned to the
  window, which reopens it in the composer. Nothing was sent.
- record `sending` or gone → "Too late to undo. It's already sending." The bar shows the normal
  sending state.

### Several pending sends, several accounts

Each pending send has its own row in the bar, with its own countdown and Undo, newest at the
bottom (at most three rows, then "+N more"). With one row it reads "Sending in 8s · Undo". With
several, each row starts with the subject, so you know which one you're undoing. With more than
one account, rows also name the account, as other notices in inlark do. `Z` undoes the newest one.

### Closing the app during a countdown

"Closing" means quitting inlark. When inlark keeps running in the tray, closing the window just
hides it, and the countdown carries on as normal.

- **Send it anyway:** the window closes at once. Every waiting email is sent right away (nobody
  can press Undo any more, so waiting longer would only keep the app running), then inlark waits
  as it already does for sends in progress and Sent copies, and quits. The wait is capped at two
  minutes so inlark never stays hidden for good. A send the cap cuts off after submission began is
  reported on the next launch by the existing journal ("Delivery unconfirmed"), never resent; one
  cut off before it reached the journal (still waiting for its account, say) left nothing behind,
  so the next launch follows the setting for it.
- While inlark finishes out of sight, its once-a-minute refresh stops and it shows no
  notifications (new-mail and copied-code ones). Accounts stay connected, since the emails
  are being sent over them. If you open inlark again meanwhile (or click a `mailto:` link), it
  starts again as soon as it has quit, opening only the new `mailto:` link.
- A second quit request, or the system logging out or shutting down, during that wait goes
  straight through. Whatever it cuts short is recovered on the next launch as after a kill.
- **Keep it as a draft:** the waiting emails are not sent and stay in Drafts. Before quitting,
  inlark also saves each one to the server's Drafts folder (Gmail's Drafts), within the same
  capped wait, so it is in Drafts on every device too. An email whose countdown had already
  ended, and so had been handed to sending ("Sending…" in the bar), is still sent: Undo was
  already too late for it.
- The setting applies to every quit, including one that ends the existing "Finishing sending…"
  wait, and a "Restart" from Settings.

Quitting and being killed differ for an email with time left on its countdown. A quit with "Send
it anyway" sends it at once; a kill leaves it on disk, and the next launch resumes its countdown
with Undo (see below).

### After a crash or a kill

On the next launch main reads `undo-sends.json`:

| Record found                                                  | What happens                                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The send journal shows an attempt (since the countdown ended) | Dropped. The journal already knows what happened and recovers it as today (sent, unconfirmed or not sent), and says so. Never resent. |
| No attempt on record, setting "Keep it as a draft"            | Dropped. The draft stays in Drafts and is saved to the server's Drafts once its account connects.                                     |
| No attempt, "Send it anyway", countdown over (or `sending`)   | Marked `sending`, then sent once its account has connected.                                                                           |
| No attempt, "Send it anyway", countdown not over yet          | The countdown resumes with the time left, with Undo, as if the app had never stopped.                                                 |

A record marked `sending` with no attempt in the journal never got as far as submitting: the
journal reaches `preparing` on disk before anything can leave. So nothing left, and it follows the
setting instead of being silently dropped.

"Never send twice" rests on the send journal, written as `preparing` and then `submitting` before
anything leaves: a relaunch never starts a send the journal shows was attempted, and today's
`send` itself refuses to submit a draft whose journal shows a send under way or done. The
pending record also notes when it was handed over, so an attempt the server refused outright is
not quietly retried either.

If a pending send resumed after a relaunch doesn't go out (the draft changed or was deleted, or
the encryption vault is still locked), the draft in Drafts says why, as for any send that
failed. So does one "Keep it as a draft" keeps on relaunch after its countdown had ended.

An Undo always holds. Should writing it to disk fail, the write is tried again every two seconds
until it lands, and once more before quitting, so the next launch never finds the undone email
still waiting. The same goes for a countdown replaced by a second Send.

### When the draft changed meanwhile

The draft stays in Drafts during the countdown. Opening it from the Drafts list says "This
message is about to be sent. Undo it to make changes." If it was still changed or deleted (for
example discarded from the Drafts list, or edited through its server copy), the countdown ends
without sending:

- edited since Send → not sent; it stays in Drafts with your edits, and a notice says so;
- deleted → nothing is sent, and a notice says so;
- protected draft while the vault is locked (e.g. after a relaunch) → not sent, stays in Drafts.

## Left out on purpose

| Left out                                                      | Why                                                                                                                                         | Decided by     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Scheduled send ("send tomorrow at 9")                         | Out of scope. The pending-send store and timer here can carry a later due time when it is built.                                            | Khyati         |
| Undo after the email has left                                 | Impossible: once the server has it, recipients may already have it. The bar never offers it.                                                | Khyati         |
| A custom delay (e.g. 7 s)                                     | The five choices cover it.                                                                                                                  | Khyati         |
| The countdown on "Check delivery" for unconfirmed sends       | That sends nothing; it only asks the server.                                                                                                | builder's call |
| Keeping the countdown going while the app is quit             | A desktop app can't. Quit follows the second setting; a kill follows it on the next launch.                                                 | builder's call |
| Saving to Gmail's Drafts during the countdown                 | It would add a server write to every send that the send then deletes, and slow sending down. Only "Keep it as a draft" saves to the server. | builder's call |
| A "Sent" notice after a relaunch finished a pending send      | No window was waiting for it. Failures and sends that didn't go out show on the draft in Drafts and in Needs attention.                     | builder's call |
| Waiting for the vault to be unlocked to send after a relaunch | The draft can't be read until then. It isn't sent and says to unlock and send again.                                                        | builder's call |
| Resuming a countdown across "Restart" (title bar setting)     | A restart is a quit: it follows the quit setting like any other.                                                                            | builder's call |
| Undo send in the demo mode                                    | The demo sends nothing; it keeps sending immediately.                                                                                       | builder's call |
| Changing a pending send's countdown when the setting changes  | Each send keeps the delay it started with.                                                                                                  | builder's call |

## Decision log

Decided with Khyati (2026-11-07):

1. Setting "Undo send": Off, 5, 10, 20 or 30 seconds; default 10.
2. The composer closes; a bar counts down with Undo; Undo reopens the draft exactly as it was.
3. Nothing reaches the server before the countdown ends; afterwards the existing send flow runs
   unchanged. Off behaves exactly as today.
4. "If you close the app during the countdown": Send it anyway (default; window closes, the app
   finishes out of sight, then quits) or Keep it as a draft.
5. A kill follows the same setting on the next launch, and never sends twice.
6. Scheduled send is out of scope.

Builder's calls (2026-11-07):

7. **The countdown runs in main and is stored on disk** (`undo-sends.json`) with its due time;
   the draft is not copied. The window only shows the bar and asks to undo.
8. **A new `sendWithUndo` call**, so today's `send` is untouched and Off is literally today's
   code path.
9. **The send journal decides whether a send was attempted**; the pending record is marked
   `sending` with its hand-over time, and a `sending` record the journal never saw is followed
   per the setting rather than dropped (found in review: it was silently dropped at first).
10. **Quit with "Send it anyway" sends at once** instead of waiting out the countdown: Undo is
    unreachable without a window, and quitting sooner leaves less time to be cut off.
11. **The hidden wait is capped at two minutes** (today's visible wait is 30 seconds). A send
    still running at the cap is recovered by the journal on the next launch. During the wait
    inlark doesn't check mail or notify, and a request to open it relaunches it afterwards.
12. **"Keep it as a draft" also saves the draft to the server's Drafts**: at quit within the same
    capped wait, after a kill once the account connects.
13. **A relaunch with time left resumes the countdown with Undo** (send it anyway) rather than
    sending at once.
14. **Edited or deleted during the countdown → not sent.** The edit is taken as a change of mind;
    sending a version you didn't press Send on would be worse.
15. **One bar row per pending send**, newest at the bottom, at most three rows then "+N more";
    the subject is shown only when several are pending, the account only with several accounts.
16. **`Z` undoes the newest pending send** when it is more recent than the last organizing action
    shown in the toast; otherwise `Z` keeps undoing that action.
17. **Sending the same draft again while it is counting down** replaces the earlier countdown.
18. **The bar sits where the toast sits**; a toast shown at the same time moves up above it.
19. **The setting sits in Settings → General, in a new "Sending" section**, next to the other
    everyday preferences, as Gmail does.
20. **Changing the setting doesn't affect sends already counting down.**
21. **Undo while another email is open in the composer doesn't replace it**: the notice says
    "Not sent. It's in Drafts." with "Open draft", so nothing typed in the open composer is lost.
22. **During the countdown the draft is not uploaded to Gmail's Drafts** (see the table above):
    background draft saves leave a held draft alone. An existing server copy stays there until
    the email has really been sent.
23. **The draft is read again after waiting for its account**, just before it is handed to
    sending, so an edit or a delete during that wait is still honoured (found in review).
24. **A Send arriving while quitting follows the quit setting**, and a quit right after Send
    waits for that Send to be recorded first (found in review).
25. **Undo while a second Send of the same draft is still saving cancels that Send.**
26. **Opening a held draft from the Drafts list is refused** while it counts down ("Undo it to
    make changes") and while it is sending.
27. **"Newest" is the one that leaves last.** If the delay changed between two sends, `Z` undoes
    the one with the later deadline.
28. **A failed write of the pending sends is retried** (every two seconds, and once more at quit)
    rather than refusing Undo: Undo must win against the deadline at once, and the retry makes it
    stick on disk (found in review).
29. **A server draft save already running at Send is allowed to finish**, then the held copy is
    saved over it. Waiting for it first would delay the countdown bar. The draft it was saving
    reaches Gmail's Drafts, since that save began before Send (found in review).
30. **"Keep it as a draft" for a Send still saving at quit** saves it to the server once the Send
    has let go of the draft (found in review).
31. **A second quit, or a system log out or shut down, during the hidden wait goes straight
    through** instead of being refused for up to two minutes (found in review).
32. **The quit setting applies at the end of a "Finishing sending…" wait too** (found in
    review).
33. **Relaunching happens once, when quitting really goes ahead**, for a Restart and for a
    request to open during the hidden wait, without the original launch's `mailto:` link
    (found in review).
34. **A relaunch with "Keep it as a draft" notes on the draft** that an email whose countdown
    had ended was kept, not sent (found in review).
35. **A second Send of the same draft keeps its "still sending" state** when the first one's
    result comes back. Reopening a not-sent notice or a Needs attention entry for a held draft
    is refused, like the Drafts list (found in review).

## How it's built

- `packages/core/src/undo-send.ts`: the settings' choices and defaults, the `HeldSend` summary
  the window sees, and the not-sent results.
- `apps/desktop/src/main/undo-send.ts`: the `UndoSend` class (hold, undo, release, quit,
  relaunch), talking to `MailService` through a small host interface.
- `apps/desktop/src/main/service.ts`: constructs it, starts it at the end of `init`, exposes
  `sendWithUndo`, `undoSend`, `heldSends` and `heldSendsOnQuit`.
- `apps/desktop/src/main/index.ts`: IPC handlers, and the quit handling above.
- Renderer: `undo-send/UndoSendBar.tsx` (the bar), `undo-send/UndoSendSettings.tsx` (the
  section), and small hooks in `App.tsx`, `background-send.ts` and `Settings.tsx`.
