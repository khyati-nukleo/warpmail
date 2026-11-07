import { Button } from '@inlark/ui'
import { readStatusLimits, trackedRecipients, trackingBlock, type Draft } from '@inlark/core'
import type { Protection } from '../ComposerProtection'
import { useReadStatusInfo, useReadStatusSetup } from './useReadStatus'

const notTracked = {
  protected: 'Not tracked: encrypted and signed emails can’t carry read status.',
  self: 'Not tracked: you’re a recipient.',
  noHtml: 'Not tracked: plain-text emails can’t carry read status.',
  automated: 'Not tracked: every recipient is an automated address.',
  tooMany: `Not tracked: more than ${readStatusLimits.recipients} recipients.`,
} as const

/** “Read status: on/off” for one email; hidden until read status is set up for this account. */
export function ReadStatusSwitch({
  draft,
  protection,
  onChange,
}: {
  draft: Draft
  protection: Protection
  onChange: (readStatus: boolean) => void
}) {
  const { settings, accounts, own } = useReadStatusSetup()
  const info = useReadStatusInfo()
  const account = accounts.find((a) => a.id === draft.accountId)
  const block = trackingBlock({
    settings,
    passwordSet: !!info.data?.passwordSet,
    draft,
    protection,
    perCopySending: account?.protocol === 'imap',
    ownAddresses: own,
  })
  if (block === 'off' || block === 'notConfigured' || block === 'unsupported') return null
  // Nothing addressed or written yet is not a reason to show the email as untracked.
  const unfinished =
    (block === 'automated' && !trackedRecipients(draft).length) ||
    (block === 'noHtml' && !draft.text.trim())
  const reason = block && !unfinished && block !== 'switchedOff' ? notTracked[block] : undefined
  const on = !block || unfinished
  return (
    <Button
      variant="ghost"
      size="small"
      className="compose-read-status text-muted"
      aria-disabled={reason ? true : undefined}
      title={reason}
      onClick={() => {
        if (!reason) onChange(!on)
      }}
    >
      {on ? 'Read status: on' : 'Read status: off'}
    </Button>
  )
}
