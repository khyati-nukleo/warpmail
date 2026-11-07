import { Eye } from '@inlark/ui/icons'
import { conversationOpened, isDraft, type Conversation } from '@inlark/core'
import { useReadStatus, useReadStatusSetup } from './useReadStatus'

/**
 * A small eye on conversations where someone opened an email the user sent. While read status is
 * set up its slot is kept on every row, so the list never shifts when statuses arrive.
 */
export function ReadStatusEye({ conversation: c }: { conversation: Conversation }) {
  const { configured } = useReadStatusSetup()
  const sent = c.messages.filter((m) => !isDraft(m)) // the same messages, and key, as the Reader
  const statuses = [...useReadStatus(c.accountId, sent, sent).values()].flat()
  if (!configured) return null
  const opened = statuses.filter((s) => s.state === 'opened')
  const names = opened.map((s) => {
    const known = c.messages
      .flatMap((m) => [...m.to, ...m.cc, ...m.bcc])
      .find((a) => a.email.trim().toLowerCase() === s.email.toLowerCase())
    return known?.name || s.email
  })
  return (
    <span
      className="row-read-status w-3.25 flex"
      title={names.length ? 'Opened by ' + [...new Set(names)].join(', ') : undefined}
    >
      {conversationOpened(statuses) && <Eye size={13} aria-label="Opened" />}
    </span>
  )
}
