import { useEffect, useState } from 'react'
import { Switch, cn } from '@inlark/ui'
import { reminderSettingsOf, type ReminderSettings, type Settings } from '@inlark/core'
import { daysFromInput, patchReminders } from './reminder-settings-model'

// The look of Settings' own sections and rows.
const sectionClass = cn(
  'setting-section my-6.25 mx-0 [&_h4]:text-[11px] [&_h4]:font-medium [&_h4]:mt-0 [&_h4]:mb-3 [&_h4]:mx-0',
  '[&_h4]:text-secondary [&+.setting-section]:border-t [&+.setting-section]:border-solid',
  '[&+.setting-section]:border-t-border [&+.setting-section]:pt-5.5',
)
const rowClass = cn(
  'setting-row flex items-center justify-between my-3.5 mx-0 gap-6 [&_strong]:font-normal [&_p]:text-muted',
  '[&_p]:my-[3px] [&_p]:mx-0 [&_p]:text-[12px] [&_p]:leading-[1.6] [&_strong]:text-[13px]',
)
const dayField = 'h-7 w-14 py-0 px-2 mx-1 text-[12px] text-center align-baseline'

function DaysInput({
  value,
  label,
  disabled,
  onCommit,
}: {
  value: number
  label: string
  disabled: boolean
  onCommit: (days: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const days = daysFromInput(text, value)
    setText(String(days))
    if (days !== value) onCommit(days)
  }
  return (
    <input
      className={dayField}
      type="number"
      min={1}
      max={30}
      step={1}
      inputMode="numeric"
      aria-label={label}
      disabled={disabled}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
}

/** Settings → Reminders. `save` stores a settings patch built on the latest saved settings. */
export function RemindersSettings({
  settings,
  save,
}: {
  settings: Settings
  save: (change: (latest: Settings) => Partial<Settings>) => unknown
}) {
  const r = reminderSettingsOf(settings)
  const set = (change: Partial<ReminderSettings>) =>
    void save((latest) => patchReminders(latest, change))
  const off = !r.enabled
  return (
    <div className={sectionClass}>
      <h4>Reminders</h4>
      <div className={rowClass}>
        <div>
          <strong>Reminders</strong>
          <p>Bring conversations back to the top of your inbox when they need you.</p>
        </div>
        <Switch
          aria-label="Reminders"
          checked={r.enabled}
          onCheckedChange={(enabled) => set({ enabled })}
        />
      </div>
      <div className={cn(rowClass, off && 'opacity-60')}>
        <div>
          <strong>Follow-ups</strong>
          <p>
            Remind me after
            <DaysInput
              value={r.followUpDays}
              label="Follow-up days"
              disabled={off || !r.followUp}
              onCommit={(followUpDays) => set({ followUpDays })}
            />
            working days without a reply to an email that asks for something.
          </p>
        </div>
        <Switch
          aria-label="Follow-ups"
          checked={r.followUp}
          disabled={off}
          onCheckedChange={(followUp) => set({ followUp })}
        />
      </div>
      <div className={cn(rowClass, off && 'opacity-60')}>
        <div>
          <strong>Forgot to reply</strong>
          <p>
            Remind me after
            <DaysInput
              value={r.replyDays}
              label="Forgot to reply days"
              disabled={off || !r.forgotToReply}
              onCommit={(replyDays) => set({ replyDays })}
            />
            working day when a person is waiting on my reply.
          </p>
        </div>
        <Switch
          aria-label="Forgot to reply"
          checked={r.forgotToReply}
          disabled={off}
          onCheckedChange={(forgotToReply) => set({ forgotToReply })}
        />
      </div>
      <p className="setting-footnote text-faint text-[12px] leading-[1.6]">
        Dismissals and follow-up switches are saved as Gmail labels under Warpmail, so your other
        computer agrees. Snoozes stay on this computer.
      </p>
    </div>
  )
}
