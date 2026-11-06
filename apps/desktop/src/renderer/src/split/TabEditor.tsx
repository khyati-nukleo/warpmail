import { Button, cn, Modal } from '@inlark/ui'
import { parseRule, suggestionTerm, type RuleSuggestion, type SplitTab } from '@inlark/core'
import { useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { api } from '../api'
import { AddToTab } from './AddToTab'
import { AlwaysShowDialog } from './ImportantException'
import {
  completeRuleLine,
  editorState,
  matchCountText,
  ruleLineAt,
  shownProblems,
} from './tab-model'

// The design's own examples: no real addresses in the app.
const rulesPlaceholder = 'someone@gmail.com\n@client.example'

const actionsClass = cn(
  'modal-actions flex justify-end gap-2 mt-6 [&>.modal-action-start]:mr-auto [&>.modal-action-start]:-ml-2.5',
  '[&>.modal-action-start]:text-muted [&>.modal-action-start:hover:not(:disabled)]:text-danger',
)

/** Which tab dialog shows; kept after closing so its words stay while it fades out. */
export type TabDialogState = (
  | {
      kind: 'edit'
      tab?: SplitTab
      focus: 'name' | 'rules'
      /** A new tab's rules to start with. */
      rules?: string[]
      /** The sender's rule, when "New tab…" was chosen in the add-to-tab picker. */
      added?: string
    }
  | { kind: 'delete'; tab: SplitTab }
) & {
  open: boolean
  seq: number
  /** Chosen in Ctrl+K, so focus goes to the active tab on closing. */
  fromCommand?: boolean
}

/**
 * The tab editor, the delete confirmation, the add-to-tab picker and the Always show box, for
 * `useSplitInbox`'s `dialogs`.
 */
export function TabDialogs({
  dialog,
  tabs,
  own,
  onClose,
  onSave,
  onDelete,
  picker,
  always,
}: {
  dialog?: TabDialogState
  tabs: SplitTab[]
  own: string[]
  onClose: () => void
  onSave: (tab: SplitTab) => Promise<void>
  onDelete: (tab: SplitTab) => Promise<void>
  picker: Omit<ComponentProps<typeof AddToTab>, 'tabs' | 'own'>
  always: ComponentProps<typeof AlwaysShowDialog>
}) {
  const edit = dialog?.kind === 'edit' ? dialog : undefined
  return (
    <>
      <AddToTab
        key={picker.state ? 'add-to-tab-' + picker.state.seq : 'add-to-tab'}
        {...picker}
        tabs={tabs}
        own={own}
      />
      <AlwaysShowDialog
        key={always.state ? 'always-show-' + always.state.seq : 'always-show'}
        {...always}
      />
      <TabEditor
        key={edit ? 'tab-editor-' + edit.seq : 'tab-editor'}
        open={!!edit?.open}
        tab={edit?.tab}
        rules={edit?.rules}
        tabs={tabs}
        own={own}
        focus={edit?.focus}
        onSave={onSave}
        onClose={onClose}
      />
      <DeleteTabDialog
        open={dialog?.kind === 'delete' && dialog.open}
        tab={dialog?.kind === 'delete' ? dialog.tab : undefined}
        onDelete={onDelete}
        onClose={onClose}
      />
    </>
  )
}

/** Names a tab and lists its addresses and domains, with how many inbox conversations match. */
export function TabEditor({
  open,
  tab,
  tabs,
  own,
  rules,
  onSave,
  onClose,
  focus = 'name',
}: {
  open: boolean
  /** The tab being edited; a new tab when left out. */
  tab?: SplitTab
  /** A new tab's rules to start with. */
  rules?: string[]
  /** Every user tab, so names stay unique. */
  tabs: SplitTab[]
  /** The user's own addresses, which rules may not match. */
  own: string[]
  /** Saves the tab; the box stays open until the caller closes it. */
  onSave: (tab: SplitTab) => Promise<void>
  onClose: () => void
  focus?: 'name' | 'rules'
}) {
  const [name, setName] = useState(tab?.name ?? '')
  const [rulesText, setRulesText] = useState((tab?.rules ?? rules)?.join('\n') ?? '')
  const [saving, setSaving] = useState(false)
  const state = editorState(name, rulesText, own, tabs, tab?.id)
  const match = useMatchCount(state.rules, open)
  const nameField = useRef<HTMLInputElement>(null)
  const rulesField = useRef<HTMLTextAreaElement>(null)
  const ids = useId()
  // The line holding the caret gets suggestions while the rules box has focus.
  const [caret, setCaret] = useState<number>()
  // An arrow key's choice; until then the first suggestion, or none on a line that is already a
  // rule, so Enter there starts the next line instead of replacing it.
  const [chosen, setChosen] = useState<number>()
  const [dismissed, setDismissed] = useState<string>()
  // Set when saving is blocked, so the line being typed says what's wrong with it.
  const [revealed, setRevealed] = useState(false)
  const line = caret === undefined ? undefined : ruleLineAt(rulesText, caret)
  const { items: suggestions, fresh } = useRuleSuggestions(line?.text, state.rules, open)
  const showing = !!line && suggestions.length > 0 && dismissed !== line.text
  const typingLine =
    line && !revealed ? rulesText.slice(0, line.start).split('\n').length : undefined
  const problems = shownProblems(state.problems, typingLine)
  const highlighted = Math.min(
    chosen ?? (line && parseRule(line.text) ? -1 : 0),
    suggestions.length - 1,
  )
  const track = (field: HTMLTextAreaElement) =>
    setCaret(field.selectionStart === field.selectionEnd ? field.selectionStart : undefined)
  const choose = (rule: string) => {
    if (caret === undefined) return
    const next = completeRuleLine(rulesText, caret, rule)
    setRulesText(next.text)
    setCaret(next.caret)
    setChosen(undefined)
    requestAnimationFrame(() => {
      rulesField.current?.focus()
      rulesField.current?.setSelectionRange(next.caret, next.caret)
    })
  }
  // Empty is only worth saying once something was typed; the button already waits for a name.
  const nameError = name.trim() ? state.nameError : undefined

  useEffect(() => {
    if (!open) return
    // After the dialog has placed focus: select the name to rename, or go to the end of the rules.
    const frame = requestAnimationFrame(() => {
      const field = focus === 'rules' ? rulesField.current : nameField.current
      if (!field) return
      field.focus()
      if (focus === 'rules') field.setSelectionRange(field.value.length, field.value.length)
      else field.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, focus])

  const save = async () => {
    if (!state.canSave) setRevealed(true)
    if (!state.canSave || saving) return
    setSaving(true)
    try {
      await onSave({ id: tab?.id ?? crypto.randomUUID(), name: name.trim(), rules: state.rules })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={tab ? 'Edit ' + tab.name : 'New tab'}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label className="modal-field [&_input]:mt-1.5">
          Name
          <input
            ref={nameField}
            autoFocus={focus === 'name'}
            value={name}
            aria-invalid={!!nameError}
            aria-describedby={nameError ? ids + '-name' : undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {nameError && (
          <p id={ids + '-name'} className="tab-name-error text-[12px] text-danger mt-1.5 mb-0">
            {nameError}
          </p>
        )}
        <label className="modal-field mt-4 [&_textarea]:mt-1.5">
          Addresses and domains, one per line
          <textarea
            ref={rulesField}
            autoFocus={focus === 'rules'}
            rows={6}
            className="resize-y leading-[1.6]"
            value={rulesText}
            placeholder={rulesPlaceholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={problems.length > 0 || !!state.limitError}
            aria-describedby={ids + '-rules'}
            aria-autocomplete="list"
            aria-controls={showing ? ids + '-suggestions' : undefined}
            aria-activedescendant={
              showing && highlighted >= 0 ? ids + '-suggestion-' + highlighted : undefined
            }
            onChange={(event) => {
              setRulesText(event.target.value)
              setChosen(undefined)
              setRevealed(false)
              track(event.target)
            }}
            onSelect={(event) => track(event.currentTarget)}
            onBlur={() => setCaret(undefined)}
            onKeyDown={(event) => {
              // Enter starts a new line here, so Ctrl+Enter saves.
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void save()
                return
              }
              // Enter that ends an input method's composition belongs to it.
              if (!showing || event.nativeEvent.isComposing) return
              if (event.altKey || event.ctrlKey || event.metaKey) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const n = suggestions.length
                if (highlighted < 0) setChosen(event.key === 'ArrowDown' ? 0 : n - 1)
                else setChosen((highlighted + (event.key === 'ArrowDown' ? 1 : -1) + n) % n)
              } else if (
                (event.key === 'Enter' || event.key === 'Tab') &&
                !event.shiftKey &&
                // Only a list for the text as it is now: never one meant for older text.
                fresh &&
                highlighted >= 0
              ) {
                event.preventDefault()
                choose(suggestions[highlighted]!.rule)
              } else if (event.key === 'Escape') {
                // Closes the list, not the dialog.
                event.preventDefault()
                event.stopPropagation()
                setDismissed(line.text)
              }
            }}
          />
        </label>
        {showing && (
          <div
            id={ids + '-suggestions'}
            role="listbox"
            aria-label="Suggestions"
            className={cn(
              'tab-rule-suggestions mt-1.5 p-1 bg-raised border border-solid border-border-strong rounded-lg',
              '[&_button]:flex [&_button]:items-baseline [&_button]:gap-2 [&_button]:w-full [&_button]:py-1.25',
              '[&_button]:px-2 [&_button]:text-left [&_button]:text-[12px] [&_button]:border-0 [&_button]:rounded-sm',
              '[&_button]:bg-none [&_button]:bg-transparent [&_button.active]:bg-hover',
              '[&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap',
              '[&_small]:text-[11px] [&_small]:text-muted [&_small]:shrink-0',
            )}
          >
            {suggestions.map((suggestion, i) => (
              <button
                type="button"
                key={suggestion.rule}
                id={ids + '-suggestion-' + i}
                role="option"
                aria-selected={i === highlighted}
                className={cn(i === highlighted && 'active')}
                tabIndex={-1}
                // Keeps focus, and the caret's line, in the rules box.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setChosen(i)}
                onClick={() => choose(suggestion.rule)}
              >
                <span>{suggestion.rule}</span>
                {suggestion.name && <small>{suggestion.name}</small>}
              </button>
            ))}
          </div>
        )}
        <div id={ids + '-rules'}>
          {state.limitError && (
            <p className="tab-limit-error text-[12px] text-danger mt-2 mb-0 leading-[1.6]">
              {state.limitError}
            </p>
          )}
          {problems.length > 0 && (
            <ul className="tab-rule-problems list-none p-0 mt-2 mb-0 text-[12px] text-danger leading-[1.6]">
              {problems.map((problem) => (
                <li key={problem.line}>
                  Line {problem.line}: {problem.reason}
                </li>
              ))}
            </ul>
          )}
          <p
            className="tab-match-count text-[12px] text-secondary mt-2 mb-0 min-h-[1.6em] leading-[1.6] tabular-nums"
            aria-live="polite"
          >
            {match.checking
              ? 'Checking…'
              : match.count !== undefined && matchCountText(match.count)}
          </p>
        </div>
        <div className={actionsClass}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!state.canSave || saving}>
            {tab ? 'Save tab' : 'Create tab'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Inbox conversations matching `rules`, asked for 300 ms after typing stops. A result for older
 * rules is never shown; nothing shows without rules or when the count can't be had.
 */
function useMatchCount(rules: string[], enabled: boolean): { checking?: boolean; count?: number } {
  const key = JSON.stringify(rules)
  const asking = enabled && rules.length > 0
  const [result, setResult] = useState<{ key: string; count?: number }>()
  useEffect(() => {
    if (!asking) return
    let current = true
    const timer = setTimeout(() => {
      api.tabMatchCount(JSON.parse(key) as string[]).then(
        (count) => current && setResult({ key, count }),
        () => current && setResult({ key }),
      )
    }, 300)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [key, asking])
  if (!asking) return {}
  if (result?.key !== key) return { checking: true }
  return { count: result.count }
}

/**
 * Rules from recent mail for the line being typed, asked for 150 ms after typing stops. While the
 * next list loads, the last one stays with what still matches, so it doesn't blink; `fresh` says
 * whether the list is for the text as it is now.
 */
function useRuleSuggestions(
  line: string | undefined,
  exclude: string[],
  enabled: boolean,
): { items: RuleSuggestion[]; fresh: boolean } {
  const text = line?.trim() ?? ''
  const asking = enabled && suggestionTerm(text) !== undefined
  const key = JSON.stringify([text, exclude])
  const [result, setResult] = useState<{ key: string; items: RuleSuggestion[] }>()
  useEffect(() => {
    if (!asking) return
    let current = true
    const timer = setTimeout(() => {
      const [line, rules] = JSON.parse(key) as [string, string[]]
      api.ruleSuggestions(line, rules).then(
        (items) => current && setResult({ key, items }),
        () => current && setResult({ key, items: [] }),
      )
    }, 150)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [key, asking])
  if (!asking || !result) return { items: [], fresh: false }
  if (result.key === key) return { items: result.items, fresh: true }
  const term = suggestionTerm(text)!
  const still = result.items.filter(
    (s) => s.rule.includes(term) || !!s.name?.toLowerCase().includes(term),
  )
  return { items: still, fresh: false }
}

export function DeleteTabDialog({
  open,
  tab,
  onDelete,
  onClose,
}: {
  open: boolean
  tab?: SplitTab
  onDelete: (tab: SplitTab) => Promise<void>
  onClose: () => void
}) {
  const [deleting, setDeleting] = useState(false)
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={tab ? 'Delete the tab “' + tab.name + '”?' : ''}
      description="Its rules are removed. No mail is moved or deleted."
    >
      <div className={actionsClass}>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          disabled={deleting}
          onClick={async () => {
            if (!tab) return
            setDeleting(true)
            try {
              await onDelete(tab)
            } finally {
              setDeleting(false)
            }
          }}
        >
          Delete tab
        </Button>
      </div>
    </Modal>
  )
}
