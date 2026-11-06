# Improve draft: design

Feature 4 of the [Warpmail roadmap](2026-11-03-warpmail-roadmap-design.md). Decisions made with Khyati on 2026-11-05.

**Status:** designed; **build when Khyati has an Anthropic API key.** The company has approved sending client email to an AI service (2026-11-05).

## What it is

An **Improve** button in the composer, the feature Khyati uses most.

- **Improve** (Ctrl+J): polishes the draft (grammar, wording, clarity) and keeps Khyati's tone and length.
- **A small menu next to it** offers one-click styles: **Shorter**, **More formal**, **Friendlier**.
- Drafts are in **English**.

The button sits in inlark's composer toolbar, in inlark's look. It works from the keyboard, the mouse and the command menu (Ctrl+K).

## Reviewing the result

The improved text appears as a **preview with the changes highlighted**, word by word:

- **Enter** accepts it and replaces the draft. Ctrl+Z still brings the original back.
- **Escape** keeps the original.
- Another style can be tried straight from the preview.

**Nothing in the draft changes until Khyati accepts.** While the AI is working, the preview shows that it's waiting. Escape cancels.

## What is sent, and where

**Only Khyati's own draft text.** Not sent:

- the quoted email below the reply;
- the signature;
- recipients, subject and attachments.

The client's words never leave the computer.

**Only when Khyati presses Improve or picks a style.** Nothing is sent in the background, and nothing is sent while typing.

**The AI service is Anthropic's Claude API**, paid with Khyati's own API key. By default, Anthropic doesn't train on content sent through the API. Check the current terms when building.

The service sits behind a **swappable provider**, so another service, or a model running on the laptop, can replace it later without touching the button.

**Encrypted drafts:** Improve is turned off when the draft will be sent encrypted (OpenPGP). Sending it to an AI service would defeat the point of encrypting it.

## The API key

- **Entering it:** Khyati enters the key in **Settings → AI**.
- **Storage:** it's stored encrypted with the system's secure storage. That's the same `safeStorage` path the app already uses for email passwords, in `apps/desktop/src/main/storage.ts`.
- **Where it can go:** it never reaches the renderer, logs, exports or Gmail.
- **Calls:** only the main process calls the API.

Before a key is added, the Improve button explains in one line that it needs one and links to Settings → AI. Settings → AI also has:

- a **Test** button that checks the key;
- a **Remove key** button;
- **This month's use:** the number of improves and an estimated cost, so the cost stays a visible choice (a roadmap constraint).

## What the AI is told

Fixed instructions, kept in code:

- **Keep the meaning.** Never add facts, promises, dates or numbers.
- **Keep every name, number, date, link and email address exactly as written.**
- **Keep it in English.** Keep the greeting and the closing ("Thanks,") as they are.
- **Return only the rewritten text,** with no comments.
- **The style:** polish (the default) keeps the length and tone. Shorter, More formal and Friendlier change only what their names say.

The app checks the reply before showing it. If a name, number, date, link or email address from the draft is missing or changed, the preview flags it, so a slip is visible before accepting.

## When it fails

If the key is missing or wrong, the computer is offline, the service is down or there's a rate limit, the preview shows a short message. **The draft is never touched.** Retry is one key.

## Left out on purpose

Each was decided, not forgotten. Revisit any of them later.

| Left out                                            | Why                                                                                                                                                                  | Decided by          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Sending the email being replied to as context       | Keeps the client's words on the computer. Only Khyati's draft is sent.                                                                                               | Khyati              |
| Free Gemini tier                                    | Google could use client email to improve its products.                                                                                                               | Khyati (2026-11-03) |
| Replacing the draft without a preview               | Changes must be visible before they're accepted.                                                                                                                     | Khyati              |
| French and other languages                          | Khyati writes drafts in English.                                                                                                                                     | Khyati              |
| Free rewriting ("write it for me")                  | Improve polishes Khyati's own draft; styles are limited to shorter, more formal and friendlier.                                                                      | Khyati              |
| A model running on the laptop                       | Weaker and slower writing. The provider stays swappable, so it can be added later.                                                                                   | Khyati              |
| Using the Claude subscription instead of an API key | A subscription can't power a button inside another app. The Warpmail MCP server (Claude reading and rewriting drafts from Claude's own window) stays a later option. | Facts, 2026-11-03   |
| Improve on encrypted drafts                         | Sending them to an AI would defeat the encryption.                                                                                                                   | Claude              |
| Improving the subject line                          | Not asked for. Easy to add later.                                                                                                                                    | Claude              |
| Background suggestions while typing                 | Nothing is sent unless Khyati asks.                                                                                                                                  | Claude              |

## Decision log

Decided with Khyati:

1. An Improve button: the feature Khyati uses most (2026-11-03).
2. No free Gemini tier, because client email is sensitive (2026-11-03).
3. One button polishes, keeping tone and length, and a small menu offers Shorter, More formal and Friendlier (2026-11-05).
4. Drafts are in English (2026-11-05).
5. A preview with the changes highlighted: Enter accepts, Escape keeps the original, and nothing changes until accepted (2026-11-05).
6. Anthropic's Claude API with Khyati's own key. The design is ready now; build once the key exists (2026-11-05).
7. Only Khyati's draft is sent. The quoted email, the signature, recipients, subject and attachments stay on the computer (2026-11-05).

Proposed by Claude in this design (open to change on review):

8. Ctrl+J for Improve (unused today), plus menu and command-menu entries.
9. The key is stored with `safeStorage`, used only in the main process, with Test and Remove buttons.
10. A monthly use counter with an estimated cost in Settings → AI.
11. Fixed instructions that keep meaning, names, numbers and dates, plus an app-side check that flags any that changed.
12. Improve is off for encrypted drafts.
13. Failures never touch the draft.
14. The provider is swappable (from the 2026-11-03 roadmap call).

## How it's built (for the builder)

**Use the `claude-api` skill when building.** Use it to pick the current model, the request shape and streaming, and to confirm pricing and data-use terms. Don't rely on figures written here.

**Pieces:**

- **Provider interface in main:** `improve(text, style, signal) → stream of text`, with one Claude implementation.
  - **Call:** the request goes over HTTPS from the main process. This is an owner-chosen exception to inlark's "no hosted service" standard, like the read-status worker.
  - **Logging:** nothing is logged except counts for the monthly use figure. No text, ever.
- **Draft splitting:** a pure function that separates Khyati's own text from the quoted text and the signature, using the composer's document model in `composer-document.ts`. Only the first part is sent. The rest is put back unchanged on accept.
- **Preview and word diff** in the composer, plus the check that flags changed names, numbers, dates, links and addresses.
- **Settings → AI:** the key, Test, Remove, and the use counter. Add the new settings keys to `settingsSchema`, but keep the key itself in secure storage, not in settings.
- **Cancellation:** Escape aborts the request.

**Tests:**

- Draft splitting: replies, forwards, signatures, the "Thanks," closing.
- The changed-facts check.
- The provider, against a fake HTTP server: streaming, errors, abort.
- The key is never exposed to the renderer.
- The encrypted-draft guard.
- Composer flows: preview, accept, undo, escape, retry.

**Public repo:** use made-up drafts and `example.com` addresses in tests. Never real ones.
