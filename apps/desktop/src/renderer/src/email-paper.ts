/** Where mail clients put a signature, and where they put the quoted history of a reply. */
const signatures =
  '.gmail_signature,[data-smartmail="gmail_signature"],.moz-signature,#Signature,div.signature'
const quotes = 'blockquote,.gmail_quote'
/** Marks a signature or quote that keeps white paper while the rest of the mail uses the theme. */
export const paperClass = 'inlark-paper'

/** Backgrounds, table layouts or images (logos are usually drawn for white). */
const hasOwnStyling = (root: ParentNode) =>
  !!root.querySelector('[bgcolor],[background],table table,img') ||
  [...root.querySelectorAll('[style]')].some((element) =>
    /(?:^|;)\s*background(?:-color|-image)?\s*:/i.test(element.getAttribute('style') || ''),
  )
/** What the sender wrote here, without signatures or quoted history. */
const ownContent = (root: ParentNode) => {
  const copy = root.cloneNode(true) as ParentNode
  for (const element of copy.querySelectorAll(signatures + ',' + quotes)) element.remove()
  return copy
}

/**
 * Designed mail is shown on white paper, as its sender made it. A note whose only styling is a
 * signature or quoted history adopts the app theme, so a short reply reads like part of the app.
 */
export const needsPaper = (root: DocumentFragment) => hasOwnStyling(ownContent(root))

/**
 * On the theme, a styled signature or a designed quote keeps a small white card, so a logo drawn
 * for white stays visible. Quotes count only their own content, not the signatures inside them.
 */
export const markPaperCards = (root: DocumentFragment) => {
  for (const element of root.querySelectorAll(signatures + ',' + quotes)) {
    if (element.parentElement?.closest('.' + paperClass)) continue
    const styled = element.matches(signatures)
      ? hasOwnStyling(element)
      : hasOwnStyling(ownContent(element))
    if (styled) element.classList.add(paperClass)
  }
}
