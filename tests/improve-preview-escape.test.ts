// @vitest-environment happy-dom
import { createElement as h, act } from '../apps/desktop/node_modules/react'
import { createRoot } from '../apps/desktop/node_modules/react-dom/client'
import { Dialog } from '../apps/desktop/node_modules/@base-ui/react/dialog'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImprovePreview } from '../apps/desktop/src/renderer/src/improve/ImprovePreview'
import type { Improve } from '../apps/desktop/src/renderer/src/improve/useImprove'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let unmount = () => {}
afterEach(() => unmount())

/**
 * The preview inside a real Base UI dialog, as in the composer, with a button, a subject field
 * and the hidden editor outside it.
 */
async function render(session: Improve['session']) {
  const onOpenChange = vi.fn()
  const improve = {
    session,
    start: vi.fn(),
    accept: vi.fn(),
    keep: vi.fn(),
    retry: vi.fn(),
  } as unknown as Improve
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const tree = (current: Improve['session']) =>
    h(
      Dialog.Root,
      { open: true, onOpenChange },
      h(
        Dialog.Portal,
        null,
        h(
          Dialog.Popup,
          null,
          h('button', { id: 'outside' }, 'Outside'),
          h('input', { id: 'compose-subject', 'aria-label': 'Subject' }),
          h('div', { className: 'compose-editor', contentEditable: true, tabIndex: 0 }),
          h(ImprovePreview, { improve: { ...improve, session: current } }),
        ),
      ),
    )
  await act(async () => root.render(tree(session)))
  unmount = () => {
    act(() => root.unmount())
    container.remove()
  }
  const rerender = (next: Improve['session']) => act(async () => root.render(tree(next)))
  return { improve, onOpenChange, rerender }
}

const press = (element: Element, key: string) =>
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })

describe('Improve preview keys inside the composer dialog', () => {
  const preview: Improve['session'] = {
    phase: 'preview',
    id: 'request-1',
    style: 'polish',
    original: 'hi there',
    text: 'Hi there.',
    diff: [{ kind: 'added', text: 'Hi there.' }],
    facts: [],
  }

  it('closes only the preview on Escape, never the dialog', async () => {
    const { improve, onOpenChange } = await render(preview)
    const region = document.querySelector('[role="region"]')!
    expect(document.activeElement).toBe(region)
    await press(region, 'Escape')
    expect(improve.keep).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('still lets Escape elsewhere in the dialog close it', async () => {
    const { improve, onOpenChange } = await render(preview)
    await press(document.getElementById('outside')!, 'Escape')
    expect(improve.keep).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ reason: 'escape-key' }),
    )
  })

  it('cancels a waiting request on Escape and accepts on Enter', async () => {
    const waiting = await render({
      ...preview,
      phase: 'waiting',
      partial: '',
    } as Improve['session'])
    await press(document.querySelector('[role="region"]')!, 'Escape')
    expect(waiting.improve.keep).toHaveBeenCalledTimes(1)
    expect(waiting.onOpenChange).not.toHaveBeenCalled()
    unmount()
    const shown = await render(preview)
    await press(document.querySelector('[role="region"]')!, 'Enter')
    expect(shown.improve.accept).toHaveBeenCalledTimes(1)
  })

  it('accepts on Enter even after Tab moved focus to a style, never starting another improve', async () => {
    const { improve } = await render(preview)
    const shorter = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Shorter'),
    )!
    shorter.focus()
    await press(shorter, 'Enter')
    expect(improve.accept).toHaveBeenCalledTimes(1)
    expect(improve.start).not.toHaveBeenCalled()
  })

  it('keeps the original on Enter when “Keep original” has focus', async () => {
    const { improve } = await render(preview)
    const keep = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Keep original'),
    )!
    keep.focus()
    await press(keep, 'Enter')
    expect(improve.keep).toHaveBeenCalledTimes(1)
    expect(improve.accept).not.toHaveBeenCalled()
  })
})

describe('Improve preview focus', () => {
  const waiting = {
    phase: 'waiting',
    id: 'request-1',
    style: 'polish',
    original: 'hi there',
    partial: '',
  } as Improve['session']
  const preview: Improve['session'] = {
    phase: 'preview',
    id: 'request-1',
    style: 'polish',
    original: 'hi there',
    text: 'Hi there.',
    diff: [{ kind: 'added', text: 'Hi there.' }],
    facts: [],
  }
  const region = () => document.querySelector<HTMLElement>('[role="region"]')!

  it('leaves focus in a field Khyati moved to while waiting, so Enter never accepts unseen', async () => {
    const { improve, rerender } = await render(waiting)
    const subject = document.getElementById('compose-subject')!
    act(() => subject.focus())
    await rerender(preview)
    expect(document.activeElement).toBe(subject)
    await press(subject, 'Enter')
    expect(improve.accept).not.toHaveBeenCalled()
  })

  it('takes focus when the result arrives and focus was on nothing or the hidden editor', async () => {
    const { rerender } = await render(waiting)
    act(() => document.querySelector<HTMLElement>('.compose-editor')!.focus())
    await rerender(preview)
    expect(document.activeElement).toBe(region())

    act(() => region().blur())
    await rerender({ ...waiting, id: 'request-2' } as Improve['session'])
    expect(document.activeElement).toBe(region())
  })

  it('takes focus when it opens from a button or the command menu, not from a field', async () => {
    unmount = () => {}
    const palette = document.createElement('div')
    palette.setAttribute('role', 'dialog')
    const search = document.createElement('input')
    palette.append(search)
    document.body.append(palette)
    search.focus()
    await render(waiting)
    expect(document.activeElement).toBe(region())
    palette.remove()
    unmount()

    const { rerender } = await render({ phase: 'closed' })
    const subject = document.getElementById('compose-subject')!
    act(() => subject.focus())
    await rerender(waiting)
    expect(document.activeElement).toBe(subject)
  })
})
