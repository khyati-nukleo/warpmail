import { useState } from 'react'
import { IconButton } from '@inlark/ui'
import { Info } from '@inlark/ui/icons'
import type { Address, RecipientReadStatus } from '@inlark/core'
import { readStatusLine, readStatusSmallPrint } from './read-status-text'

/** Who opened a sent email, one row per recipient. Renders nothing for untracked emails. */
export function ReadStatusPanel({
  statuses,
  recipients,
}: {
  statuses?: RecipientReadStatus[]
  recipients: Address[]
}) {
  const [smallPrint, setSmallPrint] = useState(false)
  if (!statuses?.length) return null
  const now = new Date()
  const name = (email: string) =>
    recipients.find((a) => a.email.trim().toLowerCase() === email.toLowerCase())?.name || email
  return (
    <section className="read-status mt-5 text-[12px] text-muted" aria-label="Read status">
      <div className="flex items-start gap-1">
        <ul className="flex-1 min-w-0 flex flex-col gap-1 m-0 p-0 list-none">
          {statuses.map((status) => (
            <li className="flex gap-2 min-w-0" key={status.email}>
              <span className="text-secondary shrink-0 max-w-[45%] overflow-hidden text-ellipsis whitespace-nowrap">
                {name(status.email)}
              </span>
              <span className="min-w-0">{readStatusLine(status, now)}</span>
            </li>
          ))}
        </ul>
        <IconButton
          label={smallPrint ? 'Hide how read status counts' : 'How read status counts'}
          aria-expanded={smallPrint}
          className="-mt-1.5"
          onClick={() => setSmallPrint((open) => !open)}
        >
          <Info size={13} />
        </IconButton>
      </div>
      {smallPrint && (
        <div className="mt-2.5 py-2.5 px-3.5 bg-surface rounded-[7px] text-[11px] leading-[17px]">
          <p className="m-0">{readStatusSmallPrint[0]}</p>
          <ul className="mt-1.5 mb-0 pl-4 list-disc">
            {readStatusSmallPrint.slice(1).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
