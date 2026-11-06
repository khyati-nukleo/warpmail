import { useId, useMemo, useState } from 'react'
import { Button, cn } from '@inlark/ui'
import { Download, FileImport, Plus } from '@inlark/ui/icons'
import {
  friendlyError,
  mergeInboxImport,
  ownAddresses,
  type Bootstrap,
  type InboxImport,
  type Settings,
  type SplitTab,
} from '@inlark/core'
import { api } from '../api'
import { saveSplitSettings, splitSaves } from './split-saves'
import {
  alwaysEntry,
  importedText,
  importantStatus,
  neverEntry,
  parseWords,
  putTab,
  setAlways,
  setNever,
  wordsProblem,
} from './tab-model'
import { DeleteTabDialog, TabEditor } from './TabEditor'

// The look of Settings' own sections and rows.
const sectionClass = cn(
  'setting-section my-6.25 mx-0 [&_h4]:text-[11px] [&_h4]:font-medium [&_h4]:mt-0 [&_h4]:mb-3 [&_h4]:mx-0',
  '[&_h4]:text-secondary [&+.setting-section]:border-t [&+.setting-section]:border-solid',
  '[&+.setting-section]:border-t-border [&+.setting-section]:pt-5.5',
)
const rowClass = cn(
  'inbox-setting-row flex items-center justify-between gap-4 py-2.5 border-b border-solid border-b-border',
  'last:border-b-0 min-h-12 [&_strong]:font-normal [&_strong]:text-[13px] [&_strong]:[overflow-wrap:anywhere]',
)
const noteClass = 'text-muted text-[12px] leading-[1.6] my-1 mx-0'
const errorClass = 'text-danger text-[12px] leading-[1.6] mt-1.5 mb-0'
const fieldClass = 'h-8 py-0 px-2.5 text-[12px]'

/** Settings → Inbox: the tabs, Important's Always and Never lists, and export and import. */
export function InboxSettings({
  bootstrap,
  notify,
}: {
  bootstrap: Bootstrap
  notify: (message: string, tone?: 'error' | 'info') => void
}) {
  const { settings } = bootstrap
  const tabs = settings.splitTabs ?? []
  const always = settings.important?.always ?? []
  const never = settings.important?.never ?? []
  const own = useMemo(() => ownAddresses(bootstrap.accounts), [bootstrap.accounts])
  const [editor, setEditor] = useState<{ tab?: SplitTab; open: boolean; seq: number }>()
  const [deleting, setDeleting] = useState<{ tab: SplitTab; open: boolean }>()
  const [busy, setBusy] = useState<'export' | 'import'>()

  /**
   * Saves through the split inbox's queue, on the latest settings rather than this render's, so
   * a change made from the tab row or an email meanwhile is kept, and reloads the tab lists it
   * changes. Resolves to whether it saved.
   */
  const save = async (change: (latest: Settings) => Partial<Settings>) => {
    try {
      await saveSplitSettings(change)
    } catch (error) {
      notify(friendlyError(error), 'error')
      return false
    }
    return true
  }
  const lists = (latest: Settings) => ({
    always: latest.important?.always ?? [],
    never: latest.important?.never ?? [],
  })

  const saveTab = async (tab: SplitTab) => {
    if (await save((latest) => ({ splitTabs: putTab(latest.splitTabs ?? [], tab) })))
      setEditor((shown) => shown && { ...shown, open: false })
  }
  const deleteTab = async (tab: SplitTab) => {
    const saved = await save((latest) => ({
      splitTabs: (latest.splitTabs ?? []).filter((t) => t.id !== tab.id),
    }))
    if (saved) setDeleting((shown) => shown && { ...shown, open: false })
  }

  const exportFile = async () => {
    setBusy('export')
    try {
      // After any save still running, so the file has it; the dialog itself waits outside the
      // queue, so saves from the tab row meanwhile don't wait for it.
      await splitSaves(async () => {})
      if (await api.exportInbox()) notify('Exported your tabs and Important lists')
    } catch (error) {
      notify(friendlyError(error), 'error')
    } finally {
      setBusy(undefined)
    }
  }
  const importFile = async () => {
    setBusy('import')
    try {
      const file = await api.importInbox()
      if (!file) return
      let result: InboxImport | undefined
      const saved = await save((latest) => {
        result = mergeInboxImport(latest, file, own)
        return { splitTabs: result.splitTabs, important: result.important }
      })
      if (saved && result) notify(importedText(result))
    } catch (error) {
      notify(friendlyError(error), 'error')
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <>
      <h3 className="m-0 text-[20px] font-[550] tracking-[-0.5px]">Inbox</h3>
      <p className="settings-lead text-muted mt-1.5 mb-6 mx-0 text-[12px] leading-[1.6]">
        Tabs above the inbox show the conversations with the people you choose. Important shows mail
        from people, leaving out newsletters and notifications.
      </p>

      <section className={sectionClass} aria-labelledby="inbox-settings-tabs">
        <div className="flex items-center justify-between gap-4 mb-1">
          <h4 id="inbox-settings-tabs" className="mb-0!">
            Tabs
          </h4>
          <Button
            size="small"
            onClick={() => setEditor({ open: true, seq: (editor?.seq ?? 0) + 1 })}
          >
            <Plus size={13} />
            New tab
          </Button>
        </div>
        {tabs.length ? (
          <ul className="list-none m-0 p-0">
            {tabs.map((tab) => (
              <li key={tab.id} className={rowClass}>
                <div className="min-w-0">
                  <strong>{tab.name}</strong>
                  <p className={noteClass}>{ruleCount(tab.rules.length)}</p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Button
                    size="small"
                    aria-label={'Edit ' + tab.name}
                    onClick={() => setEditor({ tab, open: true, seq: (editor?.seq ?? 0) + 1 })}
                  >
                    Edit…
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    aria-label={'Delete ' + tab.name}
                    onClick={() => setDeleting({ tab, open: true })}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className={noteClass}>
            No tabs yet. Make one here, with + in the tab row, or with “Add sender to tab…” on an
            email.
          </p>
        )}
      </section>

      <section className={sectionClass} aria-labelledby="inbox-settings-always">
        <h4 id="inbox-settings-always">Always show in Important</h4>
        <p className={cn(noteClass, 'mb-2')}>
          Lets in a sender Important would leave out. With words, only when the subject contains one
          of them.
        </p>
        {always.length ? (
          <ul className="list-none m-0 p-0">
            {always.map((entry) => (
              <AlwaysRow
                // A saved change gives the row a new key, so its field shows what was saved.
                key={entry.address + '\n' + (entry.words ?? []).join(',')}
                address={entry.address}
                words={entry.words ?? []}
                onSave={(words) =>
                  save((latest) => ({
                    important: setAlways(latest.important, entry.address, words),
                  }))
                }
                onRemove={() =>
                  void save((latest) => {
                    const { always, never } = lists(latest)
                    const key = entry.address.toLowerCase()
                    return {
                      important: {
                        always: always.filter((a) => a.address.toLowerCase() !== key),
                        never,
                      },
                    }
                  })
                }
              />
            ))}
          </ul>
        ) : (
          <p className={noteClass}>
            No senders yet. Add one here, or use “Always show in Important…” in an email’s menu.
          </p>
        )}
        <AlwaysField
          important={settings.important}
          onAdd={async (address, words) => {
            let wasNever = false
            const saved = await save((latest) => {
              wasNever = importantStatus(latest.important, address).never
              return { important: setAlways(latest.important, address, words) }
            })
            if (saved && wasNever) notify(address + ' is no longer on Never show')
            return saved
          }}
        />
      </section>

      <section className={sectionClass} aria-labelledby="inbox-settings-never">
        <h4 id="inbox-settings-never">Never show in Important</h4>
        <p className={cn(noteClass, 'mb-2')}>
          Keeps a sender out of Important, such as reports sent from a person’s own address.
        </p>
        {never.length > 0 && (
          <ul className="list-none m-0 p-0">
            {never.map((address) => (
              <li key={address} className={rowClass}>
                <strong className="min-w-0">{address}</strong>
                <Button
                  size="small"
                  variant="ghost"
                  aria-label={'Remove ' + address}
                  onClick={() =>
                    void save((latest) => ({
                      important: setNever(latest.important, address, false),
                    }))
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <NeverField
          important={settings.important}
          onAdd={async (address) => {
            let wasAlways = false
            const saved = await save((latest) => {
              wasAlways = !!importantStatus(latest.important, address).always
              return { important: setNever(latest.important, address, true) }
            })
            if (saved && wasAlways) notify(address + ' is no longer on Always show')
            return saved
          }}
        />
      </section>

      <section className={sectionClass} aria-labelledby="inbox-settings-move">
        <h4 id="inbox-settings-move">Move to another computer</h4>
        <p className={noteClass}>
          Export saves your tabs and Important lists to one small file. Import on the other computer
          adds that file’s tabs and senders to the ones there, and never removes any.
        </p>
        <div className="flex gap-2 mt-3">
          <Button size="small" disabled={!!busy} onClick={() => void exportFile()}>
            <Download size={13} />
            {busy === 'export' ? 'Exporting…' : 'Export…'}
          </Button>
          <Button size="small" disabled={!!busy} onClick={() => void importFile()}>
            <FileImport size={13} />
            {busy === 'import' ? 'Importing…' : 'Import…'}
          </Button>
        </div>
        <p className="setting-footnote text-faint text-[12px] leading-[1.6] mt-3 mb-0">
          The file holds the addresses and domains in your tabs, so keep it private. On import, your
          own addresses, entries that disagree with your lists here, and anything past a limit are
          skipped.
        </p>
      </section>

      <TabEditor
        key={editor ? 'inbox-settings-editor-' + editor.seq : 'inbox-settings-editor'}
        open={!!editor?.open}
        tab={editor?.tab}
        tabs={tabs}
        own={own}
        focus={editor?.tab ? 'rules' : 'name'}
        onSave={saveTab}
        onClose={() => setEditor((shown) => shown && { ...shown, open: false })}
      />
      <DeleteTabDialog
        open={!!deleting?.open}
        tab={deleting?.tab}
        onDelete={deleteTab}
        onClose={() => setDeleting((shown) => shown && { ...shown, open: false })}
      />
    </>
  )
}

function ruleCount(n: number) {
  if (!n) return 'No addresses or domains yet'
  return n.toLocaleString() + (n === 1 ? ' address or domain' : ' addresses and domains')
}

/** An Always sender, with their subject words edited in place. */
function AlwaysRow({
  address,
  words,
  onSave,
  onRemove,
}: {
  address: string
  words: string[]
  onSave: (words: string[]) => Promise<boolean>
  onRemove: () => void
}) {
  const saved = words.join(', ')
  const [text, setText] = useState(saved)
  const [saving, setSaving] = useState(false)
  const problem = wordsProblem(text)
  const ids = useId()
  const commit = async () => {
    const next = parseWords(text)
    if (problem || saving || next.join(', ') === saved) return
    setSaving(true)
    try {
      await onSave(next)
    } finally {
      setSaving(false)
    }
  }
  return (
    <li className={cn(rowClass, 'flex-wrap')}>
      <strong className="min-w-0 flex-[1_1_180px]">{address}</strong>
      <div className="flex items-center gap-1.5 flex-[1_1_260px] min-w-0">
        <input
          className={fieldClass}
          value={text}
          placeholder="Any subject"
          aria-label={'Subject words for ' + address}
          aria-invalid={!!problem}
          aria-describedby={ids + '-hint'}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void commit()
            } else if (event.key === 'Escape' && text !== saved) {
              // Puts the words back rather than closing Settings.
              event.preventDefault()
              event.stopPropagation()
              setText(saved)
            }
          }}
        />
        <Button size="small" variant="ghost" aria-label={'Remove ' + address} onClick={onRemove}>
          Remove
        </Button>
      </div>
      {problem ? (
        // A new element, so the problem is announced as it appears.
        <p key="problem" id={ids + '-hint'} className={cn(errorClass, 'basis-full')} role="alert">
          {problem}
        </p>
      ) : (
        <p key="hint" id={ids + '-hint'} className="sr-only">
          Comma-separated. Leave empty to always show this sender.
        </p>
      )}
    </li>
  )
}

/** Adds a sender to Always show, with optional subject words, checked as they're typed. */
function AlwaysField({
  important,
  onAdd,
}: {
  important: Settings['important']
  onAdd: (address: string, words: string[]) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const [words, setWords] = useState('')
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const entry = alwaysEntry(text, words, important)
  const ids = useId()
  // A half-typed address isn't wrong yet: say so once Add is tried. Words are checked as typed.
  const wordsIssue = wordsProblem(words)
  const addressIssue = tried && entry.problem !== wordsIssue ? entry.problem : undefined
  const problem = addressIssue ?? wordsIssue
  return (
    <form
      className="mt-3"
      onSubmit={async (event) => {
        event.preventDefault()
        setTried(true)
        if (!entry.address || saving) return
        setSaving(true)
        try {
          if (await onAdd(entry.address, entry.words ?? [])) {
            setText('')
            setWords('')
            setTried(false)
          }
        } finally {
          setSaving(false)
        }
      }}
    >
      <div className="flex flex-wrap gap-1.5">
        <input
          className={cn(fieldClass, 'flex-[1_1_180px] min-w-0')}
          value={text}
          placeholder="someone@example.com"
          aria-label="Address to always show in Important"
          aria-invalid={!!addressIssue}
          aria-describedby={problem ? ids + '-problem' : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => {
            setText(event.target.value)
            setTried(false)
          }}
        />
        <input
          className={cn(fieldClass, 'flex-[1_1_180px] min-w-0')}
          value={words}
          placeholder="Any subject"
          aria-label="Subject words, comma-separated (optional)"
          aria-invalid={!!wordsIssue}
          aria-describedby={problem ? ids + '-problem' : undefined}
          spellCheck={false}
          onChange={(event) => setWords(event.target.value)}
        />
        <Button size="small" type="submit" disabled={!text.trim() || saving}>
          Add
        </Button>
      </div>
      {problem && (
        <p id={ids + '-problem'} className={errorClass} role="alert">
          {problem}
        </p>
      )}
    </form>
  )
}

/** Adds an address to Never show, checked as it's typed. */
function NeverField({
  important,
  onAdd,
}: {
  important: Settings['important']
  onAdd: (address: string) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const entry = neverEntry(text, important)
  const ids = useId()
  // A half-typed address isn't wrong yet: say so once Add is tried.
  const problem = tried ? entry.problem : undefined
  return (
    <form
      className="mt-3"
      onSubmit={async (event) => {
        event.preventDefault()
        setTried(true)
        if (!entry.address || saving) return
        setSaving(true)
        try {
          if (await onAdd(entry.address)) {
            setText('')
            setTried(false)
          }
        } finally {
          setSaving(false)
        }
      }}
    >
      <div className="flex gap-1.5">
        <input
          className={fieldClass}
          value={text}
          placeholder="someone@example.com"
          aria-label="Address to never show in Important"
          aria-invalid={!!problem}
          aria-describedby={problem ? ids + '-problem' : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => {
            setText(event.target.value)
            setTried(false)
          }}
        />
        <Button size="small" type="submit" disabled={!text.trim() || saving}>
          Add
        </Button>
      </div>
      {problem && (
        <p id={ids + '-problem'} className={errorClass} role="alert">
          {problem}
        </p>
      )}
    </form>
  )
}
