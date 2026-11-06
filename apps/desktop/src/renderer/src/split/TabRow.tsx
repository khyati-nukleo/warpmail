import { cn, EmptyState, IconButton } from '@inlark/ui'
import { Inbox, Plus, UserRound } from '@inlark/ui/icons'
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import {
  dropIndex,
  rovingTarget,
  tabElementId,
  tabEmptyCopy,
  tabPanelId,
  type TabEntry,
} from './tab-model'

const dragType = 'application/x-warpmail-tab'

/**
 * The inbox tabs above the list. One tab stop for the row; the arrow keys, Home and End move
 * between tabs and Enter or Space opens one. User tabs can be dragged to reorder.
 */
export function TabRow({
  entries,
  active,
  counts,
  onSelect,
  onReorder,
  onMenu,
  onAdd,
}: {
  entries: TabEntry[]
  active: string
  /** Unread conversations by tab id; zero and missing counts are hidden. */
  counts: Record<string, number>
  onSelect: (id: string) => void
  /** Moves a user tab to `toIndex` among the user tabs. */
  onReorder: (id: string, toIndex: number) => void
  onMenu: (id: string, anchor: HTMLElement) => void
  onAdd: () => void
}) {
  const [focusId, setFocusId] = useState<string>()
  const [dragging, setDragging] = useState<{ id: string; from: number }>()
  const [drop, setDrop] = useState<{ over: number; after: boolean; to: number }>()
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  // The menu key also fires `contextmenu`, on keyup on Windows; open the menu once.
  const keyMenuAt = useRef(0)
  const tabStop = entries.some((entry) => entry.id === focusId) ? focusId : active
  const userIndex = (id: string) =>
    entries.filter((entry) => entry.user).findIndex((e) => e.id === id)

  useEffect(() => {
    buttons.current.get(active)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, id: string) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      keyMenuAt.current = Date.now()
      onMenu(id, event.currentTarget)
    } else if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    else if (event.key === 'Enter' || event.key === ' ') onSelect(id)
    else {
      const target = rovingTarget(index, entries.length, event.key)
      if (target === undefined) return
      const next = entries[target].id
      setFocusId(next)
      buttons.current.get(next)?.focus()
    }
    // Keep the list's own keys, such as Enter to open a conversation, out of the tab row.
    event.preventDefault()
    event.stopPropagation()
  }

  const dragOver = (event: DragEvent<HTMLButtonElement>, over: number) => {
    if (!dragging || !event.dataTransfer.types.includes(dragType)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const box = event.currentTarget.getBoundingClientRect()
    const after = event.clientX > box.left + box.width / 2
    const to = dropIndex(dragging.from, over, after)
    if (to === undefined) {
      if (drop) setDrop(undefined)
    } else if (drop?.over !== over || drop.after !== after) setDrop({ over, after, to })
  }
  const endDrag = () => {
    setDragging(undefined)
    setDrop(undefined)
  }

  return (
    <div className="tab-row flex items-center gap-1.5 pb-3 px-7 shrink-0 @max-[900px]/mail:px-5.5 @max-[680px]/mail:px-5">
      <div
        role="tablist"
        aria-label="Inbox tabs"
        className={cn(
          'tab-list flex items-center gap-[2px] min-w-0 overflow-x-auto p-1 -m-1',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        )}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setFocusId(undefined)
        }}
      >
        {entries.map((entry, index) => {
          const chosen = entry.id === active
          const count = counts[entry.id] || 0
          const over = entry.user ? userIndex(entry.id) : -1
          return (
            <button
              key={entry.id}
              ref={(element) => {
                if (element) buttons.current.set(entry.id, element)
                else buttons.current.delete(entry.id)
              }}
              type="button"
              role="tab"
              id={tabElementId(entry.id)}
              aria-selected={chosen}
              aria-controls={tabPanelId}
              tabIndex={entry.id === tabStop ? 0 : -1}
              className={cn(
                'tab relative inline-flex items-center gap-1.5 h-7.5 py-0 px-2.75 shrink-0 rounded-sm',
                'border-0 bg-transparent text-[12px] text-muted whitespace-nowrap cursor-pointer',
                'transition-[background,color,opacity] duration-120 ease-[ease] hover:text-foreground',
                'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary',
                'focus-visible:outline-offset-2',
                chosen &&
                  'chosen bg-selected text-strong hover:text-strong font-medium shadow-[0_1px_2px_#0000001a]',
                dragging?.id === entry.id && 'opacity-50',
              )}
              onClick={() => onSelect(entry.id)}
              onKeyDown={(event) => onKeyDown(event, index, entry.id)}
              onContextMenu={(event) => {
                event.preventDefault()
                if (Date.now() - keyMenuAt.current > 1000) onMenu(entry.id, event.currentTarget)
              }}
              draggable={entry.user}
              onDragStart={
                entry.user
                  ? (event) => {
                      event.dataTransfer.setData(dragType, entry.id)
                      event.dataTransfer.effectAllowed = 'move'
                      setDragging({ id: entry.id, from: over })
                    }
                  : undefined
              }
              onDragOver={entry.user ? (event) => dragOver(event, over) : undefined}
              onDragLeave={(event) => {
                if (
                  drop?.over === over &&
                  !event.currentTarget.contains(event.relatedTarget as Node | null)
                )
                  setDrop(undefined)
              }}
              onDrop={
                entry.user
                  ? (event) => {
                      event.preventDefault()
                      if (dragging && drop) onReorder(dragging.id, drop.to)
                      endDrag()
                    }
                  : undefined
              }
              onDragEnd={entry.user ? endDrag : undefined}
            >
              {/* Reserves the medium weight's width so choosing a tab doesn't shift the row. */}
              <span
                data-name={entry.name}
                className="grid after:content-[attr(data-name)] after:font-medium after:invisible after:h-0 after:overflow-hidden"
              >
                {entry.name}
              </span>
              {count > 0 && (
                <span className="tab-count text-[11px] font-normal text-faint tabular-nums">
                  {count.toLocaleString()}
                  <span className="sr-only"> unread</span>
                </span>
              )}
              {drop?.over === over && entry.user && (
                <span
                  aria-hidden
                  className={cn(
                    'drop-indicator absolute top-1 bottom-1 w-[2px] rounded-full bg-primary',
                    drop.after ? '-right-[2px]' : '-left-[2px]',
                  )}
                />
              )}
            </button>
          )
        })}
      </div>
      <IconButton label="New tab" onClick={onAdd}>
        <Plus size={14} />
      </IconButton>
    </div>
  )
}

/** The empty list in Important or a user tab. */
export function TabEmptyState({
  entry,
  untabbed,
  unreadOnly,
}: {
  entry: TabEntry
  /** Accounts in scope that tabs leave out. */
  untabbed: string[]
  unreadOnly: boolean
}) {
  const { title, description, note } = tabEmptyCopy(entry, untabbed, unreadOnly)
  return (
    <EmptyState
      icon={entry.id === 'important' ? UserRound : Inbox}
      title={title}
      description={description}
    >
      {note && (
        <p className="tab-empty-note text-[12px] text-faint max-w-75 m-0 leading-[1.6] text-balance">
          {note}
        </p>
      )}
    </EmptyState>
  )
}
