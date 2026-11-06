import { describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '../apps/desktop/node_modules/@tiptap/react'
import StarterKit from '../apps/desktop/node_modules/@tiptap/starter-kit'
import { SignatureParagraph } from '../apps/desktop/src/renderer/src/composer-document'
import {
  joinDraft,
  ownRange,
  ownTextContent,
  splitDraft,
} from '../apps/desktop/src/renderer/src/improve/draft-split'
import { SignatureNode } from '../apps/desktop/src/renderer/src/signature'

vi.mock('../apps/desktop/src/renderer/src/api', () => ({ api: {} }))

const p = (text = ''): JSONContent => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
})
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const quote = (...content: JSONContent[]): JSONContent => ({ type: 'blockquote', content })
const htmlSignature: JSONContent = { type: 'signature', attrs: { html: '<b>Khyati</b>' } }
const textSignature: JSONContent = {
  type: 'paragraph',
  attrs: { signature: true },
  content: [
    { type: 'hardBreak' },
    { type: 'text', text: 'Khyati' },
    { type: 'hardBreak' },
    { type: 'text', text: 'example.com' },
  ],
}
const list = (type: string, ...items: string[]): JSONContent => ({
  type,
  content: items.map((item) => ({ type: 'listItem', content: [p(item)] })),
})

describe('draft splitting', () => {
  it('sends only the text above a reply quote', () => {
    const split = splitDraft(
      doc(
        p('Hi Sam,'),
        p('The report is ready.'),
        p('Thanks,'),
        p('On 5 Nov 2026, Lee <lee@example.com> wrote:'),
        quote(p('Can you send the report?')),
      ),
    )
    expect(split.text).toBe('Hi Sam,\n\nThe report is ready.\n\nThanks,')
    expect(split.rest).toHaveLength(2)
    expect(split.text).not.toContain('Can you send')
  })

  it('leaves out a plain signature paragraph and an HTML signature node', () => {
    const plain = splitDraft(doc(p('Hello'), textSignature))
    const html = splitDraft(doc(p('Hello'), htmlSignature))
    expect(plain.text).toBe('Hello')
    expect(html.text).toBe('Hello')
    expect(plain.text).not.toContain('example.com')
    expect(html.text).not.toContain('Khyati')
  })

  it('stops at a forwarded message header', () => {
    const split = splitDraft(
      doc(
        p('FYI, see below.'),
        p('---------- Forwarded message ----------\nFrom: Lee <lee@example.com>'),
        p('Body'),
      ),
    )
    expect(split.text).toBe('FYI, see below.')
    expect(split.rest).toHaveLength(2)
  })

  it('stops at an Original Message header and a quote without a blockquote', () => {
    expect(splitDraft(doc(p('Yes.'), p('-----Original Message-----'), p('Old'))).text).toBe('Yes.')
    expect(splitDraft(doc(p('Yes.'), p('On Mon, Lee wrote:'), p('Old'))).text).toBe('Yes.')
  })

  it('keeps the "Thanks," closing in the text that is sent', () => {
    const split = splitDraft(doc(p('Sounds good.'), p('Thanks,'), htmlSignature))
    expect(split.text.endsWith('Thanks,')).toBe(true)
  })

  it('returns empty text when there is only a signature or a quote', () => {
    for (const content of [
      [p(''), htmlSignature],
      [p(''), quote(p('Old message'))],
    ]) {
      const split = splitDraft(doc(...content))
      expect(split.text).toBe('')
      expect(split.own).toHaveLength(0)
    }
  })

  it('keeps leading and trailing blank paragraphs out of the own text', () => {
    const split = splitDraft(doc(p(), p('Hi'), p(), htmlSignature))
    expect(split.before).toHaveLength(1)
    expect(split.own).toEqual([p('Hi')])
    expect(split.rest).toEqual([p(), htmlSignature])
  })

  it('serializes hard breaks and lists', () => {
    const split = splitDraft(
      doc(
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'hardBreak' },
            { type: 'text', text: 'b' },
          ],
        },
        list('bulletList', 'one', 'two'),
        list('orderedList', 'x', 'y'),
      ),
    )
    expect(split.text).toBe('a\nb\n\n- one\n- two\n\n1. x\n2. y')
  })

  it('puts the quote and signature back unchanged on join', () => {
    const split = splitDraft(
      doc(p(), p('Old text'), p('On Mon, Lee wrote:'), quote(p('Q')), textSignature),
    )
    const joined = joinDraft(split, ownTextContent('Hello there.', split.own))
    expect(joined.content!.slice(-split.rest.length)).toEqual(split.rest)
    expect(joined.content![0]).toEqual(split.before[0])
    expect(joined.content![1]).toEqual(p('Hello there.'))
  })

  it('re-applies marks whose text survives', () => {
    const own: JSONContent[] = [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Meet on ' },
          { type: 'text', text: 'Friday', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' at ' },
          {
            type: 'text',
            text: 'the agenda',
            marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }],
          },
        ],
      },
    ]
    const [kept] = ownTextContent('Let’s meet on Friday; see the agenda.', own)
    expect(kept.content).toEqual([
      { type: 'text', text: 'Let’s meet on ' },
      { type: 'text', text: 'Friday', marks: [{ type: 'bold' }] },
      { type: 'text', text: '; see ' },
      {
        type: 'text',
        text: 'the agenda',
        marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }],
      },
      { type: 'text', text: '.' },
    ])
    const [dropped] = ownTextContent('Let’s meet Monday.', own)
    expect(dropped.content).toEqual([{ type: 'text', text: 'Let’s meet Monday.' }])
  })

  it('rebuilds lists and hard breaks from text', () => {
    const [intro, bullets, numbers, lines] = ownTextContent(
      'Plan:\n\n- one\n- two\n\n1. a\n2. b\n\nx\ny',
      [],
    )
    expect(intro).toEqual(p('Plan:'))
    expect(bullets).toEqual(list('bulletList', 'one', 'two'))
    expect(numbers).toEqual(list('orderedList', 'a', 'b'))
    expect(lines.content).toEqual([
      { type: 'text', text: 'x' },
      { type: 'hardBreak' },
      { type: 'text', text: 'y' },
    ])
    const two = ownTextContent('Plan:\n\n- one\n- two', [])
    expect(two).toHaveLength(2)
    expect(two[1].content).toHaveLength(2)
  })

  it('finds the document range of the own text', () => {
    const make = (content: JSONContent) =>
      new Editor({
        element: null,
        extensions: [StarterKit, SignatureNode, SignatureParagraph],
        content,
      })
    const editor = make(doc(p('Hi'), p('Text'), htmlSignature))
    const range = ownRange(editor.state.doc)!
    expect(editor.state.doc.textBetween(range.from, range.to, '|')).toBe('Hi|Text')
    expect(range.from).toBe(0)
    expect(range.to).toBe(editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize)
    editor.destroy()

    const bare = make(doc(htmlSignature))
    expect(ownRange(bare.state.doc)).toBeUndefined()
    bare.destroy()
  })
})
