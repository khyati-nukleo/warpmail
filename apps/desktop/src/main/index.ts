import { openCryptoWorker } from './crypto-open'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  net,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
} from 'electron'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { ipcSchemas, type AppEvent, type Settings } from '@inlark/core'
import { JsonStore } from './storage'
import { MailService } from './service'
import { AiService } from './ai/ai-service'
import { imapProviders } from './imap-accounts'
import { openWorkerIndex } from './imap-index/open'
import { discover } from './discovery-transport'
import { SenderAvatarResolver } from './sender-avatar'
import { UpdateManager } from './updates'
import { configureAppIdentity } from './app-identity'

const here = fileURLToPath(new URL('.', import.meta.url))
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'inlark',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
])
configureAppIdentity(app)
if (process.platform === 'linux' && process.env.FLATPAK_ID)
  app.setDesktopName(process.env.FLATPAK_ID + '.desktop')
let window: BrowserWindow | null = null,
  tray: Tray | null = null,
  quitting = false
let unreadCount = 0,
  rendererReady = false
// Keep the current window's mode while a saved preference waits for the next restart.
let windowUsesSystemTitleBar = false
let restartQueued = false
// Undo send: finishing pending emails out of sight after a quit (see `before-quit`).
let heldQuit: 'waiting' | 'done' | undefined
let reopenAfterQuit = false
const reopenArgs: string[] = []
let service: MailService
const updates = new UpdateManager((status) => send({ type: 'update', status }))
const pendingEvents: AppEvent[] = []
const demo = process.argv.includes('--demo')
const demoAvatars = demo ? new SenderAvatarResolver() : null
const smoke = process.argv.includes('--smoke-test')
if (smoke && !process.env.INLARK_DATA_DIR)
  throw new Error('Smoke tests require a separate INLARK_DATA_DIR.')
const devURL = process.env.ELECTRON_RENDERER_URL
function send(event: AppEvent) {
  if (event.type === 'mailto' && heldQuit === 'waiting') reopenArgs.push(event.url) // Undo send
  if (event.type === 'open' || event.type === 'mailto') show()
  if (window && rendererReady) window.webContents.send('mail:event', event)
  else if (event.type === 'open' || event.type === 'mailto') pendingEvents.push(event)
  if (event.type === 'unread' && tray) {
    unreadCount = event.count
    tray.setImage(trayImage(unreadCount > 0))
    tray.setToolTip('inlark · ' + unreadCount + ' unread messages')
    tray.setTitle(unreadCount ? String(unreadCount) : '')
  }
  if (event.type === 'accounts' && tray) {
    const connected = event.accounts.filter((a) => a.status === 'connected').length
    tray.setToolTip(
      'inlark · ' +
        unreadCount +
        ' unread · ' +
        connected +
        '/' +
        event.accounts.length +
        ' accounts connected',
    )
  }
}
function show() {
  // Undo send: quitting out of sight. Asked to open meanwhile, inlark starts again afterwards.
  if (heldQuit === 'waiting') return void (reopenAfterQuit = true)
  if (!window) createWindow()
  window?.show()
  window?.focus()
}
function trusted(event: Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!window || event.sender !== window.webContents || frame !== window.webContents.mainFrame)
    return false
  try {
    return frame?.origin === (devURL ? new URL(devURL).origin : 'inlark://mail')
  } catch {
    return false
  }
}
// inlark draws its own title bar and keeps the native window controls on it. These match
// --sidebar and --secondary in packages/ui/src/styles.css so the controls blend in.
const titleBarHeight = 36
const titleBarColors = {
  dark: { color: '#111112', symbolColor: '#b7b7bd' },
  light: { color: '#f7f8fa', symbolColor: '#5d6068' },
}
const themeColors = () => titleBarColors[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']
function followTheme() {
  if (!window) return
  const colors = themeColors()
  window.setBackgroundColor(colors.color)
  // macOS styles its traffic lights from the window appearance, which follows themeSource.
  if (!windowUsesSystemTitleBar && process.platform !== 'darwin')
    window.setTitleBarOverlay({ height: titleBarHeight, ...colors })
}
function createWindow() {
  rendererReady = false
  windowUsesSystemTitleBar = service.settings.systemTitleBar === true
  window = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    show: false,
    icon: join(here, '../../resources/icon.png'),
    backgroundColor: themeColors().color,
    title: 'inlark',
    titleBarStyle: windowUsesSystemTitleBar ? 'default' : 'hidden',
    // Also centers the macOS traffic lights in the title bar and reports its size to the page.
    titleBarOverlay: windowUsesSystemTitleBar
      ? false
      : { height: titleBarHeight, ...themeColors() },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  })
  window.on('ready-to-show', () => {
    if (!smoke) window?.show()
  })
  window.on('close', (event) => {
    if (!quitting && service?.settings.closeToTray && tray) {
      event.preventDefault()
      window?.hide()
    }
  })
  window.on('closed', () => {
    window = null
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void service.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  // Vite reloads the page after some edits; keep those reloads in the app window.
  const isDevReload = (event: { url: string; isMainFrame: boolean }) =>
    !!devURL && event.isMainFrame && new URL(event.url).origin === new URL(devURL).origin
  window.webContents.on('will-navigate', (event) => {
    if (!isDevReload(event)) event.preventDefault()
  })
  window.webContents.on('will-frame-navigate', (event) => {
    if (isDevReload(event)) return
    event.preventDefault()
    if (/^https?:|^mailto:/.test(event.url)) void service.openExternal(event.url).catch(() => {})
  })
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.on('did-finish-load', () => {
    if (smoke)
      void window!.webContents
        .executeJavaScript(
          'window.mail.bootstrap().then(value => ({ accounts: value.accounts.length, version: value.version, secureStorage: value.secureStorage }))',
        )
        .then(async (result) => {
          // The IMAP index runs SQLite in a worker thread; prove both start in this build.
          const index = openWorkerIndex(
            join(app.getPath('userData'), 'smoke-index', 'metadata.sqlite'),
          )
          await index.syncMailboxes('smoke', [])
          await index.close()
          console.log(
            'Native IPC smoke test passed:',
            JSON.stringify({ ...result, index: 'sqlite-worker' }),
          )
          quitting = true
          app.exit(0)
        })
        .catch(() => {
          console.error('Native IPC smoke test failed.')
          quitting = true
          app.exit(1)
        })
  })
  if (devURL) void window.loadURL(devURL + (demo ? '?demo=1' : ''))
  else void window.loadURL('inlark://mail/index.html' + (demo ? '?demo=1' : ''))
}
function trayImage(unread = false) {
  return nativeImage.createFromPath(
    join(here, unread ? '../../resources/tray-unread.png' : '../../resources/tray.png'),
  )
}
function mailtoFromArgs(args: string[]) {
  const url = args.find((a) => a.startsWith('mailto:'))
  if (url) send({ type: 'mailto', url })
}
const lock = app.requestSingleInstanceLock()
if (!lock) app.quit()
else {
  app.on('second-instance', (_event, args) => {
    show()
    mailtoFromArgs(args)
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    send({ type: 'mailto', url })
  })
  app
    .whenReady()
    .then(async () => {
      // Rebuild the standard macOS menu with the display name now that credential storage
      // has initialized with its legacy identity.
      if (process.platform === 'darwin')
        Menu.setApplicationMenu(
          Menu.buildFromTemplate([
            { role: 'appMenu' },
            { role: 'fileMenu' },
            { role: 'editMenu' },
            { role: 'viewMenu' },
            { role: 'windowMenu' },
          ]),
        )
      // Remove the in-window menu entirely so Alt cannot reveal it in either title bar mode.
      else Menu.setApplicationMenu(null)
      const rendererRoot = resolve(here, '../renderer')
      protocol.handle('inlark', (request) => {
        const url = new URL(request.url)
        if (url.hostname !== 'mail') return new Response('Not found', { status: 404 })
        let path: string
        try {
          path = resolve(
            rendererRoot,
            '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
          )
        } catch {
          return new Response('Bad request', { status: 400 })
        }
        if (!path.startsWith(rendererRoot + sep)) return new Response('Not found', { status: 404 })
        return net.fetch(pathToFileURL(path).toString())
      })
      service = new MailService(new JsonStore(join(app.getPath('userData'), 'mail')), send, {
        providers: imapProviders,
        crypto: openCryptoWorker,
        discover,
      })
      await service.init()
      // Improve draft
      const ai = new AiService(new JsonStore(join(app.getPath('userData'), 'ai')), send)
      await ai.init()
      // Native surfaces such as the window controls and menus follow inlark's theme setting.
      nativeTheme.themeSource = service.settings.theme
      nativeTheme.on('updated', followTheme)
      const handlers: Record<keyof typeof ipcSchemas, (...args: any[]) => unknown> = {
        ready: () => {
          rendererReady = true
          for (const event of pendingEvents.splice(0)) window?.webContents.send('mail:event', event)
        },
        encryptionStatus: service.encryptionStatus,
        setupEncryption: service.setupEncryption,
        setEncryptionPreference: service.setEncryptionPreference,
        exportEncryptionKey: service.exportEncryptionKey,
        revokeEncryptionKey: service.revokeEncryptionKey,
        postponeEncryptionBackup: service.postponeEncryptionBackup,
        discoverEncryptionKeys: service.discoverEncryptionKeys,
        acceptEncryptionKey: service.acceptEncryptionKey,
        encryptionReadiness: service.encryptionReadiness,
        unlockEncryption: service.unlockEncryption,
        lockEncryption: service.lockEncryption,
        transferEncryption: service.transferEncryption,
        bootstrap: service.bootstrap,
        updateStatus: updates.getStatus,
        discover: service.discover,
        testConnection: service.testConnection,
        connect: service.connect,
        connectionSettings: service.connectionSettings,
        folderMappings: service.folderMappings,
        setFolderMappings: service.setFolderMappings,
        disconnect: service.disconnect,
        reconnect: service.reconnect,
        updateAccount: service.updateAccount,
        updateAccountDetails: service.updateAccountDetails,
        setAliases: service.setAliases,
        mailboxes: service.mailboxes,
        identities: service.identities,
        query: service.query,
        tabCounts: service.tabCounts,
        tabMatchCount: service.tabMatchCount,
        ruleSuggestions: service.ruleSuggestions,
        exportInbox: service.exportInbox,
        importInbox: service.importInbox,
        conversation: service.conversation,
        mutate: service.mutate,
        mutateAll: service.mutateAll,
        undo: service.undo,
        folder: service.folder,
        drafts: service.drafts,
        resumeDraft: service.resumeDraft,
        stageRemoteAttachments: service.stageRemoteAttachments,
        saveDraft: service.saveDraft,
        syncDraft: service.syncDraft,
        deleteDraft: service.deleteDraft,
        deleteServerDraft: service.deleteServerDraft,
        send: service.send,
        reconcile: service.reconcile,
        // Undo send
        sendWithUndo: service.sendWithUndo,
        undoSend: service.undoSend,
        heldSends: service.heldSends,
        submissions: service.submissions,
        retrySentCopy: service.retrySentCopy,
        recoverRejected: service.recoverRejected,
        replaceUncertain: service.replaceUncertain,
        dismissSubmission: service.dismissSubmission,
        stageAttachments: service.stageAttachments,
        attachment: service.attachment,
        inlineImage: service.inlineImage,
        remoteImage: service.remoteImage,
        senderAvatar: demoAvatars
          ? (email: string) => demoAvatars.get(email)
          : service.senderAvatar,
        unsubscribe: service.unsubscribe,
        openExternal: service.openExternal,
        settings: async (settings: Settings) => {
          const saved = await service.setSettings(settings)
          nativeTheme.themeSource = saved.theme
          followTheme()
          return saved
        },
        restart: async () => {
          if (restartQueued) return
          app.relaunch()
          restartQueued = true
          // Reply to the renderer before quitting through the normal cleanup and tray path.
          setImmediate(() => app.quit())
        },
        diagnostics: service.diagnostics,
        // Improve draft
        aiStatus: ai.status,
        setAiKey: ai.setKey,
        removeAiKey: ai.removeKey,
        setAiModel: ai.setModel,
        testAiKey: ai.testKey,
        improveDraft: ai.improve,
        cancelImprove: ai.cancel,
        // Read status
        readStatus: service.readStatus,
        readStatusInfo: service.readStatusInfo,
        setReadStatusPassword: service.setReadStatusPassword,
        testReadStatus: service.testReadStatus,
        // Reminders
        dismissReminder: service.dismissReminder,
        restoreReminder: service.restoreReminder,
      }
      for (const [name, schema] of Object.entries(ipcSchemas))
        ipcMain.handle('mail:' + name, async (event, ...args: unknown[]) => {
          if (!trusted(event)) throw new Error('Untrusted application frame.')
          const parsed = schema.safeParse(args)
          if (!parsed.success) throw new Error('Invalid input. Check the fields and try again.')
          return handlers[name as keyof typeof ipcSchemas](...parsed.data)
        })
      createWindow()
      try {
        tray = new Tray(trayImage())
        tray.setToolTip('inlark')
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: 'Open inlark', click: show },
            { label: 'Check for new mail', click: () => void service.refresh() },
            { type: 'separator' },
            {
              label: 'Quit',
              click: () => {
                quitting = true
                app.quit()
              },
            },
          ]),
        )
        tray.on('click', show)
      } catch {
        tray = null
      }
      powerMonitor.on('resume', () => void service.resume()) // Reminders: was refresh()
      if (!demo && !smoke) updates.start()
      app.on('activate', show)
      mailtoFromArgs(process.argv)
      // The packaged desktop entry lets the user choose inlark as their mailto handler.
    })
    .catch((error) => {
      // Avoid dumping potentially private protocol data into application logs.
      console.error(
        'inlark failed to start:',
        error instanceof Error ? error.message : 'unknown error',
      )
      app.quit()
    })
}
/** How long quitting waits for a message that is still sending. */
const quitSendWaitMs = 30_000
/** Undo send: how long inlark stays running out of sight to finish pending emails. */
const quitHeldWaitMs = 2 * 60_000
let quitWaiting = false
app.on('before-quit', (event) => {
  quitting = true
  // Undo send: a countdown still running follows "If you close the app during the countdown".
  if (heldQuit === 'waiting') return event.preventDefault()
  const held = heldQuit || quitWaiting ? undefined : service?.heldSendsOnQuit()
  if (held) {
    event.preventDefault()
    heldQuit = 'waiting'
    // The window closes straight away; inlark finishes out of sight, then quits.
    if (window && !window.isDestroyed()) window.destroy()
    tray?.destroy()
    tray = null
    let timer: ReturnType<typeof setTimeout> | undefined
    void Promise.race([
      held.then(() => service.sendsSettled()),
      new Promise((resolve) => (timer = setTimeout(resolve, quitHeldWaitMs))),
    ]).then(() => {
      clearTimeout(timer)
      heldQuit = 'done'
      quitWaiting = true
      if (reopenAfterQuit && !restartQueued)
        app.relaunch({ args: [...process.argv.slice(1), ...reopenArgs] })
      app.quit()
    })
    return
  }
  const sends = quitWaiting ? undefined : service?.sendsSettled()
  if (sends) {
    // The composer closes on Send, so a quit often comes right after it. Let the message
    // finish (never for long); a second quit request goes straight through.
    event.preventDefault()
    quitWaiting = true
    const options = {
      type: 'info' as const,
      title: 'inlark',
      message: 'Finishing sending…',
      detail: 'inlark will quit as soon as your message has been sent.',
      buttons: ['Quit now'],
    }
    // Only say so if it takes a moment; a quick finish quits without a flash of dialog.
    const notice = setTimeout(() => {
      const parent = window && !window.isDestroyed() && window.isVisible() ? window : undefined
      void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).then(
        () => app.quit(),
      )
    }, 500)
    let timer: ReturnType<typeof setTimeout> | undefined
    void Promise.race([
      sends,
      new Promise((resolve) => (timer = setTimeout(resolve, quitSendWaitMs))),
    ]).then(() => {
      clearTimeout(timer)
      clearTimeout(notice)
      app.quit()
    })
    return
  }
  // An open “Finishing sending…” box must never keep the app from exiting.
  if (quitWaiting) setTimeout(() => app.exit(0), 5000).unref()
  service?.dispose()
})
app.on('window-all-closed', () => {
  if (!tray || !service?.settings.closeToTray) app.quit()
})
