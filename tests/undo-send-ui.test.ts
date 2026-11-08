// @vitest-environment happy-dom
import { createElement as h, act } from '../apps/desktop/node_modules/react'
import { createRoot } from '../apps/desktop/node_modules/react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeldSend } from '../packages/core/src'
import { UndoSendBar } from '../apps/desktop/src/renderer/src/undo-send/UndoSendBar'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const now = Date.parse('2026-11-07T10:00:00.000Z')
const held = (draftId: string, inMs: number, more: Partial<HeldSend> = {}): HeldSend => ({
  draftId,
  accountId: 'work',
  subject: 'Plans',
  dueAt: new Date(now + inMs).toISOString(),
  state: 'waiting',
  ...more,
})
let container: HTMLDivElement
let unmount = () => {}
async function render(sends: HeldSend[], onUndo = vi.fn()) {
  container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(h(UndoSendBar, { sends, accounts: [{ id: 'work', name: 'Work' }], onUndo })),
  )
  unmount = () => {
    act(() => root.unmount())
    container.remove()
  }
  return onUndo
}
beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ['Date', 'setInterval', 'clearInterval'] })
})
afterEach(() => {
  unmount()
  vi.useRealTimers()
})

describe('Undo send bar', () => {
  it('counts down and undoes from its button', async () => {
    const onUndo = await render([held('a', 10_000)])
    expect(container.textContent).toContain('Sending in 10s')
    await act(async () => vi.advanceTimersByTime(3_000))
    expect(container.textContent).toContain('Sending in 7s')
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Undo'),
    )!
    await act(async () => button.click())
    expect(onUndo).toHaveBeenCalledWith('a')
  })
  it('offers no Undo once the email is sending', async () => {
    await render([held('a', -100, { state: 'sending' })])
    expect(container.textContent).toContain('Sending…')
    expect(container.querySelector('button')).toBeNull()
  })
  it('shows nothing when no email is pending', async () => {
    await render([])
    expect(container.innerHTML).toBe('')
  })
})
