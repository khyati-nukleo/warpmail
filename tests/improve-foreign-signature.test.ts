// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '../apps/desktop/node_modules/@tiptap/react'
import StarterKit from '../apps/desktop/node_modules/@tiptap/starter-kit'
import { SignatureParagraph } from '../apps/desktop/src/renderer/src/composer-document'
import {
  joinDraft,
  ownTextContent,
  splitDraft,
} from '../apps/desktop/src/renderer/src/improve/draft-split'
import { markForeignSignatures } from '../apps/desktop/src/renderer/src/improve/foreign-signature'
import { SignatureNode } from '../apps/desktop/src/renderer/src/signature'

vi.mock('../apps/desktop/src/renderer/src/api', () => ({ api: {} }))

/** A resumed draft as the composer opens it. */
function opened(html: string): JSONContent {
  const editor = new Editor({
    element: null,
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, horizontalRule: false }),
      SignatureNode,
      SignatureParagraph,
    ],
    content: markForeignSignatures(html),
  })
  const json = editor.getJSON()
  editor.destroy()
  return json
}

const own = 'Sounds good, see you Friday.'
const cases: [string, string][] = [
  [
    'Gmail on the web',
    `<div dir="ltr">${own}</div><div dir="ltr" class="gmail_signature">Khyati Example<br>Example Studio · example.com</div>`,
  ],
  [
    'Gmail on the phone',
    `<div>${own}</div><div data-smartmail="gmail_signature">Khyati Example<br>Example Studio · example.com</div>`,
  ],
  [
    'Outlook',
    `<div>${own}</div><div id="Signature"><p>Khyati Example</p><p>Example Studio · example.com</p></div>`,
  ],
  [
    'Thunderbird',
    `<p>${own}</p><div class="moz-signature">Khyati Example<br>Example Studio · example.com</div>`,
  ],
]

describe('signatures from other mail apps', () => {
  it.each(cases)('holds back a %s signature and keeps it on accept', (_app, html) => {
    const document = opened(html)
    const split = splitDraft(document)
    expect(split.text).toBe(own)
    expect(split.text).not.toContain('Khyati Example')
    const joined = joinDraft(split, ownTextContent('Sounds good. See you Friday.', split.own))
    expect(joined.content!.slice(-split.rest.length)).toEqual(split.rest)
    expect(JSON.stringify(split.rest)).toContain('Khyati Example')
  })

  it('leaves a signature inside the quoted email alone', () => {
    const html = `<div>${own}</div><blockquote class="gmail_quote"><div>Hi</div><div class="gmail_signature">Lee Client</div></blockquote>`
    expect(markForeignSignatures(html)).not.toContain('data-inlark-signature')
    expect(splitDraft(opened(html)).text).toBe(own)
  })

  it('changes nothing in a draft without a signature from another app', () => {
    const html = `<p>${own}</p><p>Thanks,</p>`
    expect(markForeignSignatures(html)).toBe(html)
  })
})
