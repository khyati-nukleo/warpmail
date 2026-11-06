import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'basic_text',
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(), getAllWindows: vi.fn(() => []) },
  shell: {},
  Notification: { isSupported: () => false },
}))
import { BrowserWindow, dialog } from 'electron'
import { MailService, type ProviderFactory } from '../apps/desktop/src/main/service'
import { JsonStore } from '../apps/desktop/src/main/storage'
import { openInProcessIndex } from '../apps/desktop/src/main/imap-index/sqlite-index'
import { ImapProvider } from '../packages/imap/src'
import {
  inboxExport,
  type Account,
  type AppEvent,
  type ConnectInput,
  type MailProvider,
} from '../packages/core/src'
import { FakeImapServer } from './support/fake-imap'

const connect = (connectionId: string, email: string): ConnectInput => ({
  config: {
    protocol: 'imap',
    email,
    incoming: { host: 'imap.example.com', port: 993, security: 'tls', username: 'me' },
    outgoing: { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'me' },
    outgoingSameCredentials: true,
  },
  password: 'disposable',
  name: connectionId,
  remember: true,
  connectionId,
})
const idOf = (connectionId: string) => JSON.stringify([connectionId, 'imap'])
const person = (email: string) => [{ name: 'P', email }]
let directory: string
let servers: Record<string, FakeImapServer>
let service: MailService
let events: AppEvent[]
let indexUpdates: Record<string, ((updating: boolean, ms?: number) => void) | undefined> = {}
const factory: ProviderFactory = (options) => {
  indexUpdates[options.connectionId] = options.onIndexUpdating
  return new ImapProvider({
    connectionId: options.connectionId,
    name: options.name,
    config: options.config as ConnectInput['config'] & { protocol: 'imap' },
    password: options.secrets.password,
    outgoingPassword: options.secrets.outgoingPassword,
    folders: options.folders,
    index: openInProcessIndex(
      options.temporary ? ':memory:' : join(directory, options.connectionId + '.sqlite'),
    ),
    readAttachment: options.readAttachment,
    background: false,
    ports: servers[options.connectionId]!.port,
    smtp: { submit: async () => ({ accepted: [], rejected: [] }), verify: async () => {} },
    inspect: async () => undefined,
    timing: { sentCopyGraceMs: 0, previews: 0 },
  })
}
const sync = async (connectionId: string) => {
  const provider = (service as any).provider(idOf(connectionId)).provider as ImapProvider
  await (provider as any).syncPass('all')
}
const subjects = async (query: Parameters<MailService['query']>[0]) =>
  (await service.query(query)).items.map((c) => c.subject).sort()
const tab = { id: 'client-a', name: 'Client A', rules: ['@client.example'] }

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'warpmail-split-'))
  servers = { a: new FakeImapServer(), b: new FakeImapServer() }
  events = []
  indexUpdates = {}
  service = new MailService(new JsonStore(directory), (e) => events.push(e), {
    providers: factory,
  })
  await service.init()
  const a = servers.a!,
    b = servers.b!
  a.deliver('INBOX', {
    messageId: 'a1@x',
    subject: 'Course plan',
    from: person('lee@client.example'),
    date: '2026-09-20T10:00:00Z',
  })
  a.deliver('INBOX', {
    messageId: 'a2@x',
    subject: 'Course notes',
    from: person('sam@client.example'),
    date: '2026-09-20T11:00:00Z',
    flags: ['\\Seen'],
  })
  a.deliver('INBOX', {
    messageId: 'a3@x',
    subject: 'Lunch',
    from: person('colleague@work.example'),
    date: '2026-09-20T12:00:00Z',
  })
  b.deliver('INBOX', {
    messageId: 'b1@x',
    subject: 'Invoice',
    from: person('billing@client.example'),
    date: '2026-09-21T10:00:00Z',
  })
  b.deliver('INBOX', {
    messageId: 'b2@x',
    subject: 'Hello',
    from: person('friend@example.org'),
    date: '2026-09-21T11:00:00Z',
  })
  await service.connect(connect('a', 'me@work.example'))
  await service.connect(connect('b', 'x@gmail.com'))
  await sync('a')
  await sync('b')
  await service.setSettings({ ...service.settings, splitTabs: [tab] })
})
afterEach(async () => {
  service.dispose()
  vi.restoreAllMocks()
  await new Promise((r) => setTimeout(r, 20))
  await rm(directory, { recursive: true, force: true })
})

describe('split inbox in the service', () => {
  it('a tab query returns only matching inbox conversations', async () => {
    expect(await subjects({ view: 'inbox', tab: 'client-a' })).toEqual([
      'Course notes',
      'Course plan',
      'Invoice',
    ])
    expect(await subjects({ view: 'inbox' })).toHaveLength(5)
  })
  it('an own-domain rule never decides a tab', async () => {
    await service.setSettings({
      ...service.settings,
      splitTabs: [{ id: 'own', name: 'Own', rules: ['@work.example'] }],
    })
    const page = await service.query({ view: 'inbox', tab: 'own' })
    expect(page.items).toEqual([])
    expect(page.total).toBe(0)
  })
  it('an unknown tab id is empty, never all mail', async () => {
    expect(await service.query({ view: 'inbox', tab: 'missing' })).toEqual({
      items: [],
      total: 0,
      failedAccounts: [],
    })
  })
  it('JMAP accounts are skipped in tabs without failing', async () => {
    const jmap: Account = {
      id: 'jmap-account',
      connectionId: 'jmap-connection',
      remoteId: 'r',
      name: 'J',
      email: 'j@example.com',
      color: '#aaa',
      status: 'connected',
      protocol: 'jmap',
    }
    const query = vi.fn(async () => ({
      items: [
        {
          id: 'jt',
          accountId: jmap.id,
          threadId: 'jt',
          subject: 'From JMAP',
          receivedAt: '2026-09-22T10:00:00Z',
          unread: true,
        },
      ],
      total: 1,
    }))
    service.accounts = [...service.accounts, jmap]
    ;(service as any).providers.set('jmap-connection', {
      query,
      dispose() {},
    } as unknown as MailProvider)
    const tabbed = await service.query({ view: 'inbox', tab: 'client-a' })
    expect(tabbed.items.map((c) => c.subject)).not.toContain('From JMAP')
    expect(tabbed.failedAccounts).toEqual([])
    expect(query).not.toHaveBeenCalled()
    expect(await subjects({ view: 'inbox' })).toContain('From JMAP')
  })
  it('tab counts and match counts sum across accounts', async () => {
    // Important counts unread inbox emails in conversations from people: all but the read one.
    await service.setSettings({
      ...service.settings,
      important: { always: [], never: [] },
    })
    expect(await service.tabCounts()).toEqual({ important: 4, 'client-a': 2 })
    expect(await service.tabCounts(idOf('a'))).toEqual({ important: 2, 'client-a': 1 })
    expect(await service.tabMatchCount(['@client.example'])).toBe(3)
    expect(await service.tabMatchCount(['@client.example', 'friend@example.org'])).toBe(4)
    // Own domain and unparseable rules match nothing.
    expect(await service.tabMatchCount(['@work.example', 'nonsense'])).toBe(0)
  })
  it('suggests rules from both accounts’ recent mail, sent and received', async () => {
    const recent = new Date(Date.now() - 86_400_000).toISOString()
    servers.a!.deliver('INBOX', {
      messageId: 'a4@x',
      from: [{ name: 'Lee Park', email: 'lee@client.example' }],
      date: recent,
    })
    servers.a!.deliver('Sent', {
      messageId: 'a5@x',
      from: person('me@work.example'),
      to: [{ name: 'Robin', email: 'robin@clientele.example' }],
      date: recent,
    })
    servers.b!.deliver('INBOX', {
      messageId: 'b3@x',
      from: [{ name: '', email: 'lee@client.example' }],
      date: recent,
    })
    await sync('a')
    await sync('b')
    // Lee's two emails, one per account, put that domain first; older mail isn't counted.
    expect(await service.ruleSuggestions('@cli', [])).toEqual([
      { rule: '@client.example' },
      { rule: '@clientele.example' },
    ])
    expect(await service.ruleSuggestions('lee', [])).toEqual([
      { rule: 'lee@client.example', name: 'Lee Park' },
    ])
    expect(await service.ruleSuggestions('rob', ['robin@clientele.example'])).toEqual([])
    // The own domain is refused as a rule, so it's never offered.
    expect(await service.ruleSuggestions('@work', [])).toEqual([])
    expect(await service.ruleSuggestions('', [])).toEqual([])
  })
  it('marks an account whose index is updating after an upgrade', async () => {
    const updating = () =>
      (
        events.findLast((e) => e.type === 'accounts') as { accounts: Account[] } | undefined
      )?.accounts
        .filter((a) => a.updatingIndex)
        .map((a) => a.connectionId)
    indexUpdates.a!(true)
    expect(updating()).toEqual(['a'])
    expect((await service.bootstrap()).accounts.find((a) => a.updatingIndex)?.connectionId).toBe(
      'a',
    )
    indexUpdates.a!(false, 4321)
    expect(updating()).toEqual([])
  })
  it('counts a tab whatever its id', async () => {
    await service.setSettings({
      ...service.settings,
      splitTabs: [
        { ...tab, id: '__proto__' },
        { ...tab, id: 'constructor', name: 'Client B' },
      ],
    })
    const counts = await service.tabCounts()
    expect(Object.getOwnPropertyDescriptor(counts, '__proto__')?.value).toBe(2)
    expect(Object.getOwnPropertyDescriptor(counts, 'constructor')?.value).toBe(2)
  })
  it("archive all in a tab archives only that tab's conversations", async () => {
    const result = await service.mutateAll({ view: 'inbox', tab: 'client-a' }, 'archive')
    expect(result.failures).toEqual([])
    expect(result.changed).toBeGreaterThan(0)
    expect(servers.a!.box('INBOX').messages.map((m) => m.input.messageId)).toEqual(['a3@x'])
    expect(servers.b!.box('INBOX').messages.map((m) => m.input.messageId)).toEqual(['b2@x'])
    expect(servers.a!.box('Archive').messages).toHaveLength(2)
  })
  it('tabs combine with the filter fields and unknown tabs stay empty', async () => {
    expect(await subjects({ view: 'inbox', tab: 'client-a', from: 'lee@' })).toEqual([
      'Course plan',
    ])
    expect(await subjects({ view: 'inbox', tab: 'client-a', from: 'colleague@' })).toEqual([])
    expect(await subjects({ view: 'inbox', tab: 'important', from: 'friend@' })).toEqual(['Hello'])
    expect(await subjects({ view: 'inbox', tab: 'client-a', unread: true })).toEqual([
      'Course plan',
      'Invoice',
    ])
    expect(await subjects({ view: 'inbox', tab: 'missing', from: 'lee@' })).toEqual([])
  })
  it('the Important tab lists conversations from people', async () => {
    expect(await subjects({ view: 'inbox', tab: 'important' })).toHaveLength(5)
  })
  it('a tab query narrowed to one account only reads that account', async () => {
    expect(await subjects({ view: 'inbox', tab: 'client-a', accountId: idOf('b') })).toEqual([
      'Invoice',
    ])
  })
  it('one account failing leaves the others counted and throws nothing', async () => {
    const counts = ImapProvider.prototype.tabCounts
    vi.spyOn(ImapProvider.prototype, 'tabCounts').mockImplementation(function (
      this: ImapProvider,
      ...args
    ) {
      if ((this as any).accountId === idOf('a')) throw new Error('offline')
      return counts.apply(this, args)
    })
    expect(await service.tabCounts()).toEqual({ important: 2, 'client-a': 1 })
    expect(await service.tabMatchCount(['@client.example'])).toBe(1)
  })
  it('unread counts distinct unseen inbox emails in the tab, not conversations', async () => {
    const a = servers.a!
    a.deliver('INBOX', {
      messageId: 'a4@x',
      subject: 'Course plan',
      from: person('lee@client.example'),
      date: '2026-09-22T10:00:00Z',
      flags: ['\\Seen'],
    })
    a.deliver('INBOX', {
      messageId: 'a5@x',
      inReplyTo: 'a4@x',
      references: ['a4@x'],
      subject: 'Re: Course plan',
      from: person('lee@client.example'),
      date: '2026-09-22T11:00:00Z',
    })
    await sync('a')
    // a1 (unread) plus the unread reply in a thread whose first message is read.
    expect((await service.tabCounts(idOf('a')))['client-a']).toBe(2)
    expect(await service.tabMatchCount(['@client.example'])).toBe(4)
  })
})

describe('moving tabs to another computer', () => {
  const saveTo = (filePath: string | undefined) =>
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: !filePath, filePath })
  const openFrom = (path?: string) =>
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: !path,
      filePaths: path ? [path] : [],
    })

  it('exports a file that import reads back', async () => {
    await service.setSettings({
      ...service.settings,
      important: { always: [{ address: 'alerts@x.example', words: ['crash'] }], never: [] },
    })
    const path = join(directory, 'inbox.json')
    saveTo(path)
    expect(await service.exportInbox()).toBe(true)
    expect(vi.mocked(dialog.showSaveDialog).mock.lastCall?.[0]).toMatchObject({
      defaultPath: 'warpmail-inbox.json',
    })
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    const text = await readFile(path, 'utf8')
    // Only tabs and Important lists: no ids, accounts or other settings.
    expect(text).not.toContain('client-a')
    expect(text).not.toContain('me@work.example')
    expect(text).not.toContain('theme')
    openFrom(path)
    expect(await service.importInbox()).toEqual(inboxExport(service.settings))
  })

  it('does nothing when either dialog is cancelled', async () => {
    saveTo(undefined)
    expect(await service.exportInbox()).toBe(false)
    openFrom(undefined)
    expect(await service.importInbox()).toBeUndefined()
  })

  it('refuses files over 1 MB and files that aren’t exports, without saying where they are', async () => {
    const big = join(directory, 'big.json')
    await writeFile(big, ' '.repeat(1024 * 1024 + 1))
    openFrom(big)
    await expect(service.importInbox()).rejects.toThrow(
      'This file is too large to be a Warpmail inbox export.',
    )
    const bad = join(directory, 'bad.json')
    await writeFile(bad, JSON.stringify({ version: 1, tabs: 'no' }))
    openFrom(bad)
    await expect(service.importInbox()).rejects.toThrow('This file isn’t a Warpmail inbox export.')
    openFrom(join(directory, 'missing.json'))
    const missing = service.importInbox()
    await expect(missing).rejects.toThrow('The file couldn’t be read.')
    await expect(missing).rejects.not.toThrow(directory)
    openFrom(directory)
    await expect(service.importInbox()).rejects.toThrow('The file couldn’t be read.')
  })

  it('reports a file it couldn’t write without its path', async () => {
    saveTo(join(directory, 'no-such-folder', 'inbox.json'))
    const failed = service.exportInbox()
    await expect(failed).rejects.toThrow('The file couldn’t be saved.')
    await expect(failed).rejects.not.toThrow(directory)
  })

  it('opens both dialogs on the focused window, so they are modal', async () => {
    const window = { id: 1 } as unknown as Electron.BrowserWindow
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(window)
    saveTo(undefined)
    await service.exportInbox()
    expect(vi.mocked(dialog.showSaveDialog).mock.lastCall?.[0]).toBe(window)
    openFrom(undefined)
    await service.importInbox()
    expect(vi.mocked(dialog.showOpenDialog).mock.lastCall?.[0]).toBe(window)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null)
  })

  it('replaces an existing file privately and in one step, leaving no temporary file', async () => {
    const folder = join(directory, 'out')
    await mkdir(folder)
    const path = join(folder, 'inbox.json')
    await writeFile(path, 'old', { mode: 0o644 })
    await chmod(path, 0o644)
    saveTo(path)
    expect(await service.exportInbox()).toBe(true)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(inboxExport(service.settings))
    expect(await readdir(folder)).toEqual(['inbox.json'])
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    // A folder it can't write to: the old file stays as it was.
    await writeFile(path, 'old')
    await chmod(folder, 0o500)
    try {
      saveTo(path)
      await expect(service.exportInbox()).rejects.toThrow('The file couldn’t be saved.')
      expect(await readFile(path, 'utf8')).toBe('old')
      expect(await readdir(folder)).toEqual(['inbox.json'])
    } finally {
      await chmod(folder, 0o700)
    }
  })

  it.skipIf(process.platform === 'win32')('refuses a pipe without waiting on it', async () => {
    const fifo = join(directory, 'pipe.json')
    execFileSync('mkfifo', [fifo])
    openFrom(fifo)
    await expect(service.importInbox()).rejects.toThrow('The file couldn’t be read.')
  })
})

describe('settings read from disk', () => {
  it('drops tabs and Important entries that aren’t valid, keeping the rest', async () => {
    const folder = join(directory, 'loaded')
    const store = new JsonStore(folder)
    await store.init()
    const good = { id: 'g', name: 'Good', rules: ['@good.example'] }
    await store.write('settings', {
      ...service.settings,
      theme: 'light',
      splitTabs: [good, { id: 5, name: 'Bad', rules: [] }, { id: 'r', name: 'R', rules: 'no' }],
      important: {
        always: [{ address: 'a@x.example', words: ['w'] }, { address: 7 }],
        never: ['n@x.example', null, 'x'.repeat(400)],
      },
    })
    const loaded = new MailService(store, () => {}, { providers: factory })
    await loaded.init()
    expect(loaded.settings.theme).toBe('light')
    expect(loaded.settings.splitTabs).toEqual([good])
    expect(loaded.settings.important).toEqual({
      always: [{ address: 'a@x.example', words: ['w'] }],
      never: ['n@x.example'],
    })
    await store.write('settings', { ...service.settings, splitTabs: 'x', important: 3 })
    const again = new MailService(store, () => {}, { providers: factory })
    await again.init()
    expect(again.settings.splitTabs).toBeUndefined()
    expect(again.settings.important).toBeUndefined()
    loaded.dispose()
    again.dispose()
  })
})
