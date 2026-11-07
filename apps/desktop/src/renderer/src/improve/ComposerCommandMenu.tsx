import { useState } from 'react'
import { useHotkeys, useHotkeySequences, type Hotkey } from '@tanstack/react-hotkeys'
import { ArrowUpRight, Paperclip, Send, Sparkles, Trash2, UserRound, X } from '@inlark/ui/icons'
import type { ImproveStyle } from '@inlark/core'
import { CommandPalette, type Command } from '../CommandPalette'
import { ignoreInputsForCommand, useShortcuts, useShortcutText, type Binding } from '../shortcuts'
import { unavailableLines, type Improve } from './useImprove'

export interface ComposerActions {
  send: () => void
  attachFiles: () => void
  showCc: () => void
  showBcc: () => void
  expand: () => void
  saveClose: () => void
  discard: () => void
}

/** The command menu while composing: Improve first, then what the composer can do. */
export function ComposerCommandMenu({
  improve,
  actions,
  canEdit,
  canSend,
  enabled,
}: {
  improve: Improve
  actions: ComposerActions
  /** Matches the composer shortcuts that change the draft. */
  canEdit: boolean
  /** Matches the send and save-and-close shortcuts. */
  canSend: boolean
  enabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const { bindings } = useShortcuts()
  const keys = useShortcutText()
  const toggle = () => setOpen((current) => !current)
  // App turns its own command menu off while composing. Its key is registered next to App's
  // (`allow`), not in place of it: a replaced registration is taken back on App's next render.
  const options = (binding: Binding) =>
    ({ conflictBehavior: 'allow', enabled, ignoreInputs: ignoreInputsForCommand(binding) }) as const
  useHotkeys(
    bindings.commandMenu
      .filter((binding) => binding.length === 1)
      .map((binding) => ({
        hotkey: binding[0] as Hotkey,
        callback: toggle,
        options: options(binding),
      })),
  )
  useHotkeySequences(
    bindings.commandMenu
      .filter((binding) => binding.length > 1)
      .map((binding) => ({
        sequence: binding as Hotkey[],
        callback: toggle,
        options: options(binding),
      })),
  )

  const reason = improve.availability.available ? undefined : improve.availability.reason
  const improveCommand = (id: string, label: string, style: ImproveStyle, key?: string) => ({
    id,
    group: 'Write',
    label,
    icon: Sparkles,
    key,
    keywords: 'ai claude rewrite',
    // Running it anyway shows the same line under the toolbar.
    ...(reason ? { disabled: true, description: unavailableLines[reason] } : {}),
    run: () => improve.start(style),
  })
  const action = (
    id: string,
    label: string,
    icon: Command['icon'],
    run: () => void,
    available: boolean,
    key?: string,
  ): Command => ({
    id,
    group: 'Write',
    label,
    icon,
    key,
    ...(available ? { run } : { disabled: true, run: () => {} }),
  })
  const commands: Command[] = [
    improveCommand('improve-polish', 'Improve draft', 'polish', keys('improveDraft')),
    improveCommand('improve-shorter', 'Make it shorter', 'shorter'),
    improveCommand('improve-formal', 'Make it more formal', 'formal'),
    improveCommand('improve-friendly', 'Make it friendlier', 'friendly'),
    action('send', 'Send message', Send, actions.send, canSend, keys('send')),
    action('attach', 'Attach files', Paperclip, actions.attachFiles, canEdit, keys('attachFiles')),
    action('cc', 'Show Cc', UserRound, actions.showCc, canEdit, keys('showCc')),
    action('bcc', 'Show Bcc', UserRound, actions.showBcc, canEdit, keys('showBcc')),
    action(
      'expand',
      'Expand or restore composer',
      ArrowUpRight,
      actions.expand,
      true,
      keys('expandComposer'),
    ),
    action('save-close', 'Save and close draft', X, actions.saveClose, canSend, keys('saveClose')),
    action('discard', 'Discard draft', Trash2, actions.discard, canEdit, keys('discardDraft')),
  ]
  return <CommandPalette open={open} onClose={() => setOpen(false)} commands={commands} />
}
