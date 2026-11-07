// @vitest-environment happy-dom
import { createElement, act, type ReactNode } from '../apps/desktop/node_modules/react'
import { renderToStaticMarkup } from '../apps/desktop/node_modules/react-dom/server'
import { createRoot } from '../apps/desktop/node_modules/react-dom/client'
import {
  QueryClient,
  QueryClientProvider,
} from '../apps/desktop/node_modules/@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultReminderSettings, type Conversation } from '../packages/core/src'

vi.stubGlobal('location', { search: '', protocol: 'file:' })
// React's act() environment, so updates flush inside act.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const conversation: Conversation = {
  id: 't1',
  accountId: 'a1',
  key: 'a1:t1',
  subject: 'Question',
  from: [{ name: 'Pat', email: 'pat@example.com' }],
  preview: 'Can you send the file?',
  receivedAt: '2026-11-02T15:00:00.000Z',
  unread: false,
  starred: false,
  hasAttachment: false,
  count: 1,
  messages: [],
  reminder: { kind: 'reply', dueAt: '2026-11-03T15:00:00.000Z', messageId: 'm1@example.com' },
}

describe('conversation row reminder label', () => {
  it('takes reminder settings from the list, with no query of its own', async () => {
    const { ConversationRow } = await import('../apps/desktop/src/renderer/src/ConversationRow')
    const noop = () => {}
    const client = new QueryClient()
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ConversationRow, {
          conversation,
          selected: false,
          focused: false,
          busy: false,
          remoteImages: false,
          reminderSettings: defaultReminderSettings,
          onOpen: noop,
          onFocus: noop,
          onSelect: noop,
          onStar: noop,
          onToggleRead: noop,
        }),
      ),
    )
    // A row that read the settings itself would run a bootstrap query per row.
    expect(client.getQueryCache().find({ queryKey: ['bootstrap'] })).toBeUndefined()
    expect(markup).toContain('Waiting on you')
  })
})

describe('follow-up guess', () => {
  let root: ReturnType<typeof createRoot> | undefined
  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
  })

  it('follows a plain-text draft as it changes', async () => {
    const { useFollowUpGuess } =
      await import('../apps/desktop/src/renderer/src/reminders/draft-text')
    const seen: boolean[] = []
    function Probe({ html, text }: { html: string; text: string }): ReactNode {
      seen.push(useFollowUpGuess({ html, text }))
      return null
    }
    root = createRoot(document.createElement('div'))
    act(() => root!.render(createElement(Probe, { html: '', text: 'Here it is.' })))
    expect(seen.at(-1)).toBe(false)
    act(() => root!.render(createElement(Probe, { html: '', text: 'Can you review it?' })))
    expect(seen.at(-1)).toBe(true)
  })
})
