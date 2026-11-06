/** How long typing must pause before a draft is saved to the server. Local saves are instant. */
export const serverSaveIdleMs = 10_000

/**
 * Schedules server saves of a draft: one after each pause in typing, and never more than one
 * at a time. Edits during a save are covered by a single trailing save once it finishes.
 */
export function serverSaves(save: () => Promise<unknown>, idleMs = serverSaveIdleMs) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  let trailing = false
  const run = () => {
    timer = undefined
    if (running) {
      trailing = true
      return
    }
    running = save()
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        running = undefined
        if (trailing) {
          trailing = false
          run()
        }
      })
  }
  return {
    /** Call after every edit: the save waits until edits pause. */
    schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, idleMs)
    },
    /** Drops any save not yet started. Returns whether one was due. */
    cancel() {
      const due = !!timer || trailing
      if (timer) clearTimeout(timer)
      timer = undefined
      trailing = false
      return due
    },
    /** Settles once no save is in progress. */
    async settled() {
      while (running) await running
    },
  }
}
