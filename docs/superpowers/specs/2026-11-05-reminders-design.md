# Reminders: design

Feature 3 of the [Warpmail roadmap](2026-11-03-warpmail-roadmap-design.md). Decisions made with Khyati on 2026-11-05. It builds on the [split inbox design](2026-11-05-split-inbox-design.md) and reuses its rule for "mail from a person".

## What it is

Two kinds of reminder, worked out from the mail itself:

| Reminder            | When it appears                                                                                                                             | Label on the conversation |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Follow-up**       | Khyati sent an email that asks for something, and nobody has replied after **3 working days**.                                              | "No reply in 3 days"      |
| **Forgot to reply** | A person emailed Khyati (Khyati on the To line), the conversation is still in the inbox, and Khyati hasn't replied after **1 working day**. | "Waiting on you"          |

When a reminder is due, the conversation comes back to the **top of the inbox** (and of any tab it belongs to) with its label, in inlark's look. A follow-up whose conversation was archived comes back into the inbox, which re-adds it to Gmail's Inbox. That is the one place this feature moves mail.

Working days are Monday to Friday; holidays aren't skipped. Both waits are editable in Settings.

## Which mail counts

**Only mail from people.** Automated senders get no reminders in either direction. This uses the same check as Important in the split inbox design: address patterns such as noreply, plus List-Unsubscribe, List-Id, Precedence and Auto-Submitted headers. Khyati's Important "always" and "never" lists apply here too.

**Forgot to reply:**

- only when Khyati is on the **To** line, not only on Cc;
- only for conversations **still in the inbox**. Archiving means "handled, no reply needed".

**Follow-up**, only for emails that **ask for something**. Khyati often sends the last email of a thread, and reminding on every sent email would be noise. When Khyati sends, the app checks Khyati's own text for:

- a question mark;
- request phrases in English or French: "let me know", "can you", "could you", "please confirm", "any update", "when can", "thanks in advance", "pouvez-vous", "merci de confirmer", "tenez-moi au courant", "merci d'avance", and similar.

The check skips:

- the quoted email below the reply;
- the signature;
- a plain closing "Thanks," or "Merci,", which Khyati ends every email with.

**The composer shows the guess:** "Follow-up: on (asks a question)" or "Follow-up: off". One click or a shortcut flips it before sending.

**What cancels a follow-up:** a reply from **anyone on the thread except Khyati**, sent from any device, since Gmail is the source of truth. Automatic replies (out-of-office, `Auto-Submitted`) don't count.

## Dismissing and snoozing

Every reminder can be:

- **Dismissed:** no more reminders for the conversation as it stands. If the conversation starts again later (a new message), a new reminder can come; a dismissal doesn't silence it forever.
- **Snoozed:** comes back at Tomorrow morning, Monday morning, Next week, or a picked date. Morning means 9:00.

Both are available from:

- a shortcut each;
- the conversation's menu;
- the command menu (Ctrl+K).

That keeps keyboard and mouse parity.

## Two laptops

Reminders are worked out on each computer from the same Gmail mail, so both laptops show the same ones.

Khyati's choices are saved in Gmail, so both laptops respect them:

- **"Warpmail/No reminder"** marks a dismissed reminder, or a sent email whose follow-up Khyati switched off. The label is visible in Gmail on the web.
- **"Warpmail/Follow up"** marks a sent email whose follow-up Khyati switched on by hand when the guess said off. Without it, the other laptop's own check would come out off.
- **"Warpmail/Returned"** marks a sent email whose follow-up came back to the inbox. A follow-up comes back once, on whichever laptop is open when it falls due; archiving it afterwards means it's handled, so the other laptop leaves it alone. Only a snooze that ends later can bring it back again, on the computer where it was snoozed.

**Snoozes stay on the computer where they're set**, since they're short-lived.

## Settings

Settings has a **Reminders** section:

- a main on/off switch for the whole feature;
- a switch each for follow-ups and for forgot-to-reply;
- the two waits, 3 and 1 working days by default.

## When the app is closed

Reminders are worked out on launch and then kept up to date while the app runs. Any reminder that came due while the app was closed appears the next time it opens. Nothing is lost.

## Left out on purpose

Each was decided, not forgotten. Revisit any of them later.

| Left out                                             | Why                                                                                                      | Decided by         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------ |
| A separate Reminders tab                             | Reminders come back to the top of the inbox instead.                                                     | Khyati             |
| Desktop notifications for reminders                  | Not chosen; the inbox position and label are enough.                                                     | Khyati             |
| Different waits per project                          | One setting for all mail is simpler.                                                                     | Khyati             |
| Follow-ups on every sent email                       | Too noisy: Khyati often sends the last email of a thread.                                                | Khyati             |
| AI deciding which emails need a follow-up            | No trusted AI service yet. Once feature 4's provider exists, AI can replace the ask-check as an upgrade. | Khyati             |
| Reminders for emails where Khyati is only on Cc      | Cc'd mail is usually FYI.                                                                                | Khyati             |
| "Forgot to reply" for archived mail                  | Archiving counts as handled.                                                                             | Khyati             |
| Reminders about automated mail                       | Same rule as Important.                                                                                  | Claude             |
| Holidays as non-working days                         | Monday to Friday only for now.                                                                           | Claude             |
| Syncing snoozes between laptops                      | Short-lived. Dismissals and switches do sync, through Gmail labels.                                      | Claude             |
| Reminders running while the app is closed            | The app is desktop-only, with no server. Missed reminders appear on the next launch.                     | Roadmap constraint |
| Only replies from the To line cancelling a follow-up | A colleague answering for the client counts too: any reply except Khyati's cancels it.                   | Khyati             |

## Decision log

Decided with Khyati, 2026-11-05:

1. Two reminder kinds: follow-up and forgot to reply. Both run inside the app with no server, and both can be snoozed or paused.
2. Mail from people only, the same rule as Important. Forgot-to-reply needs Khyati on the To line.
3. Waits: 3 working days for follow-up, 1 for forgot-to-reply. Weekends don't count; editable; one setting for all mail.
4. A due reminder brings the conversation back to the top of the inbox with a label. Archived follow-ups return to the inbox.
5. Every reminder can be dismissed.
6. Archiving counts as handled for forgot-to-reply; follow-ups still come back after archiving.
7. Follow-ups only for emails that ask for something (question mark or request phrases, English and French). The composer shows the guess with its reason and can flip it.
8. A plain closing "Thanks," is ignored; "thanks in advance" and "merci d'avance" count as requests.
9. A reply from anyone on the thread except Khyati cancels a follow-up; automatic replies don't.
10. Dismissals and follow-up switches are saved as Gmail labels so both laptops agree.
11. A Settings switch turns the feature off.

Proposed by Claude, approved by Khyati (2026-11-05):

12. A main switch, plus one switch per reminder kind, with the waits next to them.
13. Snooze presets: Tomorrow morning, Monday morning, Next week, a picked date; morning = 9:00.
14. Working days are Monday to Friday; holidays aren't skipped.
15. Reminders that came due while the app was closed appear on next launch.
16. A shortcut and a menu item for dismiss and snooze.
17. A dismissal covers the conversation as it stands; a new message can bring a new reminder.
18. No reminders about automated mail.
19. Reminders are worked out locally from mail already on the computer, so the inbox stays as fast as now.

Builder-level calls by Claude (can be overridden):

20. A second label, "Warpmail/Follow up", for follow-ups switched on by hand, so the other laptop doesn't re-guess them as off.
21. Snoozes are stored locally, with the other settings.
22. (2026-11-07) A third label, "Warpmail/Returned", on the ask whose follow-up came back to the inbox, so a returned follow-up comes back once across both laptops; archiving it afterwards means handled. Before, only the computer that moved it remembered, so the other laptop moved it back again. Created on first use and hidden like the other two.

## How it's built (for the builder)

**Depends on split inbox.** It reuses:

- the automated-sender check and its index columns (schema v4);
- the Important always and never lists.

Build reminders after split inbox is merged.

**Reminder state is derived, not stored.** For each conversation, compute from the local index:

- the latest message;
- who sent it;
- whether Khyati is on its To line;
- whether it's in INBOX;
- whether a later message exists from someone other than Khyati.

From that, plus working days and the waits, compute "due at". Only Khyati's choices are stored: labels in Gmail, and snoozes locally.

**The ask-check** runs at send time on the draft's own text, as a pure, tested function that strips quoted text, the signature and a plain closing.

- The other laptop runs the same function on the Sent copy. Sent mail from the last 30 days is already downloaded ahead of time by the speed work, so no extra download is needed for recent mail.
- The No reminder and Follow up labels override the result.

**Gmail labels over IMAP.** Gmail shows labels as folders, so adding a label means copying the message to the label's folder. imapflow can also set `X-GM-LABELS` directly.

- The app doesn't support labels yet; add the smallest support needed.
- Hide the `Warpmail/` folders from the folder list.
- Make sure the Gmail duplicate merging (one message per `X-GM-MSGID`) ranks these label folders lowest, so they never become the copy that's shown.
- Create the labels on first use.

**Inbox order.** A due reminder sorts the conversation by its due time instead of its last message time, so it rises to the top. The SQL ordering and paging (`conversationSource` in `sqlite-index.ts`) must stay correct. Keep it as fast as the plain inbox.

**Returning archived follow-ups to the inbox** uses the existing move path, so undo works as for any move.

**Tests:**

- The ask-check, with English and French cases, quoted text, signatures and "Thanks,".
- Working-day arithmetic, including weekends, Friday-to-Monday and time zones.
- Derivation of reminder state from index fixtures: To versus Cc, automated senders, out-of-office replies, colleague replies, Gmail duplicates.
- Label round trip on the fake IMAP server.
- Snooze, plus catching up on launch.
- Inbox ordering and paging with due reminders.

**Public repo:** use `example.com` addresses in tests and fixtures. Never real ones.
