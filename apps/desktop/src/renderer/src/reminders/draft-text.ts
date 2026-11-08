import { useDeferredValue, useMemo } from 'react'
import {
  askCheck,
  ownText,
  reminderSettingsOf,
  type Draft,
  type Protocol,
  type ReminderSettings,
  type Settings,
} from '@inlark/core'
import { textSignatureMarker } from '../composer-document'

const dropped = `blockquote, .gmail_quote, [data-inlark-signature], [${textSignatureMarker}]`
const blocks = 'p, div, li, br, h1, h2, h3, h4, h5, h6, pre, tr'
/** "On Fri, Dana wrote:" or "Le ven., Dana a écrit :". */
const attribution = /wrote:\s*$|a\s+[ée]crit\s*:?\s*$/i

/** What the sender wrote: no quoted reply or its attribution line, no signature. */
export function draftOwnText(html: string, text: string): string {
  if (!html) return ownText(text)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const quote of Array.from(doc.body.querySelectorAll('blockquote'))) {
    // "On Fri, Dana wrote:" sits just before the quote.
    const before = quote.previousElementSibling
    if (
      before?.tagName === 'P' &&
      !before.matches(dropped) &&
      attribution.test((before.textContent ?? '').trim())
    )
      before.remove()
  }
  doc.body.querySelectorAll(dropped).forEach((el) => el.remove())
  // A newline per block, so the closing and name lines stay on their own lines.
  doc.body.querySelectorAll(blocks).forEach((el) => el.append('\n'))
  return ownText(doc.body.textContent ?? '')
}

/** The ask-check's guess for a draft: whether it asks the reader for something. */
export function followUpGuess(draft: Pick<Draft, 'html' | 'text'>): boolean {
  return askCheck(draftOwnText(draft.html, draft.text)).asks
}

/**
 * The guess as the draft changes. Deferred, so the check runs behind typing rather than on
 * every keystroke; a plain-text draft has no HTML, so the text counts too. Nothing runs while
 * the switch is hidden.
 */
export function useFollowUpGuess(draft: Pick<Draft, 'html' | 'text'>, shown: boolean): boolean {
  const html = useDeferredValue(draft.html)
  const text = useDeferredValue(draft.text)
  return useMemo(() => shown && followUpGuess({ html, text }), [shown, html, text])
}

export function followUpLabel(on: boolean, guessed: boolean): string {
  if (!on) return 'Follow-up: off'
  return guessed ? 'Follow-up: on (asks a question)' : 'Follow-up: on'
}

/** The switch is for IMAP drafts that have someone to follow up with, when the feature is on. */
export function followUpShown(facts: {
  protocol?: Protocol
  settings: ReminderSettings
  recipients: number
}): boolean {
  return (
    facts.protocol === 'imap' &&
    facts.settings.enabled &&
    facts.settings.followUp &&
    facts.recipients > 0
  )
}

/** The draft as sent: her choice, else the guess, only where the switch shows; else unchanged. */
export function withFollowUp(
  draft: Draft,
  protocol: Protocol | undefined,
  settings: Pick<Settings, 'reminders'>,
): Draft {
  const shown = followUpShown({
    protocol,
    settings: reminderSettingsOf(settings),
    recipients: draft.to.length + draft.cc.length + draft.bcc.length,
  })
  return shown ? { ...draft, followUp: draft.followUp ?? followUpGuess(draft) } : draft
}
