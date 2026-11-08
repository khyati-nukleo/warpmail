import { convert } from 'html-to-text'
import { askCheck, ownText } from '@inlark/core'

const maxInput = 200_000
const skipped = [
  'img',
  'blockquote',
  '.gmail_quote',
  '.gmail_attr',
  '.gmail_signature',
  '[data-inlark-signature]',
  '[data-inlark-signature-text]',
  '[data-smartmail="gmail_signature"]',
]

/** The sender's own words in an HTML body: no quoted reply, signature, images or closing. */
export function htmlOwnText(html: string): string {
  return ownText(
    convert(html.slice(0, maxInput), {
      wordwrap: false,
      selectors: skipped.map((selector) => ({ selector, format: 'skip' })),
    }),
  )
}

/** Whether a message asks for something, read from its HTML when it has one. */
export function mainAskCheck(message: { html?: string; text?: string }): boolean {
  return askCheck(message.html ? htmlOwnText(message.html) : (message.text ?? '')).asks
}
