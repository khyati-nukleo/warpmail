# Read status: design

Feature 5 of the [Warpmail roadmap](2026-11-03-warpmail-roadmap-design.md). Decisions made with Khyati on 2026-11-03 and 2026-11-05.

**Approved:** Khyati's company has approved tracking opens on client mail (2026-11-05).

## What it is

Warpmail shows, for each email Khyati sends, **which recipient opened it and when**.

Under each sent email in a conversation, every recipient has a status:

| Status                                  | Meaning                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Opened**                              | A real open. Shown as for example "Opened 2× · last today 3:12 pm".                                           |
| **Delivered to Apple Mail, can't tell** | Only Apple's automatic image load was seen. Apple Mail loads images on delivery, whether or not anyone reads. |
| **No signal yet**                       | Nothing seen. Images may be blocked, or the email may be unread.                                              |

A reply always counts as opened.

The conversation list shows a **small eye** on emails someone has opened. There are no desktop notifications.

## How it works

1. **The pixel:** each recipient's copy of the email carries a **1×1 transparent image** in its formatted (HTML) version. The image's address is a random code on Khyati's own Cloudflare Worker. One code per recipient per email is how opens are told apart.
2. **The fetch:** when a recipient's mail app shows the email with images, it fetches the image. The Worker records the time and a rough source type: Apple's servers, Google's servers, or other.
3. **Collecting:** Warpmail asks the Worker for new records every couple of minutes while it's running. Opens that happened while the app was closed are collected at the next launch.

**Counting:** one count per fetch, with three adjustments:

- fetches less than a minute apart count once;
- Apple's automatic fetches count as "Delivered to Apple Mail" instead of as an open;
- Khyati's own Sent copy carries no image, so viewing it (in Warpmail, on the phone, or in Gmail on the web) never counts.

**Small print shown with the count.** "Opened or not" and the time of the first open are reliable; the count is a rough guide:

- Gmail recipients often show 1× after several opens, because Google fetches the image once and reuses it.
- Blocked images mean "No signal" even if the email was read.
- Several devices count separately.
- A forwarded copy's opens count as the original recipient's.

**Not secret from everyone.** Privacy-focused mail apps and tracker blockers can detect the pixel and may tell the recipient. Superhuman, HubSpot and Mailchimp work the same way.

## Which emails are tracked

- **On by default** for emails to people, including colleagues.
- **The composer shows "Read status: on"**, and one click or a shortcut turns it off for that email.
- **Never tracked:**
  - automated addresses (the same check as Important in the split inbox design);
  - encrypted (OpenPGP) emails.
- **A main switch** in Settings turns the whole feature off.

## One copy per recipient

Every recipient sees **the same email with the same To and Cc lines**, so reply-all and threading look normal. Only the hidden image differs. Bcc recipients get their own copy, as Bcc already implies.

**Khyati's Sent folder keeps one clean copy, with no image.** Gmail saves its own copy of each email sent through it. The app replaces those with a single clean copy afterwards.

**Send test: passed on 2026-11-06.** The test sent one email from the work account (Google Workspace) to two Gmail accounts, one on To and one on Cc. Every copy had identical headers and was addressed to one recipient only. Results:

- Gmail accepted both copies and kept the app's `Message-ID`.
- **Gmail merged the two copies into one Sent copy: the first one, carrying the first recipient's image.** That's why the app must replace it. Otherwise, viewing Sent in Gmail would count as the first recipient opening it.
- Deleting that copy for good and filing one clean copy worked. Gmail kept the clean copy, with no image, exactly one copy in All Mail, and To and Cc intact.
- Each recipient got the email once, with everyone on To and Cc.
- A reply-all landed in the same conversation for Khyati (same Gmail thread ID as the clean Sent copy) and for the other recipient.

The per-recipient design goes ahead, and the fallback isn't needed. **Not covered by the test:** Outlook recipients, Bcc recipients, and a Workspace account as the recipient. The risk is low, since each recipient's mailbox only ever receives one copy. The builder checks Outlook and Bcc once sending is built.

**The fallback, kept for the record** (roadmap call, 2026-11-03), in case another provider won't cooperate:

- one image per email, shown as "opened by someone";
- per-person status only for emails with a single recipient.

## The Worker

**A tiny Cloudflare Worker on Khyati's own account,** within the free tier. It has two jobs:

- serve the image and record the fetch;
- hand records to Warpmail, behind a password.

**Privacy:**

- **The codes:** image codes are random and contain no email address, name or subject.
- **What a fetch saves:** only the time and the source type, never the reader's IP address. The IP is used only at fetch time, to recognise Apple's and Google's published network ranges, and is then discarded.
- **Deletion:** records are deleted automatically after **90 days**. That leaves plenty of time for both laptops to collect them.

**The Worker's password** is entered once on each laptop in **Settings → Read status**. It's stored encrypted with the system's secure storage, like the email passwords, and never logged.

**Web address:** the default `*.workers.dev` address works. A domain Khyati owns (for example `t.<domain>`) is recommended, because spam filters trust it more.

**Setup:** the Worker's code lives in this repo under `services/read-status-worker/`, with step-by-step deploy instructions. The password is set as a Cloudflare secret, never committed.

## Two laptops

Both laptops collect from the same Worker, and records stay for 90 days, so both show the same statuses.

Each image code is worked out from the email's ID, the recipient and the Worker password, using a keyed hash. So either laptop can tell which recipient a code belongs to from the Sent copy alone. Nothing extra is stored anywhere, and someone who sees a code can't work out who it belongs to.

## Left out on purpose

Each was decided, not forgotten. Revisit any of them later.

| Left out                                   | Why                                                                | Decided by          |
| ------------------------------------------ | ------------------------------------------------------------------ | ------------------- |
| A website or dashboard                     | Not wanted. The Worker is as small as possible.                    | Khyati (2026-11-03) |
| Desktop notifications on open              | The status in the conversation and the eye in the list are enough. | Khyati              |
| Tracking every email with no switch        | Each email can be switched off in the composer.                    | Khyati              |
| Excluding colleagues                       | Khyati chose to track everyone the same.                           | Khyati              |
| Better Apple Mail detection                | The three statuses are accepted for now; a later refinement.       | Khyati (2026-11-03) |
| Storing readers' IP addresses or locations | Not needed for the statuses, and it's personal information.        | Claude              |
| Tracking encrypted emails                  | The image would reveal that an encrypted email was opened.         | Claude              |
| Tracking automated addresses               | The same rule as Important.                                        | Claude              |
| Link click tracking                        | Not asked for. It would mean rewriting links in client email.      | Claude              |
| Keeping records longer than 90 days        | Enough for both laptops to collect; less data kept.                | Claude              |

## Decision log

Decided with Khyati:

1. Per-recipient read status: who in a thread opened (2026-11-03).
2. No website; the service as small as possible; hosted on a Cloudflare Worker (2026-11-03).
3. Three statuses (Opened, Delivered to Apple Mail can't tell, No signal), with a reply counting as opened (2026-11-03).
4. On by default for emails to people, with an off switch in the composer (2026-11-05).
5. Shown under each sent email per recipient, plus an eye marker in the list; no notifications (2026-11-05).
6. Counting as described, with the caveats shown in small print (2026-11-05).
7. Colleagues are tracked too (2026-11-05).
8. A 1×1 transparent image in the HTML version (confirmed 2026-11-05).

Proposed by Claude, approved by Khyati (2026-11-05):

9. The Worker stores only the time and the source type, never IP addresses; codes are random.
10. Records are deleted after 90 days.
11. The Worker has a password, stored encrypted on each laptop.
12. Collection every couple of minutes while the app runs, catching up on launch.
13. Encrypted emails are never tracked.
14. Sent keeps one clean copy with no image.
15. Sending one copy per recipient is tested first, with the fallback if Gmail won't cooperate.
16. The Worker has step-by-step setup on Khyati's Cloudflare account, on the free tier; a custom domain is recommended.
17. A main switch in Settings.

Builder-level calls by Claude (can be overridden):

18. Image codes are a keyed hash of the email ID, the recipient and the Worker password, so both laptops match opens without storing a mapping anywhere.
19. Warpmail never loads images from the Worker's address when showing mail, so Khyati's own views never count, including when Khyati is a recipient.

## How it's built (for the builder)

**Order:**

1. ~~The send test~~: passed on 2026-11-06 (see "One copy per recipient"). The test script lives outside the repo, in Khyati's private folder, because its results contain real addresses.
2. The Worker.
3. Sending.
4. Collecting and the statuses.
5. The interface.

**Sending.** For each recipient:

- send a copy whose headers are identical: same `Message-ID`, same To and Cc lines;
- the SMTP envelope is addressed to that one recipient;
- the HTML part carries that recipient's image.

Then remove Gmail's auto-saved Sent copies (found by `Message-ID`) and file one clean copy. Do this straight after the last copy is sent, because Gmail's merged Sent copy carries the first recipient's image until it's replaced. How the send test did it, which worked:

- Find the copies in All Mail with `X-GM-RAW "rfc822msgid:<id>"` and move them to Trash. Deleting from Sent only removes the Sent label.
- Delete them from Trash for good. Find them there with a plain `HEADER Message-ID` search, since Gmail's own search can skip Trash.
- `APPEND` the clean copy to Sent with `\Seen`. Gmail accepts it even though the deleted copies had the same `Message-ID`. Use the existing send journal, so a crash midway is recoverable and never sends twice to anyone. The "Sending…" and "Sent" states from the speed work must stay accurate.

**The Worker:**

- `GET /p/<code>.gif`: returns the image with no-cache headers, and records time and source type.
- `GET /records?since=…`: needs the password, and returns records.
- Storage: KV or D1, whichever is simplest.
- A scheduled job deletes anything older than 90 days.
- Apple's and Google's published ranges are kept updatable.

**The app:**

- **Polling:** collection runs in the main process, with backoff when offline.
- **Statuses:** derived from the records plus replies in the local index.
- **Settings:**
  - Settings → Read status: Worker address, password, a Test button, and the main switch;
  - add the new keys to `settingsSchema`; keep the password in secure storage.
- **Never load the Worker's own images.** Block the Worker's address in the reader's remote-image path (`Reader.tsx` and `remoteImage`).

**Tests:**

- Code generation: the keyed hash is stable across laptops and differs per recipient.
- Per-recipient MIME, checking that headers are identical across copies.
- The send journal with partial failure.
- The Worker's endpoints and the 90-day clean-up, with Miniflare or a fake.
- Source classification.
- Counting and merging.
- Status derivation, including replies.
- The composer switch and the never-tracked rules.
- Never loading the Worker's images.

**Public repo:**

- use `example.com` addresses and made-up codes in tests;
- never commit the Worker password or Khyati's Worker address.
