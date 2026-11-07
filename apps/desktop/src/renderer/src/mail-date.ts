const sameYear = (d: Date) => d.getFullYear() === new Date().getFullYear()
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const currentYearFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const otherYearFormatter = new Intl.DateTimeFormat(undefined, {
  year: '2-digit',
  month: 'numeric',
  day: 'numeric',
})

export const day = (date: string) => {
  const d = new Date(date)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'Today'
  today.setDate(today.getDate() - 1)
  return d.toDateString() === today.toDateString()
    ? 'Yesterday'
    : d.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        ...(sameYear(d) ? {} : { year: 'numeric' }),
      })
}

export const shortDate = (date: string) => {
  const d = new Date(date)
  if (d.toDateString() === new Date().toDateString()) return timeFormatter.format(d)
  return sameYear(d) ? currentYearFormatter.format(d) : otherYearFormatter.format(d)
}

/** “Thu, Sep 25, 2026 at 10:16 AM”, as used in reply attributions and message details. */
export const longDate = (date: string) => {
  const d = new Date(date)
  return (
    d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }) +
    ' at ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  )
}

/** Reader timestamp: time only today, otherwise date and time. */
export const messageDate = (date: string) => {
  const d = new Date(date)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return { date: 'Today', time }
  return {
    date: d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(sameYear(d) ? {} : { year: 'numeric' }),
    }),
    time,
  }
}

/** “today 3:12 pm”, “yesterday 9:05 am”, otherwise “Nov 3, 3:12 pm”, counted from `now`. */
export const dayTime = (date: string, now = new Date()) => {
  const d = new Date(date)
  const time = timeFormatter
    .formatToParts(d)
    .map((p) => (p.type === 'dayPeriod' ? p.value.toLowerCase() : p.value.replace(/\s/g, ' ')))
    .join('')
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return 'today ' + time
  if (d.toDateString() === yesterday.toDateString()) return 'yesterday ' + time
  const formatter =
    d.getFullYear() === now.getFullYear() ? currentYearFormatter : otherYearFormatter
  return formatter.format(d) + ', ' + time
}

export const formatBytes = (bytes: number) =>
  bytes < 1024
    ? bytes + ' B'
    : bytes < 1024 * 1024
      ? Math.max(1, Math.round(bytes / 1024)).toLocaleString() + ' KB'
      : (bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' MB'
