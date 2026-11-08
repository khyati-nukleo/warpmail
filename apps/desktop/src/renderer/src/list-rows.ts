import { conversationSortKey, type Conversation } from '@inlark/core'
import { day } from './mail-date'

export type ListRow = { group: string } | { conversation: Conversation }

/** Rows under day headers; a reminder-raised conversation sits under the day it came due. */
export function listRows(conversations: Conversation[]): ListRow[] {
  const result: ListRow[] = []
  let previous = ''
  for (const conversation of conversations) {
    const group = day(conversationSortKey(conversation))
    if (group !== previous) {
      result.push({ group })
      previous = group
    }
    result.push({ conversation })
  }
  return result
}
