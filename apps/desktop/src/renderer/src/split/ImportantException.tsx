import { Button, Modal } from '@inlark/ui'
import type { Address } from '@inlark/core'
import { useId, useState } from 'react'
import { parseWords, wordsProblem } from './tab-model'

/** The sender let into Important; kept after closing so the box's words stay as it fades out. */
export interface AlwaysShowState {
  sender: Address
  /** The sender's subject words, when they already have an Always entry. */
  words: string[]
  editing: boolean
  open: boolean
  seq: number
  /** Chosen in Ctrl+K, so focus goes to the active tab on closing. */
  fromCommand?: boolean
}

/** "Always show in Important": lets a sender in, optionally only for subjects with given words. */
export function AlwaysShowDialog({
  state,
  onClose,
  onSave,
}: {
  state?: AlwaysShowState
  onClose: () => void
  /** Saves the entry; the box stays open until the caller closes it. */
  onSave: (words: string[]) => Promise<void>
}) {
  const [text, setText] = useState(state?.words.join(', ') ?? '')
  const [saving, setSaving] = useState(false)
  const ids = useId()
  const problem = wordsProblem(text)

  const save = async () => {
    if (problem || saving) return
    setSaving(true)
    try {
      await onSave(parseWords(text))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={!!state?.open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={state?.editing ? 'Edit Always show' : 'Always show in Important'}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label className="modal-field [&_input]:mt-1.5">
          Sender
          <input readOnly value={state?.sender.email ?? ''} className="text-secondary" />
        </label>
        <label className="modal-field mt-4 [&_input]:mt-1.5">
          Only when the subject contains
          <input
            autoFocus
            value={text}
            placeholder="crash, failure"
            spellCheck={false}
            aria-invalid={!!problem}
            aria-describedby={ids + '-hint'}
            onFocus={(event) => {
              const end = event.target.value.length
              event.target.setSelectionRange(end, end)
            }}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div id={ids + '-hint'}>
          <p className="text-[12px] text-secondary mt-1.5 mb-0 leading-[1.6]">
            Leave empty to always show this sender.
          </p>
          {problem && (
            <p className="important-words-error text-[12px] text-danger mt-1.5 mb-0 leading-[1.6]">
              {problem}
            </p>
          )}
        </div>
        <div className="modal-actions flex justify-end gap-2 mt-6">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!!problem || saving}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  )
}
