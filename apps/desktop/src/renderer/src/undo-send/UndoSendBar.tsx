import { useEffect, useState } from 'react'
import { cn, Spinner } from '@inlark/ui'
import { Send } from '@inlark/ui/icons'
import type { HeldSend } from '@inlark/core'
import { ShortcutHint } from '../shortcuts'
import { heldRows } from './held-text'

/**
 * Undo send: "Sending in 10s · Undo" for each email still counting down, where the toast sits.
 * The countdown itself runs in the main process; this only shows it.
 */
export function UndoSendBar({
  sends,
  accounts,
  onUndo,
}: {
  sends: HeldSend[]
  accounts: { id: string; name: string }[]
  onUndo: (draftId: string) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const counting = sends.some((s) => s.state === 'waiting')
  useEffect(() => {
    if (!counting) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [counting])
  if (!sends.length) return null
  const { rows, more } = heldRows(sends, now, accounts)
  const newest = [...rows].reverse().find((r) => r.undo)?.draftId
  return (
    <div
      className={cn(
        'undo-send-bar fixed bottom-5.75 left-[calc(50%+var(--rail)_/_2_-_4px)] transform-[translateX(-50%)] z-150',
        'flex flex-col gap-1 max-w-[75vw] bg-raised border border-solid border-border-strong shadow-popup py-2 px-3.75',
        'rounded-lg text-[12px] max-[700px]:max-w-[calc(100vw_-_var(--rail)_-_32px)]',
        'animate-[toast-in_180ms_cubic-bezier(0.2,_0.9,_0.3,_1.2)]',
      )}
      role="status"
    >
      {more > 0 && <span className="text-muted text-[11px] pl-6.5">+{more} more sending</span>}
      {rows.map((row) => (
        <div key={row.draftId} className="flex items-center gap-3.25 min-h-6.5">
          {row.undo ? <Send size={15} className="text-primary shrink-0" /> : <Spinner size={15} />}
          <span className="max-w-150 truncate tabular-nums">{row.text}</span>
          {row.undo && (
            <button
              className={cn(
                'inline-flex items-center gap-1.5 py-[3px] pr-1 pl-2 rounded-sm font-medium border-0 bg-transparent',
                'text-primary text-[11px] hover:bg-primary-tint ml-auto',
                '[&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:text-[9px] [&_kbd]:text-primary [&_kbd]:border-primary/35',
              )}
              onClick={() => onUndo(row.draftId)}
            >
              Undo
              {row.draftId === newest && <ShortcutHint id="undo" />}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
