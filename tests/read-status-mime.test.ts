import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Account, Draft, ImapConnectionConfig } from '../packages/core/src'
import { ImapProvider } from '../packages/imap/src'
import { parseMime } from '../packages/mime/src'
import { openInProcessIndex } from '../apps/desktop/src/main/imap-index/sqlite-index'
import { FakeImapServer } from './support/fake-imap'

const config: ImapConnectionConfig = {
  protocol: 'imap',
  email: 'me@example.com',
  incoming: { host: 'imap.example.com', port: 993, security: 'tls', username: 'me' },
  outgoing: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'me' },
  outgoingSameCredentials: true,
}
let directory: string
let reads = 0
let provider: ImapProvider
let account: Account

beforeEach(async () => {
  reads = 0
  directory = await mkdtemp(join(tmpdir(), 'inlark-read-status-'))
  provider = new ImapProvider({
    connectionId: 'c1',
    name: 'Work',
    config,
    password: 'disposable',
    index: openInProcessIndex(join(directory, 'index.sqlite')),
    readAttachment: async () => {
      reads++
      return new TextEncoder().encode('attached bytes')
    },
    background: false,
    ports: new FakeImapServer().port,
    timing: { sentCopyGraceMs: 0, initialBatch: 5, historicalBatch: 5, previews: 0 },
  })
  ;[account] = await provider.connect()
})
afterEach(async () => {
  await provider.close()
  await rm(directory, { recursive: true, force: true })
})

const draft = (): Draft => ({
  id: 'd1',
  accountId: account.id,
  identityId: 'default',
  to: [{ name: 'Alex', email: 'alex@example.org' }],
  cc: [{ name: 'Sam', email: 'sam@example.org' }],
  bcc: [{ name: 'Kim', email: 'kim@example.org' }],
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
  attachments: [],
  updatedAt: new Date().toISOString(),
  inReplyTo: ['parent@example.org'],
  references: ['root@example.org', 'parent@example.org'],
  status: 'local',
})
const url = (r: string) => 'https://read.example.com/p/' + r.split('@')[0].padEnd(22, 'x') + '.gif'
const tracking = {
  imageFor: (r: string) => (r === 'kim@example.org' ? undefined : url(r)),
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const headerBlock = (bytes: Uint8Array) =>
  text(bytes)
    .split(/\r?\n\r?\n/)[0]
    .replace(/boundary="?[^";\r\n]+"?/gi, 'boundary=X')

describe('read status copies', () => {
  it('builds one copy per recipient with identical headers', async () => {
    const out = await provider.prepareSubmission(
      account,
      draft(),
      'id1@example.com',
      undefined,
      tracking,
    )
    expect(out.copies?.map((c) => c.recipient)).toEqual([
      'alex@example.org',
      'sam@example.org',
      'kim@example.org',
    ])
    const parsed = await Promise.all(out.copies!.map((c) => parseMime(c.mime)))
    for (const p of parsed) {
      for (const key of [
        'messageId',
        'date',
        'subject',
        'from',
        'to',
        'cc',
        'inReplyTo',
        'references',
      ] as const)
        expect(p[key]).toEqual(parsed[0][key])
      expect(p.bcc).toEqual([])
    }
    const blocks = out.copies!.map((c) => headerBlock(c.mime))
    expect(new Set(blocks).size).toBe(1)
  })
  it('each copy carries only its own image', async () => {
    const out = await provider.prepareSubmission(
      account,
      draft(),
      'id1@example.com',
      undefined,
      tracking,
    )
    const [alex, sam, kim] = await Promise.all(out.copies!.map((c) => parseMime(c.mime)))
    expect(alex.html).toContain(url('alex@example.org'))
    expect(alex.html).not.toContain(url('sam@example.org'))
    expect(sam.html).toContain(url('sam@example.org'))
    expect(kim.html).not.toContain('read.example.com')
  })
  it('the clean copy has no image and keeps Bcc', async () => {
    const out = await provider.prepareSubmission(
      account,
      draft(),
      'id1@example.com',
      undefined,
      tracking,
    )
    const clean = await parseMime(out.mime!)
    expect(clean.bcc.map((a) => a.email)).toEqual(['kim@example.org'])
    expect(clean.html).not.toContain('read.example.com')
    expect(out.envelope.to).toEqual(['alex@example.org', 'sam@example.org', 'kim@example.org'])
  })
  it('without tracking nothing changes', async () => {
    const out = await provider.prepareSubmission(account, draft(), 'id1@example.com')
    expect(out.copies).toBeUndefined()
    expect(text(out.mime!)).not.toMatch(/^Bcc:/im)
  })
  it('reads each attachment once and every copy carries the same bytes', async () => {
    const withFile: Draft = {
      ...draft(),
      attachments: [
        {
          id: 'a1',
          name: 'note.txt',
          type: 'text/plain',
          size: 14,
        } as Draft['attachments'][number],
      ],
    }
    const out = await provider.prepareSubmission(
      account,
      withFile,
      'id1@example.com',
      undefined,
      tracking,
    )
    expect(reads).toBe(1)
    const parsed = await Promise.all(
      [out.mime!, ...out.copies!.map((c) => c.mime)].map((m) => parseMime(m)),
    )
    for (const p of parsed) expect(text(p.attachments[0].content)).toBe('attached bytes')
    expect(parsed).toHaveLength(4)
  })
})
