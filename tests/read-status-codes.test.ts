import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(Buffer.from(value).reverse()),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString(),
  },
}))
import {
  imageCode,
  isTrackedMessageId,
  trackedMessageId,
} from '../apps/desktop/src/main/read-status/codes'
import { ReadStatusSecret } from '../apps/desktop/src/main/read-status/secret'
import { JsonStore } from '../apps/desktop/src/main/storage'

describe('imageCode', () => {
  const id = '1b4e28ba-2fa1-11d2-883f-0016d3cca427.0123456789@example.com'
  it('is a stable 22 character url-safe code', () => {
    const code = imageCode('test-password', id, 'Alex@Example.org')
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(imageCode('test-password', id, 'Alex@Example.org')).toBe(code)
    expect(imageCode('test-password', id, ' alex@example.org')).toBe(code)
  })
  it('differs per recipient, message and password, and leaks nothing', () => {
    const code = imageCode('test-password', id, 'alex@example.org')
    expect(imageCode('test-password', id, 'sam@example.org')).not.toBe(code)
    expect(imageCode('test-password', id + 'x', 'alex@example.org')).not.toBe(code)
    expect(imageCode('other-password', id, 'alex@example.org')).not.toBe(code)
    expect(code).not.toContain('alex')
    expect(code).not.toContain(id.slice(0, 8))
  })
})

describe('tracked message ids', () => {
  it('round-trips with the password only', () => {
    const id = trackedMessageId('test-password', 'example.com')
    expect(id).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{10}@example\.com$/)
    expect(isTrackedMessageId('test-password', id)).toBe(true)
    expect(isTrackedMessageId('other-password', id)).toBe(false)
    expect(
      isTrackedMessageId('test-password', '1b4e28ba-2fa1-11d2-883f-0016d3cca427@example.com'),
    ).toBe(false)
    expect(isTrackedMessageId('test-password', 'garbage')).toBe(false)
    expect(isTrackedMessageId('test-password', '')).toBe(false)
  })
})

describe('ReadStatusSecret', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'read-status-'))
  })
  afterEach(() => rm(directory, { recursive: true, force: true }))
  it('persists encrypted, reloads and clears', async () => {
    const store = new JsonStore(directory)
    await store.init()
    const secret = new ReadStatusSecret(store)
    await secret.load()
    expect(secret.get()).toBeUndefined()
    await secret.set('test-password')
    expect(secret.get()).toBe('test-password')
    for (const file of await readdir(directory))
      expect(await readFile(join(directory, file), 'utf8')).not.toContain('test-password')
    const again = new ReadStatusSecret(store)
    await again.load()
    expect(again.get()).toBe('test-password')
    await again.set(null)
    expect(again.get()).toBeUndefined()
    const third = new ReadStatusSecret(store)
    await third.load()
    expect(third.get()).toBeUndefined()
    await third.set('x')
    await third.set('')
    expect(third.get()).toBeUndefined()
  })
})
