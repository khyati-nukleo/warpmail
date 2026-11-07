import type { Draft, ReadStatusSettings } from './model'
import { isAutomatedAddress } from './split'

export const readStatusLimits = { recipients: 25 }

export type TrackingBlock =
  | 'off'
  | 'notConfigured'
  | 'switchedOff'
  | 'protected'
  | 'self'
  | 'noHtml'
  | 'automated'
  | 'tooMany'
  | 'unsupported'

/** The Worker's origin when it is safe to use: https (or local http), no credentials, no path. */
export function workerBase(url?: string): string | undefined {
  if (!url) return undefined
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return undefined
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local))) return undefined
  if (parsed.username || parsed.password) return undefined
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined
  return parsed.origin
}

export function pixelUrl(base: string, code: string): string {
  return `${base}/p/${code}.gif`
}

export function isWorkerImage(src: string, base?: string): boolean {
  if (!base) return false
  try {
    return new URL(src.trim()).origin === new URL(base).origin
  } catch {
    return false
  }
}

export function addPixel(html: string, src: string): string {
  const img = `<img src="${src}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`
  const at = html.toLowerCase().lastIndexOf('</body>')
  return at < 0 ? html + img : html.slice(0, at) + img + html.slice(at)
}

const space = /[\s]/

/**
 * Reads one `<img ...>` tag starting at `start` the way a browser would (double-quoted,
 * single-quoted and unquoted values). Returns the tag's end and its src values, or undefined
 * when a quoted value never closes.
 */
function readImg(html: string, start: number): { end: number; sources: string[] } | undefined {
  const sources: string[] = []
  let i = start + 4
  const n = html.length
  while (i < n) {
    while (i < n && (space.test(html[i]) || html[i] === '/')) i++
    if (i >= n) return undefined
    if (html[i] === '>') return { end: i + 1, sources }
    let name = ''
    if (html[i] === '=') name = html[i++]
    while (i < n && !space.test(html[i]) && !'=>/'.includes(html[i])) name += html[i++]
    while (i < n && space.test(html[i])) i++
    if (html[i] !== '=') continue
    i++
    while (i < n && space.test(html[i])) i++
    let value: string
    if (html[i] === '"' || html[i] === "'") {
      const close = html.indexOf(html[i], i + 1)
      if (close < 0) return undefined
      value = html.slice(i + 1, close)
      i = close + 1
    } else {
      const from = i
      while (i < n && !space.test(html[i]) && html[i] !== '>') i++
      value = html.slice(from, i)
    }
    if (name.toLowerCase() === 'src') sources.push(value)
  }
  return undefined
}

/**
 * Removes every image served by the Worker, so a quoted copy never reports someone else's open.
 * Fails safe: an image tag that cannot be parsed, or that mentions the Worker's host anywhere
 * (even in another attribute), is removed too.
 */
export function stripPixels(html: string, base?: string): string {
  if (!base) return html
  let host: string
  try {
    host = new URL(base).host.toLowerCase()
  } catch {
    return html
  }
  let out = ''
  let last = 0
  const open = /<img(?=[\s/>])/gi
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const parsed = readImg(html, m.index)
    let end = parsed?.end
    if (end === undefined) {
      const gt = html.indexOf('>', m.index)
      end = gt < 0 ? html.length : gt + 1
    }
    const tag = html.slice(m.index, end)
    const remove =
      !parsed ||
      parsed.sources.some((src) => isWorkerImage(src, base)) ||
      tag.toLowerCase().includes(host)
    if (remove) {
      out += html.slice(last, m.index)
      last = end
    }
    open.lastIndex = end
  }
  return out + html.slice(last)
}

export function trackedRecipients(draft: Pick<Draft, 'to' | 'cc' | 'bcc'>): string[] {
  const seen = new Set<string>()
  for (const a of [...draft.to, ...draft.cc, ...draft.bcc]) {
    const email = a.email.trim().toLowerCase()
    if (email) seen.add(email)
  }
  return [...seen]
}

export function trackingBlock(input: {
  settings?: ReadStatusSettings
  passwordSet: boolean
  draft: Pick<Draft, 'to' | 'cc' | 'bcc' | 'html' | 'readStatus'>
  protection: 'none' | 'encrypt' | 'sign'
  perCopySending: boolean
  /** The user's own addresses, lowercased. On Gmail a copy to oneself is the merged Sent copy. */
  ownAddresses: string[]
}): TrackingBlock | undefined {
  const settings = input.settings ?? { enabled: true }
  if (!settings.enabled) return 'off'
  if (!workerBase(settings.workerUrl) || !input.passwordSet) return 'notConfigured'
  if (!input.perCopySending) return 'unsupported'
  if (input.draft.readStatus === false) return 'switchedOff'
  if (input.protection !== 'none') return 'protected'
  const recipients = trackedRecipients(input.draft)
  if (recipients.some((email) => input.ownAddresses.includes(email))) return 'self'
  if (!input.draft.html.trim()) return 'noHtml'
  if (!recipients.some((email) => !isAutomatedAddress(email))) return 'automated'
  if (recipients.length > readStatusLimits.recipients) return 'tooMany'
  return undefined
}
