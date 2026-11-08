import { useEffect, useId, useState } from 'react'
import { Button, cn, Modal } from '@inlark/ui'
import {
  dateInputToUntil,
  moveActive,
  snoozeOptions,
  tomorrowInput,
  type SnoozeOption,
} from './snooze-model'

// Focus on mount, as an input's autoFocus does: the dialog leaves focus alone once it is inside.
const focusOnMount = (el: HTMLElement | null) => el?.focus({ preventScroll: true })

/** Choose when something comes back: three presets or a date (9:00 that morning). */
export function SnoozePicker({
  open,
  onClose,
  onPick,
  now,
}: {
  open: boolean
  onClose: () => void
  onPick: (until: number) => void
  now?: number
}) {
  const listId = useId()
  const [clock, setClock] = useState(() => now ?? Date.now())
  const [active, setActive] = useState(0)
  const [picking, setPicking] = useState(false)
  const [date, setDate] = useState('')
  useEffect(() => {
    if (!open) return
    setClock(now ?? Date.now())
    setActive(0)
    setPicking(false)
    setDate('')
  }, [open, now])
  const options: (SnoozeOption | { id: 'date'; label: string; detail?: string })[] = [
    ...snoozeOptions(clock),
    { id: 'date', label: 'Pick a date…' },
  ]
  const until = dateInputToUntil(date, clock)
  const choose = (index: number) => {
    const option = options[index]
    if ('until' in option) onPick(option.until)
    else setPicking(true)
  }
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title="Snooze until"
      className="snooze-modal w-[min(360px,_calc(100vw_-_40px))]"
    >
      {picking ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (until !== undefined) onPick(until)
          }}
        >
          <input
            autoFocus
            type="date"
            aria-label="Date"
            min={tomorrowInput(clock)}
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="h-9 flex-1 px-2.5 text-[12px] bg-field border border-solid border-border-strong rounded-[7px]"
          />
          <Button type="submit" disabled={until === undefined}>
            Snooze
          </Button>
        </form>
      ) : (
        <div
          role="listbox"
          id={listId}
          aria-label="Snooze until"
          aria-activedescendant={listId + '-' + active}
          tabIndex={0}
          ref={focusOnMount}
          className="outline-none -mx-1.5 px-1.5"
          onKeyDown={(event) => {
            const next = moveActive(active, options.length, event.key, event.ctrlKey)
            if (next !== active || event.key.startsWith('Arrow')) {
              event.preventDefault()
              setActive(next)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              choose(active)
            }
          }}
        >
          {options.map((option, i) => (
            <div
              key={option.id}
              id={listId + '-' + i}
              role="option"
              aria-selected={i === active}
              className={cn(
                'flex items-center justify-between gap-3 py-2.5 px-3 rounded-md text-[12px] cursor-pointer',
                'text-secondary',
                i === active && 'bg-hover text-strong',
              )}
              onMouseMove={() => i !== active && setActive(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(i)}
            >
              <span>{option.label}</span>
              {option.detail && <span className="text-muted">{option.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
