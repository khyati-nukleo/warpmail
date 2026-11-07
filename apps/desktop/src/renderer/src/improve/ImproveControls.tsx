import { cn } from '@inlark/ui'
import { ChevronDown, Sparkles } from '@inlark/ui/icons'
import { Button, Dropdown, MenuItem } from '@inlark/ui'
import { improveStyleLabels, improveStyles } from '@inlark/core'
import { unavailableLines, type Improve } from './useImprove'

/** The composer toolbar's Improve button, with a menu of the other styles. */
export function ImproveControls({ improve, shortcut }: { improve: Improve; shortcut?: string }) {
  const { availability, start } = improve
  const encrypted = !availability.available && availability.reason === 'encrypted'
  return (
    <span className="compose-improve flex items-center">
      <Button
        size="small"
        variant="ghost"
        className="compose-improve-trigger h-7.25 gap-1.5 pl-2.25 pr-1.5 rounded-r-none"
        aria-label="Improve draft"
        // Still focusable and hoverable, so the reason shows; pressing it says the same.
        aria-disabled={encrypted || undefined}
        title={
          encrypted
            ? unavailableLines.encrypted
            : 'Improve draft' + (shortcut ? ' · ' + shortcut : '')
        }
        onClick={() => start('polish')}
      >
        <Sparkles size={14} />
        Improve
      </Button>
      <Dropdown
        className="compose-improve-menu w-48 [&_.menu-item]:py-1.5"
        trigger={
          <Button
            size="small"
            variant="ghost"
            className={cn(
              'compose-improve-styles h-7.25 min-w-0 px-1 rounded-l-none data-popup-open:bg-hover',
              '[&[data-popup-open]_.chevron]:transform-[rotate(180deg)]',
            )}
            aria-label="Choose how to improve"
            title={encrypted ? unavailableLines.encrypted : 'Choose how to improve'}
            disabled={encrypted}
          >
            <ChevronDown
              size={12}
              className="chevron opacity-70 transition-[transform] duration-120"
            />
          </Button>
        }
      >
        {improveStyles.map((style) => (
          <MenuItem key={style} onClick={() => start(style)}>
            {improveStyleLabels[style]}
            {style === 'polish' && (
              <span className="ml-auto text-[11px] text-muted">
                Default{shortcut ? ' · ' + shortcut : ''}
              </span>
            )}
          </MenuItem>
        ))}
      </Dropdown>
    </span>
  )
}

/** One line under the toolbar when Improve was asked for but can't run. */
export function ImproveNotice({
  improve,
  onOpenSettings,
}: {
  improve: Improve
  onOpenSettings: () => void
}) {
  const line = improve.notice && unavailableLines[improve.notice]
  return (
    <div role="status">
      {line && (
        <div className="compose-improve-notice flex items-center gap-2 py-1.75 px-5.5 text-[11px] text-muted border-t border-solid border-t-border">
          <Sparkles size={13} />
          <span>{line}</span>
          {improve.notice === 'noKey' && (
            <Button
              size="small"
              variant="ghost"
              className="px-1 text-primary [&:hover:not(:disabled)]:text-primary underline-offset-2 hover:underline"
              onClick={onOpenSettings}
            >
              Add it in Settings → AI
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
