import { Button, cn, Modal } from '@inlark/ui'
import type { SplitTab } from '@inlark/core'
import { useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { api } from '../api'
import { AddToTab } from './AddToTab'
import { editorState, matchCountText } from './tab-model'

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

/** The tab editor, the delete confirmation and the add-to-tab picker, for `useSplitInbox`'s `dialogs`. */
export function TabDialogs({
  dialog,
  tabs,
  own,
  onClose,
  onSave,
  onDelete,
  picker,
}: {
  dialog?: TabDialogState
  tabs: SplitTab[]
  own: string[]
  onClose: () => void
  onSave: (tab: SplitTab) => Promise<void>
  onDelete: (tab: SplitTab) => Promise<void>
  picker: Omit<ComponentProps<typeof AddToTab>, 'tabs' | 'own'>
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
            aria-invalid={state.problems.length > 0 || !!state.limitError}
            aria-describedby={ids + '-rules'}
            onChange={(event) => setRulesText(event.target.value)}
            onKeyDown={(event) => {
              // Enter starts a new line here, so Ctrl+Enter saves.
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void save()
              }
            }}
          />
        </label>
        <div id={ids + '-rules'}>
          {state.limitError && (
            <p className="tab-limit-error text-[12px] text-danger mt-2 mb-0 leading-[1.6]">
              {state.limitError}
            </p>
          )}
          {state.problems.length > 0 && (
            <ul className="tab-rule-problems list-none p-0 mt-2 mb-0 text-[12px] text-danger leading-[1.6]">
              {state.problems.map((problem) => (
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

function DeleteTabDialog({
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
