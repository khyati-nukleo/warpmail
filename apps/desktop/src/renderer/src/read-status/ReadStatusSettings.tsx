import { useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Switch, cn } from '@inlark/ui'
import { friendlyError, workerBase, type Bootstrap } from '@inlark/core'
import { api } from '../api'
import { queryClient } from '../cache'
import { saveSplitSettings } from '../split/split-saves'

const sectionClass = cn(
  'setting-section my-6.25 mx-0 [&_h4]:text-[11px] [&_h4]:font-medium [&_h4]:mt-0 [&_h4]:mb-3 [&_h4]:mx-0',
  '[&_h4]:text-secondary [&+.setting-section]:border-t [&+.setting-section]:border-solid',
  '[&+.setting-section]:border-t-border [&+.setting-section]:pt-5.5',
)
const noteClass = 'text-muted text-[12px] leading-[1.6] my-1 mx-0'
const errorClass = 'text-danger text-[12px] leading-[1.6] mt-1.5 mb-0'
const fieldClass = 'h-8 py-0 px-2.5 text-[12px] min-w-0'
const labelClass = 'block text-[13px] mb-1.5'

/** Settings → Read status: the switch, the Worker's address and password, and how it is going. */
export function ReadStatusSettings({
  bootstrap,
  notify,
}: {
  bootstrap: Bootstrap
  notify: (message: string, tone?: 'error' | 'info') => void
}) {
  const ids = useId()
  const saved = bootstrap.settings.readStatus
  const enabled = saved?.enabled !== false
  const info = useQuery({ queryKey: ['readStatus', 'info'], queryFn: () => api.readStatusInfo() })
  const secureStorage = info.data?.secureStorage ?? bootstrap.secureStorage
  const passwordSet = !!info.data?.passwordSet

  const [address, setAddress] = useState(saved?.workerUrl ?? '')
  const [addressProblem, setAddressProblem] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'save' | 'remove' | 'test'>()
  const [result, setResult] = useState<{ ok: boolean; message: string }>()
  /** An address being saved; Test waits for it, since the saved password goes only there. */
  const savingAddress = useRef<Promise<unknown>>(undefined)

  const save = async (change: { enabled?: boolean; workerUrl?: string }) => {
    try {
      await saveSplitSettings((latest) => ({
        readStatus: {
          enabled: latest.readStatus?.enabled !== false,
          ...latest.readStatus,
          ...change,
        },
      }))
      return true
    } catch (error) {
      notify(friendlyError(error), 'error')
      return false
    }
  }

  const saveAddress = () => {
    const text = address.trim()
    if (text === (saved?.workerUrl ?? '')) {
      setAddressProblem(!!text && !workerBase(text))
      return
    }
    // An empty address clears it; anything else must be a usable Worker address.
    const base = text ? workerBase(text) : ''
    if (base === undefined) {
      setAddressProblem(true)
      return
    }
    setAddressProblem(false)
    setAddress(base)
    savingAddress.current = save({ workerUrl: base || undefined })
  }

  const savePassword = async () => {
    if (!password || busy) return
    setBusy('save')
    try {
      await api.setReadStatusPassword(password)
      setPassword('')
      setResult(undefined)
      void queryClient.invalidateQueries({ queryKey: ['readStatus'] })
      notify('Read status password saved')
    } catch (error) {
      notify(friendlyError(error), 'error')
    } finally {
      setBusy(undefined)
    }
  }
  const removePassword = async () => {
    if (busy) return
    setBusy('remove')
    try {
      await api.setReadStatusPassword(null)
      setPassword('')
      setResult(undefined)
      void queryClient.invalidateQueries({ queryKey: ['readStatus'] })
    } catch (error) {
      notify(friendlyError(error), 'error')
    } finally {
      setBusy(undefined)
    }
  }
  const test = async () => {
    const base = workerBase(address)
    if (!base) {
      setAddressProblem(true)
      return
    }
    setBusy('test')
    setResult(undefined)
    try {
      await savingAddress.current
      // A password typed but not saved yet is tested as is; otherwise the saved one is used,
      // and only for the saved address (another address needs its password typed).
      setResult(await api.testReadStatus(base, password || undefined))
    } catch (error) {
      setResult({ ok: false, message: friendlyError(error) })
    } finally {
      setBusy(undefined)
    }
  }

  const collected = info.data?.lastCollectedAt ? new Date(info.data.lastCollectedAt) : undefined

  return (
    <>
      <h3 className="m-0 text-[20px] font-[550] tracking-[-0.5px]">Read status</h3>
      <p className="settings-lead text-muted mt-1.5 mb-6 mx-0 text-[12px] leading-[1.6]">
        Shows, for each recipient, whether an email you sent was probably opened. Some mail apps
        hide opens, so &ldquo;No signal yet&rdquo; doesn&rsquo;t mean unread.
      </p>

      <section className={sectionClass} aria-labelledby={ids + '-on'}>
        <div className="flex items-center justify-between gap-6 min-h-10">
          <div>
            <strong id={ids + '-on'} className="font-normal text-[13px]">
              Track read status
            </strong>
            <p className={noteClass}>
              Adds an invisible image to emails you send, so opens can be seen. You can turn it off
              for any email in the composer.
            </p>
          </div>
          <Switch
            aria-labelledby={ids + '-on'}
            checked={enabled}
            onCheckedChange={(on) => void save({ enabled: on })}
          />
        </div>
      </section>

      <section className={sectionClass} aria-labelledby={ids + '-worker'}>
        <h4 id={ids + '-worker'}>Worker</h4>
        <label className={labelClass} htmlFor={ids + '-address'}>
          Worker address
        </label>
        <input
          id={ids + '-address'}
          className={cn(fieldClass, 'w-full')}
          type="url"
          value={address}
          placeholder="https://read.example.com"
          aria-invalid={addressProblem}
          aria-describedby={addressProblem ? ids + '-address-problem' : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => {
            setAddress(event.target.value)
            setAddressProblem(false)
          }}
          onBlur={saveAddress}
          onKeyDown={(event) => {
            if (event.key === 'Enter') saveAddress()
          }}
        />
        {!address.trim() && !addressProblem && (
          <p className={noteClass}>No address yet, so nothing is tracked.</p>
        )}
        {addressProblem && (
          <p id={ids + '-address-problem'} role="alert" className={errorClass}>
            Enter the Worker&rsquo;s https address.
          </p>
        )}

        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault()
            void savePassword()
          }}
        >
          <label className={labelClass} htmlFor={ids + '-password'}>
            Worker password
          </label>
          <div className="flex flex-wrap gap-1.5">
            <input
              id={ids + '-password'}
              className={cn(fieldClass, 'flex-[1_1_180px]')}
              type="password"
              value={password}
              placeholder={passwordSet ? 'Saved' : ''}
              disabled={!secureStorage}
              autoComplete="new-password"
              spellCheck={false}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button size="small" type="submit" disabled={!secureStorage || !password || !!busy}>
              Save password
            </Button>
            {passwordSet && (
              <Button
                size="small"
                variant="ghost"
                type="button"
                disabled={!!busy}
                onClick={() => void removePassword()}
              >
                Remove
              </Button>
            )}
          </div>
          {!secureStorage && (
            <p className={noteClass}>
              Your system keyring isn&rsquo;t available, so the password can&rsquo;t be stored
              safely on this computer.
            </p>
          )}
        </form>

        <div className="flex items-center gap-3 mt-4">
          <Button size="small" type="button" disabled={!!busy} onClick={() => void test()}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </Button>
          {result && (
            <p
              role="status"
              className={cn(
                'm-0 text-[12px] leading-[1.6]',
                result.ok ? 'text-muted' : 'text-danger',
              )}
            >
              {result.message}
            </p>
          )}
        </div>
        <p className="setting-footnote text-muted text-[12px] leading-[1.6] mt-3 mb-0">
          Use the same address and password on both laptops. Changing the password hides statuses of
          emails sent before.
        </p>
        <p className="text-faint text-[12px] leading-[1.6] mt-1 mb-0">
          Setup steps: <span className="font-mono">services/read-status-worker/README.md</span> in
          the Warpmail repository.
        </p>
      </section>

      <section className={sectionClass} aria-labelledby={ids + '-last'}>
        <h4 id={ids + '-last'}>Last check</h4>
        <p className={noteClass}>
          {collected
            ? 'Opens were last collected ' + collected.toLocaleString() + '.'
            : 'Opens haven’t been collected yet.'}
        </p>
        {info.data?.error && <p className={errorClass}>{info.data.error}</p>}
      </section>
    </>
  )
}
