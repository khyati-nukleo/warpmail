/**
 * Signatures written by other mail apps, as `email-paper.ts` recognises them (copied, so that
 * inlark file stays untouched).
 */
const signatures =
  '.gmail_signature,[data-smartmail="gmail_signature"],.moz-signature,#Signature,div.signature'
const quotes = 'blockquote,.gmail_quote'
/** The marker the composer's signature block is parsed from (`signature.tsx`). */
const marker = 'data-inlark-signature'

/**
 * A draft started in Gmail, Outlook or Thunderbird keeps its signature as ordinary markup, which
 * the composer would otherwise read as the user's own text. This wraps the first such signature
 * outside the quoted email in the composer's signature block, so it's shown as one block, never
 * sent to Improve, and kept exactly as written.
 */
export function markForeignSignatures(html: string): string {
  if (!html) return html
  const document = new DOMParser().parseFromString(html, 'text/html')
  const found = [...document.body.querySelectorAll(signatures)].find(
    (element) => !element.closest(quotes) && !element.closest('[' + marker + ']'),
  )
  if (!found) return html
  const block = document.createElement('div')
  block.setAttribute(marker, '')
  found.replaceWith(block)
  block.append(found)
  return document.body.innerHTML
}
