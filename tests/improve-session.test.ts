import { improveErrorMessages } from '@inlark/core'
import { describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '../apps/desktop/node_modules/@tiptap/react'
import StarterKit from '../apps/desktop/node_modules/@tiptap/starter-kit'
import { SignatureParagraph } from '../apps/desktop/src/renderer/src/composer-document'
import { acceptImprovement } from '../apps/desktop/src/renderer/src/improve/apply-improvement'
import { changedFacts } from '../apps/desktop/src/renderer/src/improve/changed-facts'
import {
  encryptionUndecided,
  improveAvailability,
  improveReducer,
  previewKeyAction,
  type ImproveSession,
} from '../apps/desktop/src/renderer/src/improve/improve-session'
import { wordDiff } from '../apps/desktop/src/renderer/src/improve/word-diff'
import { SignatureNode } from '../apps/desktop/src/renderer/src/signature'

vi.mock('../apps/desktop/src/renderer/src/api', () => ({ api: {} }))

const closed: ImproveSession = { phase: 'closed' }
const original = 'the report are ready.'
const improved = 'The report is ready.'

describe('improve session', () => {
  it('waits, shows partial text, then a preview with diff and facts', () => {
    const waiting = improveReducer(closed, { type: 'start', id: 'a', style: 'polish', original })
    expect(waiting).toEqual({ phase: 'waiting', id: 'a', style: 'polish', original, partial: '' })
    const partial = improveReducer(waiting, { type: 'partial', id: 'a', text: 'The rep' })
    expect(partial).toMatchObject({ phase: 'waiting', partial: 'The rep' })
    const preview = improveReducer(partial, {
      type: 'result',
      id: 'a',
      result: { ok: true, text: improved },
    })
    expect(preview).toEqual({
      phase: 'preview',
      id: 'a',
      style: 'polish',
      original,
      text: improved,
      diff: wordDiff(original, improved),
      facts: changedFacts(original, improved),
    })
  })

  it('ignores events from an older request', () => {
    const a = improveReducer(closed, { type: 'start', id: 'a', style: 'polish', original })
    const b = improveReducer(a, { type: 'start', id: 'b', style: 'shorter', original })
    expect(b).toMatchObject({ phase: 'waiting', id: 'b', style: 'shorter' })
    expect(improveReducer(b, { type: 'partial', id: 'a', text: 'stale' })).toBe(b)
    expect(
      improveReducer(b, { type: 'result', id: 'a', result: { ok: true, text: 'stale' } }),
    ).toBe(b)
  })

  it('closes on a cancelled result and shows other errors', () => {
    const waiting = improveReducer(closed, { type: 'start', id: 'a', style: 'polish', original })
    const cancelled = improveReducer(waiting, {
      type: 'result',
      id: 'a',
      result: { ok: false, error: 'cancelled', message: '' },
    })
    expect(cancelled).toEqual(closed)
    const failed = improveReducer(waiting, {
      type: 'result',
      id: 'a',
      result: { ok: false, error: 'rateLimit', message: improveErrorMessages.rateLimit },
    })
    expect(failed).toEqual({
      phase: 'error',
      id: 'a',
      style: 'polish',
      original,
      message: improveErrorMessages.rateLimit,
    })
    expect(improveReducer(failed, { type: 'close' })).toEqual(closed)
  })

  it('turns Improve off for encrypted drafts, missing keys, empty text and locked drafts', () => {
    const base = { protection: 'none' as const, hasKey: true, ownText: 'Hello', locked: false }
    expect(improveAvailability(base)).toEqual({ available: true })
    expect(improveAvailability({ ...base, protection: 'encrypt' })).toEqual({
      available: false,
      reason: 'encrypted',
    })
    expect(improveAvailability({ ...base, protection: 'sign' })).toEqual({ available: true })
    expect(improveAvailability({ ...base, hasKey: false })).toEqual({
      available: false,
      reason: 'noKey',
    })
    expect(improveAvailability({ ...base, hasKey: undefined })).toEqual({ available: true })
    expect(improveAvailability({ ...base, ownText: '  \n ' })).toEqual({
      available: false,
      reason: 'empty',
    })
    expect(improveAvailability({ ...base, locked: true, protection: 'encrypt' })).toEqual({
      available: false,
      reason: 'locked',
    })
  })

  it('waits while encryption for the recipients is still being decided', () => {
    const base = { protection: 'none' as const, hasKey: true, ownText: 'Hello', locked: false }
    expect(improveAvailability({ ...base, encryptionUndecided: true })).toEqual({
      available: false,
      reason: 'encryptionPending',
    })
    expect(
      improveAvailability({ ...base, protection: 'encrypt', encryptionUndecided: true }),
    ).toEqual({ available: false, reason: 'encrypted' })
  })

  it('treats encryption as undecided while the lookup runs or recommends it unchosen', () => {
    const settled = {
      hasRecipients: true,
      lookup: 'done' as const,
      recommend: false,
      chosen: false,
      protection: 'none' as const,
    }
    expect(encryptionUndecided(settled)).toBe(false)
    // The lookup for these recipients hasn't answered yet.
    expect(encryptionUndecided({ ...settled, lookup: 'pending' })).toBe(true)
    // No recipients, or no lookup possible (an address is still invalid), or the lookup failed.
    expect(encryptionUndecided({ ...settled, hasRecipients: false, lookup: 'pending' })).toBe(false)
    expect(encryptionUndecided({ ...settled, lookup: 'off' })).toBe(false)
    expect(encryptionUndecided({ ...settled, lookup: 'failed' })).toBe(false)
    // Encryption is recommended and is about to be switched on.
    expect(encryptionUndecided({ ...settled, recommend: true })).toBe(true)
    // Khyati already chose, or it's already on.
    expect(encryptionUndecided({ ...settled, recommend: true, chosen: true })).toBe(false)
    expect(encryptionUndecided({ ...settled, recommend: true, protection: 'encrypt' })).toBe(false)
  })

  it('maps keys in each phase', () => {
    expect(previewKeyAction('preview', 'Enter')).toBe('accept')
    expect(previewKeyAction('preview', 'Escape')).toBe('keep')
    expect(previewKeyAction('waiting', 'Escape')).toBe('cancel')
    expect(previewKeyAction('waiting', 'Enter')).toBeUndefined()
    expect(previewKeyAction('error', 'Enter')).toBe('retry')
    expect(previewKeyAction('error', 'Escape')).toBe('keep')
    expect(previewKeyAction('closed', 'Enter')).toBeUndefined()
    expect(previewKeyAction('closed', 'Escape')).toBeUndefined()
    expect(previewKeyAction('preview', 'a')).toBeUndefined()
  })
})

const p = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const signature: JSONContent = { type: 'signature', attrs: { html: '<b>Khyati</b>' } }

/**
 * Without a DOM TipTap never mounts a view, so no plugin runs. Register the history plugin
 * by hand so that undo behaves as it does in the composer.
 */
function makeEditor(...content: JSONContent[]): Editor {
  const editor = new Editor({
    element: null,
    extensions: [StarterKit, SignatureNode, SignatureParagraph],
    content: { type: 'doc', content },
  })
  const history = editor.extensionManager.plugins.find((plugin) => plugin.key.startsWith('history'))
  if (!history) throw new Error('history plugin missing')
  editor.registerPlugin(history)
  return editor
}

describe('accepting an improvement', () => {
  it('accepts in one step that undo reverts', () => {
    const quoted: JSONContent[] = [
      p('On 5 Nov 2026, Lee <lee@example.com> wrote:'),
      { type: 'blockquote', content: [p('Original')] },
      signature,
    ]
    const editor = makeEditor(p('Hi Sam,'), p('the report are ready.'), p('Thanks,'), ...quoted)
    const before = editor.getJSON()
    expect(acceptImprovement(editor, 'Hi Sam,\n\nThe report is ready.\n\nThanks,')).toBe(true)
    const after = editor.getJSON()
    const own = after.content?.slice(0, 3).map((node) => node.content?.[0]?.text)
    expect(own).toEqual(['Hi Sam,', 'The report is ready.', 'Thanks,'])
    expect(after.content?.slice(3)).toEqual(before.content?.slice(3))
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON()).toEqual(before)
    editor.destroy()
  })

  it('refuses to accept when the draft has no own text', () => {
    const editor = makeEditor(signature)
    const before = editor.getJSON()
    expect(acceptImprovement(editor, 'Hello')).toBe(false)
    expect(editor.getJSON()).toEqual(before)
    editor.destroy()
  })
})
