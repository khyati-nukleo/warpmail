import { cn } from '@inlark/ui'
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { AlertCircle, Sparkles } from '@inlark/ui/icons'
import { Button, Spinner } from '@inlark/ui'
import { improveStyleLabels, improveStyles } from '@inlark/core'
import { previewKeyAction } from './improve-session'
import type { Improve } from './useImprove'

const hint = 'text-[11px] opacity-60 ml-2.5'

const typesText = (element: Element): boolean =>
  element.matches('input, textarea, select') || (element as HTMLElement).isContentEditable

/**
 * Whether the preview may take focus from `active`. Always from nothing or the hidden editor.
 * When it opens, also from the button or menu item that opened it, and from the command menu
 * (another dialog, which closes as the preview opens). Never from a field Khyati is typing in,
 * so a later result can't catch an Enter meant for To or Subject.
 */
export function previewTakesFocus(
  active: Element | null,
  region: Element,
  opening: boolean,
): boolean {
  if (!active || active === active.ownerDocument.body) return true
  if (region.contains(active)) return false
  if (active.closest('.compose-editor')) return true
  if (!opening) return false
  if (!typesText(active)) return true
  const dialog = active.closest('[role="dialog"], [role="alertdialog"]')
  return !!dialog && !dialog.contains(region)
}

/** Shown in place of the message while Improve is waiting, previewing or has failed. */
export function ImprovePreview({ improve }: { improve: Improve }) {
  const { session, start, accept, keep, retry } = improve
  const region = useRef<HTMLDivElement>(null)
  const phase = session.phase
  const id = session.phase === 'closed' ? undefined : session.id
  const opened = useRef(false)
  // Focus comes here when the preview opens, and again whenever the button that had it goes away
  // (for example “Try again”), so Escape keeps reaching this handler and not the composer's.
  useEffect(() => {
    const element = region.current
    if (phase === 'closed' || !element) {
      opened.current = false
      return
    }
    const opening = !opened.current
    opened.current = true
    if (previewTakesFocus(document.activeElement, element, opening))
      element.focus({ preventScroll: true })
  }, [phase, id])
  if (session.phase === 'closed') return null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    // Enter accepts (or retries) wherever focus is in the preview, so a style that Tab reached
    // never starts another improve. On a focused "Keep original" it keeps, as that button says.
    const onKeep =
      event.key === 'Enter' &&
      event.target instanceof Element &&
      event.target.closest('[data-improve-keep]') !== null
    const action = onKeep ? 'keep' : previewKeyAction(session.phase, event.key)
    if (!action) return
    // Stops the composer dialog, which closes on Escape, from ever seeing the key.
    event.preventDefault()
    event.stopPropagation()
    if (action === 'accept') accept()
    else if (action === 'retry') retry()
    else keep()
  }

  return (
    <div
      ref={region}
      role="region"
      aria-label="Improved draft"
      aria-busy={session.phase === 'waiting'}
      tabIndex={-1}
      className="compose-improve-preview flex flex-col min-h-full outline-none"
      onKeyDown={onKeyDown}
    >
      <div className="compose-improve-header flex items-center flex-wrap gap-1 mb-4">
        <span className="flex items-center gap-1.5 mr-2 text-[12px] font-medium text-strong">
          <Sparkles size={14} className="text-primary" />
          Improved
        </span>
        {improveStyles.map((style) => {
          const current = style === session.style
          return (
            <Button
              key={style}
              size="small"
              variant="ghost"
              aria-pressed={current}
              className={cn(
                current &&
                  'bg-primary-tint text-primary [&:hover:not(:disabled)]:bg-primary-tint [&:hover:not(:disabled)]:text-primary',
              )}
              onClick={() => start(style)}
            >
              {improveStyleLabels[style]}
            </Button>
          )
        })}
      </div>

      {session.phase === 'waiting' && (
        <>
          <div className="flex items-center gap-2 text-[12px] text-muted" role="status">
            <Spinner size={13} />
            Improving…
          </div>
          {session.partial && (
            <div className="mt-3 whitespace-pre-wrap text-[15px] leading-[1.8] text-muted">
              {session.partial}
            </div>
          )}
        </>
      )}

      {session.phase === 'preview' && (
        <>
          {session.facts.length > 0 && (
            <div className="compose-improve-facts flex flex-col gap-1 mb-3">
              {session.facts.map((fact, index) => (
                <p key={index} className="flex items-center gap-1.5 m-0 text-[12px] text-danger">
                  <AlertCircle size={13} className="shrink-0" />
                  Check: “{fact.value}” {fact.change === 'missing' ? 'is missing.' : 'was added.'}
                </p>
              ))}
            </div>
          )}
          <div className="compose-improve-diff whitespace-pre-wrap text-[15px] leading-[1.8] text-foreground">
            {session.diff.map((part, index) =>
              part.kind === 'removed' ? (
                <del key={index} className="line-through text-muted">
                  {part.text}
                </del>
              ) : part.kind === 'added' ? (
                <ins
                  key={index}
                  className="no-underline bg-primary-tint text-primary rounded-[3px]"
                >
                  {part.text}
                </ins>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </div>
        </>
      )}

      {session.phase === 'error' && (
        <p className="flex items-start gap-2 m-0 text-[12px] text-danger" role="alert">
          <AlertCircle size={14} className="shrink-0 mt-[1px]" />
          {session.message}
        </p>
      )}

      <div className="compose-improve-footer sticky bottom-0 mt-auto flex items-center gap-2 pt-4 bg-surface">
        {session.phase === 'waiting' && (
          <Button size="small" variant="ghost" className="text-muted" onClick={keep}>
            <kbd>Esc</kbd> to cancel
          </Button>
        )}
        {session.phase === 'preview' && (
          <>
            <Button variant="primary" onClick={accept}>
              Accept<span className={hint}>Enter</span>
            </Button>
            <Button variant="ghost" onClick={keep} data-improve-keep="">
              Keep original<span className={hint}>Esc</span>
            </Button>
          </>
        )}
        {session.phase === 'error' && (
          <>
            <Button variant="primary" onClick={retry}>
              Try again<span className={hint}>Enter</span>
            </Button>
            <Button variant="ghost" onClick={keep} data-improve-keep="">
              Keep original<span className={hint}>Esc</span>
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
