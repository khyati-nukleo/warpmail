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

/** The preview inside a real Base UI dialog, as in the composer, with a button outside it. */
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
  await act(async () =>
    root.render(
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
            h(ImprovePreview, { improve }),
          ),
        ),
      ),
    ),
  )
  unmount = () => {
    act(() => root.unmount())
    container.remove()
  }
  return { improve, onOpenChange }
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
})
