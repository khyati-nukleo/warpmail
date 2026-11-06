import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  updater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: true,
    on: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue(null),
  },
  fetch: vi.fn(),
}))
vi.mock('electron', () => ({
  app: mocks.app,
  autoUpdater: { on: vi.fn() },
  net: { fetch: mocks.fetch },
}))
vi.mock('../apps/desktop/node_modules/electron-updater', () => ({
  default: { autoUpdater: mocks.updater },
}))

import { UpdateManager } from '../apps/desktop/src/main/updates'

describe('application updates', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.stubEnv('FLATPAK_ID', '')
    mocks.app.isPackaged = true
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('leaves Flatpak updates to the package manager without querying GitHub', async () => {
    vi.stubEnv('FLATPAK_ID', 'com.inlark.Inlark')
    const publish = vi.fn()
    const manager = new UpdateManager(publish)
    manager.start()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(mocks.updater.on).not.toHaveBeenCalled()
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(manager.getStatus()).toEqual({ phase: 'idle' })
  })

  // Warpmail fork: updates are disabled, so packaged builds never check, download or notify.
  it('never checks, downloads or notifies in packaged Warpmail builds', async () => {
    const publish = vi.fn()
    const manager = new UpdateManager(publish)
    manager.start()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(mocks.updater.on).not.toHaveBeenCalled()
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(mocks.updater.autoDownload).toBe(false)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(manager.getStatus()).toEqual({ phase: 'idle' })
  })

  it('does not check in development builds', async () => {
    mocks.app.isPackaged = false
    new UpdateManager(vi.fn()).start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
  })
})
