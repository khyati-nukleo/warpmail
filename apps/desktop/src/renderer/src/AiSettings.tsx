import { cn } from '@inlark/ui'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, Sparkles } from '@inlark/ui/icons'
import { Button, Modal, Select, Spinner } from '@inlark/ui'
import { aiModelInfo, aiModels, friendlyError, type AiModel, type AiStatus } from '@inlark/core'
import { api } from './api'
import { formatPrices, formatUsage } from './ai-usage'
import { PasswordField, modalActions } from './encryption-ui'

const section = cn(
  'setting-section my-6.25 mx-0 [&_h4]:text-[11px] [&_h4]:font-medium [&_h4]:mt-0 [&_h4]:mb-3 [&_h4]:mx-0',
  '[&_h4]:text-secondary [&+.setting-section]:border-t [&+.setting-section]:border-solid',
  '[&+.setting-section]:border-t-border [&+.setting-section]:pt-5.5',
)
const settingRow = cn(
  'setting-row flex items-center justify-between my-3.5 mx-0 gap-6 [&_strong]:font-normal [&_p]:text-muted',
  '[&_p]:my-[3px] [&_p]:mx-0 [&_input]:shrink-0 [&>.button]:shrink-0 [&_p]:text-[12px] [&_p]:leading-[1.6]',
  '[&_strong]:text-[13px] max-[700px]:gap-3.5',
)

type Notify = (message: string, tone?: 'error' | 'info') => void
type Result = { ok: boolean; text: string }

const consoleUrl = 'https://console.anthropic.com/settings/keys'
const modelOptions = aiModels.map((model) => ({ value: model.id, label: model.label }))

export function AiSettings({ notify }: { notify: Notify }) {
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['ai-status'], queryFn: () => api.aiStatus() })
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<Result>()
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)

  const publish = (status: AiStatus) => queryClient.setQueryData(['ai-status'], status)

  const runTest = async () => {
    setTesting(true)
    setResult(undefined)
    try {
      const test = await api.testAiKey()
      setResult(test.ok ? { ok: true, text: 'The key works.' } : { ok: false, text: test.message })
    } catch (e) {
      setResult({ ok: false, text: friendlyError(e) })
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    const value = key.trim()
    if (!value || saving) return
    setSaving(true)
    setError('')
    setResult(undefined)
    try {
      publish(await api.setAiKey(value))
      setKey('')
    } catch (e) {
      setError(friendlyError(e))
      setSaving(false)
      return
    }
    setSaving(false)
    await runTest()
  }

  const chooseModel = async (model: AiModel) => {
    try {
      publish(await api.setAiModel(model))
      // A test result was for the previous model.
      setResult(undefined)
    } catch (e) {
      notify(friendlyError(e), 'error')
    }
  }

  const remove = async () => {
    setConfirmRemove(false)
    try {
      publish(await api.removeAiKey())
      setResult(undefined)
      notify('API key removed.')
    } catch (e) {
      notify(friendlyError(e), 'error')
    }
  }

  return (
    <>
      <h3 className="m-0 text-[20px] font-[550] tracking-[-0.5px]">AI</h3>
      <p className="settings-lead text-muted mt-1.5 mb-6 mx-0 text-[12px] leading-[1.6]">
        Improve sends only your own text to Anthropic’s Claude: never the quoted email, your
        signature, recipients, subject or attachments. Anthropic doesn’t train on it by default.
        Nothing is sent until you press Improve.
      </p>
      <div className={section}>
        <h4>API key</h4>
        {!data ? (
          <p className="text-muted text-[12px]">
            <Spinner size={14} />
          </p>
        ) : data.hasKey ? (
          <>
            <div className={settingRow}>
              <div>
                <strong className="flex items-center gap-1.5">
                  <Check size={14} /> Key saved · encrypted on this computer
                </strong>
                {testing ? (
                  <p className="flex items-center gap-2">
                    <Spinner size={12} /> Testing…
                  </p>
                ) : (
                  result && (
                    <p role="status" className={cn(!result.ok && 'text-danger')}>
                      {result.text}
                    </p>
                  )
                )}
              </div>
              <div className="flex gap-2">
                <Button onClick={runTest} disabled={testing}>
                  Test
                </Button>
                <Button variant="danger" onClick={() => setConfirmRemove(true)}>
                  Remove key
                </Button>
              </div>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            {!data.secureStorage && (
              <p className="text-muted text-[12px] leading-[1.6] mt-0 mb-3.5">
                Secure storage isn’t available on this computer, so the key can’t be saved.
              </p>
            )}
            <PasswordField
              label="Anthropic API key"
              value={key}
              onChange={setKey}
              error={error}
              disabled={!data.secureStorage || saving}
              placeholder="sk-ant-…"
            />
            <div className="flex items-center gap-2 mt-3.5">
              <Button
                type="submit"
                variant="primary"
                disabled={!data.secureStorage || saving || !key.trim()}
              >
                {saving && <Spinner size={14} />}
                Save key
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void api.openExternal(consoleUrl)}
              >
                <ExternalLink size={14} />
                Get a key from the Anthropic Console
              </Button>
            </div>
            {(testing || result) && (
              <p
                role="status"
                className={cn(
                  'flex items-center gap-2 text-[12px] mt-3.5 mb-0',
                  result?.ok === false ? 'text-danger' : 'text-muted',
                )}
              >
                {testing ? (
                  <>
                    <Spinner size={12} /> Testing…
                  </>
                ) : (
                  result?.text
                )}
              </p>
            )}
          </form>
        )}
      </div>
      <div className={section}>
        <h4>Model</h4>
        <div className={settingRow}>
          <div>
            <strong>{data ? aiModelInfo(data.model).label : '…'}</strong>
            {data && (
              <p>
                {aiModelInfo(data.model).detail} {formatPrices(aiModelInfo(data.model))}.
              </p>
            )}
          </div>
          {data && (
            <Select
              aria-label="Model"
              className="setting-select w-auto min-w-60 shrink-0"
              value={data.model}
              // A test still running belongs to the current model.
              disabled={testing}
              options={modelOptions}
              onValueChange={(model) => void chooseModel(model)}
            />
          )}
        </div>
      </div>
      <div className={section}>
        <h4>This month</h4>
        <div className={settingRow}>
          <div>
            <strong className="flex items-center gap-1.5">
              <Sparkles size={14} />
              {data ? formatUsage(data.improves, data.estimatedCost) : '…'}
            </strong>
            <p>
              Estimated from the list prices of the model each improve used. Your Anthropic Console
              shows the exact bill.
            </p>
          </div>
        </div>
      </div>
      <Modal
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the API key?"
        description="Improve stops working until you add a key again."
        className="w-[min(490px,_calc(100vw_-_40px))]"
      >
        <div className={modalActions}>
          <Button onClick={() => setConfirmRemove(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => void remove()}>
            Remove key
          </Button>
        </div>
      </Modal>
    </>
  )
}
