// Warpmail perf log (temporary): timing hooks for the IMAP/SMTP package. No Electron imports;
// the desktop app installs a logger with `setImapPerfLogger`. Never pass message content,
// subjects, addresses or passwords here: only operation names, folder paths, codes and ms.
import type { ImapPort, PortFactory } from './port'

export type ImapPerfLogger = (op: string, fields: Record<string, unknown>) => void
let logger: ImapPerfLogger = () => {}

export function setImapPerfLogger(next: ImapPerfLogger | undefined) {
  logger = next || (() => {})
}
export function imapPerf(op: string, fields: Record<string, unknown>) {
  try {
    logger(op, fields)
  } catch {
    // Logging must never break mail.
  }
}
const since = (start: number) => Math.round((performance.now() - start) * 10) / 10
const codeOf = (error: unknown) =>
  (error as { code?: unknown })?.code !== undefined
    ? String((error as { code?: unknown }).code)
    : 'error'

/** The calling method of `ImapProvider.run`, read from the stack (main isn't minified). */
export function callerLabel(depth = 3): string {
  const line = new Error().stack?.split('\n')[depth] || ''
  const match = /at (?:async )?(?:ImapProvider\.)?([\w$.<>]+)/.exec(line)
  return match?.[1] || 'unknown'
}

// Method arguments that are safe to log: folder paths and counts, never content.
const pathArg: Record<string, (args: unknown[]) => Record<string, unknown>> = {
  status: (a) => ({ path: a[0] }),
  select: (a) => ({ path: a[0] }),
  append: (a) => ({ path: a[0], bytes: (a[1] as Uint8Array)?.byteLength }),
  move: (a) => ({ uids: (a[0] as number[])?.length }),
  copy: (a) => ({ uids: (a[0] as number[])?.length }),
  store: (a) => ({ uids: (a[0] as number[])?.length }),
  expunge: (a) => ({ uids: (a[0] as number[])?.length }),
  fetch: (a) => ({ range: String(a[0]).length > 40 ? 'set' : a[0], keys: Object.keys(a[1] || {}) }),
  source: () => ({}),
  download: (a) => ({ part: a[1] }),
}
let connectionIds = 0

/** Wraps every port the factory creates so each call, connect and close is timed. */
export function timedPorts(factory: PortFactory): PortFactory {
  return (options, purpose) => {
    const port = factory(options, purpose)
    const conn = ++connectionIds
    let connectedAt = 0
    let closing = false
    port.on('close', () =>
      imapPerf('imap:closed', {
        purpose,
        conn,
        reason: closing ? 'client-close' : 'remote-or-socket',
        lifetimeMs: connectedAt ? since(connectedAt) : 0,
      }),
    )
    return new Proxy(port, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        if (key === 'on' || typeof key !== 'string') return value.bind(target)
        return (...args: unknown[]) => {
          if (key === 'close') closing = true
          if (key === 'connect') imapPerf('imap:connect-start', { purpose, conn })
          const start = performance.now()
          const extra = pathArg[key]?.(args) || {}
          const done = (ok: boolean, error?: unknown) => {
            const ms = since(start)
            if (key === 'connect') {
              if (ok) connectedAt = performance.now()
              imapPerf('imap:connect', {
                purpose,
                conn,
                ms,
                ok,
                ...(ok ? {} : { code: codeOf(error) }),
              })
            } else
              imapPerf('imap:port', {
                method: key,
                purpose,
                conn,
                ms,
                ok,
                ...extra,
                ...(ok ? {} : { code: codeOf(error) }),
              })
          }
          let result: unknown
          try {
            result = value.apply(target, args)
          } catch (error) {
            done(false, error)
            throw error
          }
          if (result && typeof (result as Promise<unknown>).then === 'function')
            return (result as Promise<unknown>).then(
              (v) => {
                done(true)
                return v
              },
              (error) => {
                done(false, error)
                throw error
              },
            )
          done(true)
          return result
        }
      },
    }) as ImapPort
  }
}
