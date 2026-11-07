// @vitest-environment happy-dom
import { createElement } from '../apps/desktop/node_modules/react'
import { renderToStaticMarkup } from '../apps/desktop/node_modules/react-dom/server'
import {
  QueryClient,
  QueryClientProvider,
} from '../apps/desktop/node_modules/@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { askCheck, defaultReminderSettings, type Draft, type Settings } from '@inlark/core'
import {
  draftOwnText,
  followUpGuess,
  followUpLabel,
  followUpShown,
  withFollowUp,
} from '../apps/desktop/src/renderer/src/reminders/draft-text'
import { FollowUpSwitch } from '../apps/desktop/src/renderer/src/reminders/FollowUpSwitch'
import { defaultBindings, shortcutDefinitions } from '../apps/desktop/src/renderer/src/shortcuts'

// Counts ask-checks, so a hidden switch can be shown to run none.
vi.mock('@inlark/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inlark/core')>()
  return { ...actual, askCheck: vi.fn(actual.askCheck) }
})
vi.stubGlobal('location', { search: '', protocol: 'file:' })
beforeEach(() => {
  vi.mocked(askCheck).mockClear()
})

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

describe('follow-up switch hidden', () => {
  const draft = {
    id: 'd1',
    accountId: 'a1',
    identityId: 'default',
    to: [{ name: 'Pat', email: 'pat@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Plans',
    html: '<p>Can you confirm?</p>',
    text: 'Can you confirm?',
    attachments: [],
    updatedAt: '2026-11-02T15:00:00.000Z',
    status: 'local',
  } as Draft
  const hidden: [string, Partial<Settings>, 'imap' | 'jmap', Draft][] = [
    ['reminders off', { reminders: { enabled: false } }, 'imap', draft],
    ['follow-ups off', { reminders: { followUp: false } }, 'imap', draft],
    ['not IMAP', {}, 'jmap', draft],
    ['no recipients', {}, 'imap', { ...draft, to: [] }],
  ]
  const render = (settings: Partial<Settings>, protocol: 'imap' | 'jmap', d: Draft) => {
    const client = new QueryClient()
    client.setQueryData(['bootstrap'], { settings })
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FollowUpSwitch, { draft: d, account: { protocol }, onChange: () => {} }),
      ),
    )
  }
  it('runs no ask-check while hidden', () => {
    for (const [, settings, protocol, d] of hidden) {
      expect(render(settings, protocol, d)).toBe('')
      expect(askCheck).not.toHaveBeenCalled()
    }
    expect(render({}, 'imap', draft)).toContain('Follow-up: on (asks a question)')
    expect(askCheck).toHaveBeenCalled()
  })
  it('sends with nothing set on the draft while hidden, and the guess while shown', () => {
    for (const [, settings, protocol, d] of hidden) {
      expect(withFollowUp(d, protocol, settings)).toBe(d)
      expect(askCheck).not.toHaveBeenCalled()
    }
    expect(withFollowUp(draft, 'imap', {}).followUp).toBe(true)
    // Her own choice wins over the guess, which then never runs.
    vi.mocked(askCheck).mockClear()
    expect(withFollowUp({ ...draft, followUp: false }, 'imap', {}).followUp).toBe(false)
    expect(askCheck).not.toHaveBeenCalled()
  })
})
