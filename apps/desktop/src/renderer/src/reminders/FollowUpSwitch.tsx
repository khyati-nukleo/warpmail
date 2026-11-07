import { Button } from '@inlark/ui'
import type { Account, Draft } from '@inlark/core'
import {
  ignoreInputsForCommand,
  useShortcutHandlers,
  useShortcuts,
  useShortcutText,
} from '../shortcuts'
import { followUpLabel, followUpShown, useFollowUpGuess } from './draft-text'
import { useReminderSettings } from './ReminderLabel'

/** Shows the ask-check's guess for the draft; a click or Mod+Shift+O overrides it. */
export function FollowUpSwitch({
  draft,
  account,
  disabled,
  onChange,
}: {
  draft: Draft
  account: Pick<Account, 'protocol'>
  disabled?: boolean
  onChange(followUp: boolean): void
}) {
  const settings = useReminderSettings()
  const shortcuts = useShortcuts()
  const keys = useShortcutText()
  const shown = followUpShown({
    protocol: account.protocol,
    settings,
    recipients: draft.to.length + draft.cc.length + draft.bcc.length,
  })
  const guessed = useFollowUpGuess(draft, shown)
  const on = draft.followUp ?? guessed
  useShortcutHandlers(shortcuts.bindings, {
    toggleFollowUp: {
      ignoreInputs: ignoreInputsForCommand,
      run: () => onChange(!on),
      enabled: shown && !disabled,
    },
  })
  if (!shown) return null
  return (
    <Button
      size="small"
      variant="ghost"
      aria-pressed={on}
      title={'Follow-up on or off ' + keys('toggleFollowUp')}
      disabled={disabled}
      className={on ? 'text-primary' : 'text-muted'}
      onClick={() => onChange(!on)}
    >
      {followUpLabel(on, guessed)}
    </Button>
  )
}
