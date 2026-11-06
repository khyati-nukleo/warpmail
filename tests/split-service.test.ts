import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'basic_text',
  },
  dialog: {},
  shell: {},
  Notification: { isSupported: () => false },
}))
import { MailService, type ProviderFactory } from '../apps/desktop/src/main/service'
import { JsonStore } from '../apps/desktop/src/main/storage'
import { openInProcessIndex } from '../apps/desktop/src/main/imap-index/sqlite-index'
import { ImapProvider } from '../packages/imap/src'
import type { Account, ConnectInput, MailProvider } from '../packages/core/src'
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
const factory: ProviderFactory = (options) =>
  new ImapProvider({
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
const sync = async (connectionId: string) => {
  const provider = (service as any).provider(idOf(connectionId)).provider as ImapProvider
  await (provider as any).syncPass('all')
}
const subjects = async (query: Parameters<MailService['query']>[0]) =>
  (await service.query(query)).items.map((c) => c.subject).sort()
const tab = { id: 'client-a', name: 'Client B', rules: ['@client.example'] }

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'warpmail-split-'))
  servers = { a: new FakeImapServer(), b: new FakeImapServer() }
  service = new MailService(new JsonStore(directory), () => {}, { providers: factory })
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
  await service.connect(connect('b', 'me@gmail.com'))
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
