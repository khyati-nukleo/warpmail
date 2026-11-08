import { cn, Select } from '@inlark/ui'
import {
  undoSendChoices,
  undoSendOnQuit,
  undoSendSeconds,
  type Settings,
  type UndoSendOnQuit,
  type UndoSendSeconds,
} from '@inlark/core'

const delayOptions = undoSendChoices.map((seconds) => ({
  value: String(seconds) as `${UndoSendSeconds}`,
  label: seconds ? seconds + ' seconds' : 'Off',
}))
const quitOptions: { value: UndoSendOnQuit; label: string }[] = [
  { value: 'send', label: 'Send it anyway' },
  { value: 'draft', label: 'Keep it as a draft' },
]
const row = cn(
  'setting-row flex items-center justify-between my-3.5 mx-0 gap-6 [&_strong]:font-normal [&_p]:text-muted',
  '[&_p]:my-[3px] [&_p]:mx-0 [&_input]:shrink-0 [&>.button]:shrink-0 [&_p]:text-[12px] [&_p]:leading-[1.6]',
  '[&_strong]:text-[13px] max-[700px]:gap-3.5',
)

/** Undo send: the "Sending" section of Settings → General. */
export function UndoSendSettings({
  settings,
  update,
}: {
  settings: Settings
  update: (patch: Partial<Settings>) => unknown
}) {
  const seconds = undoSendSeconds(settings)
  return (
    <div
      className={cn(
        'setting-section my-6.25 mx-0 [&_h4]:text-[11px] [&_h4]:font-medium [&_h4]:mt-0 [&_h4]:mb-3 [&_h4]:mx-0',
        '[&_h4]:text-secondary [&+.setting-section]:border-t [&+.setting-section]:border-solid',
        '[&+.setting-section]:border-t-border [&+.setting-section]:pt-5.5',
      )}
    >
      <h4>Sending</h4>
      <div className={row}>
        <div>
          <strong>Undo send</strong>
          <p>How long an email waits after you press Send, so you can take it back.</p>
        </div>
        <Select
          aria-label="Undo send"
          className="setting-select w-auto min-w-60 shrink-0"
          value={String(seconds) as `${UndoSendSeconds}`}
          options={delayOptions}
          onValueChange={(value) =>
            void update({ undoSendSeconds: Number(value) as UndoSendSeconds })
          }
        />
      </div>
      <div className={row}>
        <div>
          <strong>If you close the app during the countdown</strong>
          <p>
            Sending it anyway closes the window at once and quits once the email is sent. When
            inlark keeps running in the tray, closing the window doesn’t stop the countdown.
          </p>
        </div>
        <Select
          aria-label="If you close the app during the countdown"
          className="setting-select w-auto min-w-60 shrink-0"
          value={undoSendOnQuit(settings)}
          options={quitOptions}
          disabled={!seconds}
          onValueChange={(undoSendOnQuit) => void update({ undoSendOnQuit })}
        />
      </div>
    </div>
  )
}
