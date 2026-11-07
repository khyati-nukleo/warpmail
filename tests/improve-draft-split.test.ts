// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '../apps/desktop/node_modules/@tiptap/react'
import StarterKit from '../apps/desktop/node_modules/@tiptap/starter-kit'
import { SignatureParagraph } from '../apps/desktop/src/renderer/src/composer-document'
import {
  flattensFormatting,
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
/** A document as the composer parses it from a resumed draft's HTML. */
function parsed(html: string): JSONContent {
  const editor = new Editor({
    element: null,
    // The composer's own StarterKit settings (Composer.tsx).
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, horizontalRule: false }),
      SignatureNode,
      SignatureParagraph,
    ],
    content: html,
  })
  const json = editor.getJSON()
  editor.destroy()
  return json
}

/** The text sent keeps the user's sentence and none of the client's mail or the signature. */
function expectOnlyOwn(html: string, own: string, others: string[]): void {
  const { text } = splitDraft(parsed(html))
  expect(text).toContain(own)
  for (const other of others) expect(text).not.toContain(other)
}

const clientParts = ['Lee Client', 'lee@example.com', 'Budget', "The client's private text."]

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

  it('keeps underline, strikethrough and code through accept too', () => {
    const own: JSONContent[] = [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Run ' },
          { type: 'text', text: 'npm test', marks: [{ type: 'code' }] },
          { type: 'text', text: ' before ' },
          { type: 'text', text: 'Friday', marks: [{ type: 'underline' }] },
          { type: 'text', text: ', not ' },
          { type: 'text', text: 'Monday', marks: [{ type: 'strike' }] },
        ],
      },
    ]
    const [kept] = ownTextContent('Please run npm test before Friday, not Monday.', own)
    expect(kept.content).toContainEqual({
      type: 'text',
      text: 'npm test',
      marks: [{ type: 'code' }],
    })
    expect(kept.content).toContainEqual({
      type: 'text',
      text: 'Friday',
      marks: [{ type: 'underline' }],
    })
    expect(kept.content).toContainEqual({
      type: 'text',
      text: 'Monday',
      marks: [{ type: 'strike' }],
    })
  })

  it('tells when accepting would flatten a nested list', () => {
    const item = (text: string, ...more: JSONContent[]): JSONContent => ({
      type: 'listItem',
      content: [p(text), ...more],
    })
    const flat: JSONContent = { type: 'bulletList', content: [item('one'), item('two')] }
    const nested: JSONContent = {
      type: 'bulletList',
      content: [item('one', { type: 'bulletList', content: [item('inner')] }), item('two')],
    }
    expect(flattensFormatting([p('Plan:'), flat])).toBe(false)
    expect(flattensFormatting([p('Plan:'), nested])).toBe(true)
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

  describe('resumed drafts written in other mail apps', () => {
    it('stops at a Gmail forward header', () => {
      expectOnlyOwn(
        '<div dir="ltr">FYI, see below.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername">Lee Client</strong> <span>&lt;lee@example.com&gt;</span><br>Date: Wed, Nov 5, 2026 at 9:12 AM<br>Subject: Budget<br>To: &lt;khyati@example.com&gt;<br></div><br><br><div dir="ltr">The client\'s private text.</div></div>',
        'FYI, see below.',
        [...clientParts, 'Forwarded message', 'khyati@example.com'],
      )
    })

    it('stops at a Gmail reply line in English and in French', () => {
      expectOnlyOwn(
        '<div dir="ltr">Sounds good, thanks.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Wed, Nov 5, 2026 at 9:12 AM Lee Client &lt;lee@example.com&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex">The client\'s private text.</blockquote></div>',
        'Sounds good, thanks.',
        [...clientParts, 'wrote:'],
      )
      expectOnlyOwn(
        '<div dir="ltr">Merci, c’est parfait.</div><br><div class="gmail_quote"><div class="gmail_attr">Le mer. 5 nov. 2026, à 09 h 12, Lee Client &lt;lee@example.com&gt; a écrit&nbsp;:<br></div><blockquote class="gmail_quote">The client\'s private text.</blockquote></div>',
        'Merci, c’est parfait.',
        [...clientParts, 'a écrit'],
      )
    })

    it('puts a French reply line back with its quote', () => {
      const split = splitDraft(
        doc(
          p('Merci.'),
          p('Le mer. 5 nov. 2026, Lee <lee@example.com> a écrit :'),
          quote(p('Old')),
        ),
      )
      expect(split.text).toBe('Merci.')
      expect(split.rest).toHaveLength(2)
    })

    it('stops at a Gmail signature delimiter', () => {
      expectOnlyOwn(
        '<div>Sounds good.</div><br>-- <br><div dir="ltr" class="gmail_signature">Khyati Example<br>Example Studio</div>',
        'Sounds good.',
        ['--', 'Khyati Example', 'Example Studio'],
      )
      expectOnlyOwn(
        '<div dir="ltr">Sounds good.<br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature">Khyati Example<br>Example Studio</div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Wed, Nov 5, 2026 at 9:12 AM Lee Client &lt;<a href="mailto:lee@example.com">lee@example.com</a>&gt; wrote:<br></div><blockquote class="gmail_quote">The client\'s private text.</blockquote></div>',
        'Sounds good.',
        ['--', 'Khyati Example', 'Example Studio', ...clientParts],
      )
    })

    it('stops at an Apple Mail forward, with or without a quote around it', () => {
      expectOnlyOwn(
        '<div>FYI, see below.</div><div><br><blockquote type="cite"><div>Begin forwarded message:</div><br><div><b>From: </b>Lee Client &lt;lee@example.com&gt;</div><div><b>Subject: </b>Budget</div><div>The client\'s private text.</div></blockquote></div>',
        'FYI, see below.',
        [...clientParts, 'Begin forwarded'],
      )
      expectOnlyOwn(
        "<div>FYI, see below.</div><div><br></div><div>Begin forwarded message:</div><br><div><b>From: </b>Lee Client &lt;lee@example.com&gt;</div><div><b>Subject: </b>Budget</div><div>The client's private text.</div>",
        'FYI, see below.',
        [...clientParts, 'Begin forwarded'],
      )
    })

    it('stops at an Outlook header block and an Outlook underscore line', () => {
      expectOnlyOwn(
        '<div>Thanks, will do.</div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Lee Client &lt;lee@example.com&gt;<br><b>Sent:</b> Wednesday, November 5, 2026 9:12 AM<br><b>To:</b> Khyati &lt;khyati@example.com&gt;<br><b>Subject:</b> Budget<div>&nbsp;</div></div><div>The client\'s private text.</div>',
        'Thanks, will do.',
        [...clientParts, 'Sent:'],
      )
      expectOnlyOwn(
        "<div>Thanks, will do.</div><div>________________________________</div><div><b>From:</b> Lee Client &lt;lee@example.com&gt;<br><b>Date:</b> Wednesday, November 5, 2026 9:12 AM<br><b>Subject:</b> Budget</div><div>The client's private text.</div>",
        'Thanks, will do.',
        [...clientParts, '____'],
      )
      expectOnlyOwn(
        "<div>Merci.</div><div><b>De&nbsp;:</b> Lee Client &lt;lee@example.com&gt;<br><b>Envoyé&nbsp;:</b> mercredi 5 novembre 2026 09:12<br><b>Objet&nbsp;:</b> Budget</div><div>The client's private text.</div>",
        'Merci.',
        clientParts,
      )
    })

    it('stops at an Outlook header with non-breaking spaces after the colons', () => {
      expectOnlyOwn(
        '<div>Thanks.</div><hr><div id="divRplyFwdMsg"><b>From:</b>&nbsp;Lee Client &lt;lee@example.com&gt;<br><b>Sent:</b>&nbsp;Wednesday, November 5, 2026 9:12 AM<br><b>To:</b>&nbsp;Khyati<br><b>Subject:</b>&nbsp;Budget</div><div>The client\'s private text.</div>',
        'Thanks.',
        clientParts,
      )
    })

    it('stops at plain-text quote lines, with a wrapped reply line or none', () => {
      const lines = (...texts: string[]): JSONContent => ({
        type: 'paragraph',
        content: texts.flatMap((text, index): JSONContent[] =>
          index ? [{ type: 'hardBreak' }, { type: 'text', text }] : [{ type: 'text', text }],
        ),
      })
      const wrapped = splitDraft(
        doc(
          p('Thanks, sounds good.'),
          lines('On Wed, Nov 5, 2026 at 9:12 AM Lee Client <', 'lee@example.com> wrote:'),
          p('> SECRET client text.'),
        ),
      )
      expect(wrapped.text).not.toContain('SECRET')
      expect(wrapped.text).toBe('Thanks, sounds good.')
      const bare = splitDraft(doc(p('Thanks.'), lines('> quoted', '> SECRET client text.')))
      expect(bare.text).toBe('Thanks.')
    })

    it('stops at loose forward and original-message headers', () => {
      for (const header of [
        '---------- Forwarded message ---------',
        '-------- Forwarded Message --------',
        '---------- Message transféré ---------',
        '-----Original Message-----',
        '----- Original Message -----',
        "-----Message d'origine-----",
        'Début du message réexpédié :',
      ]) {
        const split = splitDraft(doc(p('Yes.'), p(header + '\nFrom: Lee Client'), p('Old')))
        expect(split.text, header).toBe('Yes.')
      }
    })

    it('never sends a paragraph that has a quote or signature further down it', () => {
      // A plain-text draft becomes one paragraph with hard breaks.
      expectOnlyOwn(
        "<p>Hi there,<br>The report is ready.<br><br>On Wed, Nov 5, 2026, Lee Client &lt;lee@example.com&gt; wrote:<br>&gt; The client's private text.<br>-- <br>Khyati Example</p>",
        '',
        [...clientParts, 'Khyati Example'],
      )
      expectOnlyOwn('<p>Hi there,</p><p>Sounds good.<br>-- <br>Khyati Example</p>', 'Hi there,', [
        'Sounds good.',
        'Khyati Example',
      ])
    })
  })
})
