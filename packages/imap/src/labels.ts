import { reminderLabelNames, reminderLabelRoot, type ReminderLabel } from '@inlark/core'

/** The `Warpmail` folder or one under it: Gmail labels that hold reminder choices. */
export function isWarpmailFolder(path: string, delimiter: string): boolean {
  return (
    path === reminderLabelRoot || (!!delimiter && path.startsWith(reminderLabelRoot + delimiter))
  )
}

/** Where a reminder label lives, e.g. `Warpmail/No reminder`. */
export function labelPath(label: ReminderLabel, delimiter: string): string {
  return reminderLabelRoot + delimiter + reminderLabelNames[label]
}
