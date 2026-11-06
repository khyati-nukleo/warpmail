// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { markPaperCards, needsPaper } from '../apps/desktop/src/renderer/src/email-paper'

const fragment = (html: string) => {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}
// A Superhuman signature: a logo drawn for white, layout tables and coloured badges.
const signature =
  '<div class="gmail_signature"><table style="background-color:rgb(254,255,255)"><tr><td>' +
  '<img src="logo.png" alt="Nukleo"></td><td><table><tr><td bgcolor="#00071a">MTL</td></tr>' +
  '</table></td></tr></table><div>Sent via Superhuman</div></div>'
const quoted = (inner: string) =>
  '<div class="gmail_quote">On Fri, Lesley wrote:<blockquote>' + inner + '</blockquote></div>'

describe('paper or theme', () => {
  it('keeps a plain note on the theme even when its signature carries a logo', () => {
    const root = fragment('<div>The latest I can do is 5pm.</div>' + signature)
    expect(needsPaper(root)).toBe(false)
  })
  it('ignores styled signatures and quoted history when choosing', () => {
    const root = fragment('<div>Sounds good.</div>' + signature + quoted('Earlier' + signature))
    expect(needsPaper(root)).toBe(false)
  })
  it('still shows designed mail on paper', () => {
    expect(needsPaper(fragment('<table><tr><td><table><tr><td>Sale</td></tr></table>'))).toBe(true)
    expect(needsPaper(fragment('<p>Hi</p><img src="photo.jpg">'))).toBe(true)
    expect(needsPaper(fragment('<div style="background:#123">Banner</div>'))).toBe(true)
  })
  it('puts a styled signature on a small white card, and leaves plain ones alone', () => {
    const root = fragment('<div>Hi</div>' + signature)
    markPaperCards(root)
    expect(root.querySelector('.gmail_signature')!.classList.contains('inlark-paper')).toBe(true)
    const plain = fragment('<div>Hi</div><div class="gmail_signature">Khyati</div>')
    markPaperCards(plain)
    expect(plain.querySelector('.inlark-paper')).toBeNull()
  })
  it('cards quoted mail only when the quote itself is designed, not just its signatures', () => {
    const conversation = fragment('<div>Hi</div>' + quoted('Earlier note' + signature))
    markPaperCards(conversation)
    expect(conversation.querySelector('.gmail_quote')!.classList.contains('inlark-paper')).toBe(
      false,
    )
    expect(conversation.querySelectorAll('.inlark-paper')).toHaveLength(1)
    const newsletter = fragment(
      '<div>FYI</div>' + quoted('<table><tr><td><table><tr><td>Sale</td></tr></table>'),
    )
    markPaperCards(newsletter)
    // The quoted mail itself gets the card, not the “Lesley wrote:” line above it.
    expect([...newsletter.querySelectorAll('.inlark-paper')].map((e) => e.tagName)).toEqual([
      'BLOCKQUOTE',
    ])
  })
})
