// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { defaultReminderSettings } from '@inlark/core'
import {
  draftOwnText,
  followUpGuess,
  followUpLabel,
  followUpShown,
} from '../apps/desktop/src/renderer/src/reminders/draft-text'
import { defaultBindings, shortcutDefinitions } from '../apps/desktop/src/renderer/src/shortcuts'

const quote = '<p>On Fri, Dana wrote:</p><blockquote><p>Can you send the file?</p></blockquote>'
const htmlSignature = '<div data-inlark-signature><p>Sam Example?</p></div>'
const textSignature = '<p data-inlark-signature-text="">Sam Example, Ask me anything?</p>'

describe('draftOwnText', () => {
  it('drops a reply quote with its attribution, and both signature kinds', () => {
    const html = '<p>Here it is.</p><p>Thanks,</p>' + htmlSignature + textSignature + quote
    const own = draftOwnText(html, 'ignored')
    expect(own).toContain('Here it is.')
    expect(own).not.toMatch(/Dana|file|Sam|\?/)
  })
  it('keeps my own paragraph right above a quote when it is not an attribution', () => {
    const own = draftOwnText('<p>Can you check the part below?</p><blockquote>Old</blockquote>', '')
    expect(own).toBe('Can you check the part below?')
  })
  it('drops a French attribution before a quote', () => {
    const html = '<p>Voici.</p><p>Le ven., Dana a écrit :</p><blockquote>Pourquoi ?</blockquote>'
    expect(draftOwnText(html, '')).toBe('Voici.')
  })
  it('drops a gmail_quote block', () => {
    const own = draftOwnText('<p>Done.</p><div class="gmail_quote">Why?</div>', '')
    expect(own).toBe('Done.')
  })
  it('falls back to the plain text without html', () => {
    expect(draftOwnText('', 'Could you review?')).toBe('Could you review?')
  })
})

describe('followUpGuess', () => {
  it('is true for a question and false for a plain hand-over under a quoted question', () => {
    expect(followUpGuess({ html: '<p>Could you review?</p>' + quote, text: '' })).toBe(true)
    expect(followUpGuess({ html: '<p>Here it is.</p><p>Thanks,</p>' + quote, text: '' })).toBe(
      false,
    )
  })
})

describe('follow-up switch', () => {
  it('words the three states', () => {
    expect(followUpLabel(true, true)).toBe('Follow-up: on (asks a question)')
    expect(followUpLabel(true, false)).toBe('Follow-up: on')
    expect(followUpLabel(false, true)).toBe('Follow-up: off')
  })
  it('is shown only for an IMAP account with the feature on and a recipient', () => {
    const base = { protocol: 'imap' as const, settings: defaultReminderSettings, recipients: 1 }
    expect(followUpShown(base)).toBe(true)
    expect(followUpShown({ ...base, protocol: 'jmap' })).toBe(false)
    expect(followUpShown({ ...base, settings: { ...base.settings, enabled: false } })).toBe(false)
    expect(followUpShown({ ...base, settings: { ...base.settings, followUp: false } })).toBe(false)
    expect(followUpShown({ ...base, recipients: 0 })).toBe(false)
  })
  it('has the Mod+Shift+O shortcut', () => {
    expect(shortcutDefinitions.find((s) => s.id === 'toggleFollowUp')?.label).toBe(
      'Follow-up on or off',
    )
    expect(defaultBindings('toggleFollowUp')).toEqual([['Mod+Shift+O']])
  })
})
