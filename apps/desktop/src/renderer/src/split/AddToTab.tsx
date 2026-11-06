import { Checkbox, cn, Modal } from '@inlark/ui'
import { Check, Inbox, Plus, Search } from '@inlark/ui/icons'
import type { Address, SplitTab } from '@inlark/core'
import { useEffect, useId, useRef, useState } from 'react'
import { pickerOptions, pickProblem, senderRules, type PickerOption } from './tab-model'

/** The sender being added; kept after closing so the picker's words stay while it fades out. */
export interface AddToTabState {
  sender: Address
  open: boolean
  seq: number
  /** Chosen in Ctrl+K, so focus goes to the active tab on closing. */
  fromCommand?: boolean
}

const optionLabel = (option: PickerOption) =>
  option.kind === 'new'
    ? 'New tab…'
    : option.kind === 'create'
      ? 'New tab “' + option.name + '”'
      : option.tab.name

/** Picks a tab for an email's sender (or their domain), or starts a new one. */
export function AddToTab({
  state,
  tabs,
  own,
  onClose,
  onPick,
  onNewTab,
}: {
  state?: AddToTabState
  /** Every user tab. */
  tabs: SplitTab[]
  own: string[]
  onClose: () => void
  /** Adds the rule to a tab, or to a new tab named as typed; the picker stays open on failure. */
  onPick: (target: { id?: string; name?: string }, rule: string) => Promise<void>
  /** Opens the tab editor with the rule in it. */
  onNewTab: (rule: string) => void
}) {
  const sender = state?.sender
  const rules = senderRules(sender?.email ?? '', own)
  const [text, setText] = useState('')
  const [active, setActive] = useState<number>()
  const [wholeDomain, setWholeDomain] = useState(false)
  const [busy, setBusy] = useState(false)
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  const rule = (wholeDomain && rules.domain) || rules.address || ''
  const { options, highlight } = pickerOptions(tabs, text)
  const highlighted = Math.max(0, Math.min(active ?? highlight, options.length - 1))
  const problem = options[highlighted] && pickProblem(options[highlighted], tabs, rule, own)
  const has = (tab: SplitTab) => tab.rules.some((r) => r.toLowerCase() === rule.toLowerCase())

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, text])

  const choose = async (option: PickerOption) => {
    if (busy || !rule || pickProblem(option, tabs, rule, own)) return
    if (option.kind === 'new') return onNewTab(rule)
    setBusy(true)
    try {
      await onPick(option.kind === 'tab' ? { id: option.tab.id } : { name: option.name }, rule)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={!!state?.open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={sender ? 'Add ' + (sender.name.trim() || sender.email) + ' to a tab' : ''}
      description={sender?.name.trim() ? sender.email : undefined}
      className="add-to-tab-modal w-[min(440px,_calc(100vw_-_40px))]"
    >
      {rules.refusal ? (
        <p className="tab-refusal modal-body-text m-0 text-[12px] leading-[1.6] text-secondary">
          {rules.refusal}
        </p>
      ) : (
        <>
          <div
            className={cn(
              'tab-search flex items-center gap-2 h-9 mb-2 py-0 px-2.75 text-muted bg-field border border-solid',
              'border-border-strong rounded-[7px] transition-[border-color,box-shadow] duration-120 ease-[ease]',
              'focus-within:border-primary-solid focus-within:shadow-[0_0_0_3px_var(--accent-tint)] [&_input]:h-full',
              '[&_input]:p-0 [&_input]:text-[12px] [&_input]:bg-none [&_input]:bg-transparent [&_input]:border-0',
              '[&_input:focus-visible]:outline-none',
            )}
          >
            <Search size={14} />
            <input
              autoFocus
              value={text}
              placeholder="Find or name a tab"
              aria-label="Find or name a tab"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={options.length ? listId + '-' + highlighted : undefined}
              aria-describedby={problem ? listId + '-problem' : undefined}
              onChange={(event) => {
                setText(event.target.value)
                setActive(undefined)
              }}
              onKeyDown={(event) => {
                const step =
                  event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')
                    ? 1
                    : event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')
                      ? -1
                      : 0
                if (step && options.length) {
                  event.preventDefault()
                  setActive((highlighted + step + options.length) % options.length)
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (options[highlighted]) void choose(options[highlighted])
                }
              }}
            />
          </div>
          <div
            className={cn(
              'tab-picker [&_button]:w-full [&_button]:flex [&_button]:items-center [&_button]:gap-3 [&_button]:bg-none',
              '[&_button]:bg-transparent [&_button]:border-0 [&_button]:py-2.5 [&_button]:px-3 [&_button]:rounded-md',
              '[&_button]:text-[12px] [&_button]:text-left [&_button]:text-secondary [&_button>span]:flex-1',
              '[&_button>span]:min-w-0 [&_button>span]:overflow-hidden [&_button>span]:text-ellipsis',
              '[&_button>span]:whitespace-nowrap [&_button_svg]:text-muted [&_button.active]:bg-hover',
              '[&_button.active]:text-strong [&_button.active_svg]:text-strong [&_button[aria-disabled=true]]:text-muted',
              'max-h-[min(300px,_calc(100vh_-_320px))] overflow-y-auto my-0 -mx-1.5 py-0 px-1.5',
            )}
            role="listbox"
            id={listId}
            aria-label="Tabs"
            ref={list}
          >
            {options.map((option, i) => {
              const blocked = !!pickProblem(option, tabs, rule, own)
              const already = option.kind === 'tab' && has(option.tab)
              return (
                <button
                  key={option.kind === 'tab' ? option.tab.id : option.kind}
                  id={listId + '-' + i}
                  role="option"
                  aria-selected={i === highlighted}
                  aria-disabled={blocked || undefined}
                  aria-label={already ? optionLabel(option) + ', already added' : undefined}
                  tabIndex={-1}
                  className={cn(i === highlighted && 'active')}
                  onMouseMove={() => i !== highlighted && setActive(i)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void choose(option)}
                >
                  {option.kind === 'tab' ? <Inbox size={15} /> : <Plus size={15} />}
                  <span>{optionLabel(option)}</span>
                  {already && <Check size={13} aria-hidden />}
                </button>
              )
            })}
          </div>
          {problem && (
            <p
              id={listId + '-problem'}
              className="tab-limit-error text-[12px] text-danger mt-2 mb-0 leading-[1.6]"
            >
              {problem}
            </p>
          )}
          {rules.domain && (
            <label className="checkbox-label flex items-center gap-2.25 text-[12px] mt-4">
              <Checkbox checked={wholeDomain} onCheckedChange={setWholeDomain} />
              Add everyone at {rules.domain} instead
            </label>
          )}
        </>
      )}
    </Modal>
  )
}
