import { EncryptionService, type CryptoTransport } from './encryption'
import { securityKind, maxMessageBytes } from '@inlark/crypto'
import { randomUUID, X509Certificate, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile, rm, stat, chmod, open } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { app, clipboard, dialog, shell, Notification } from 'electron'
import { selectAuthCandidate, type AuthCandidate } from './auth-detection'
import {
  defaultSettings,
  mergePages,
  nextAccountColor,
  sendDraftSchema,
  friendlyError,
  draftFingerprint,
  connectionErrorCodes,
  isProviderError,
  ProviderError,
  type Account,
  type AccountAppearance,
  type Address,
  type Alias,
  type AliasInput,
  type Settings,
  type InboxExport,
  type ConnectInput,
  type ConnectionCheck,
  type ConnectionConfig,
  type ConnectionSettings,
  type ConnectionTest,
  type AccountDetails,
  type MailQuery,
  type QueryPage,
  type MailAction,
  type MutationInput,
  type MutationResult,
  type MutationTarget, // Reminders
  type ReminderTarget, // Reminders
  type Draft,
  type DraftErrorKind,
  type Attachment,
  type StagedAttachment,
  type AppEvent,
  type MailProvider,
  type FolderMappings,
  type DiscoveryResult,
  type OutgoingMessage,
  type SendResult,
  type ServerSettings,
  type SubmissionSummary,
  type Message,
  type AddressSeen,
  type RuleSuggestion,
  suggestionTerm,
  // Read status
  isAutomatedAddress,
  ownAddresses,
  isWorkerImage,
  pixelUrl,
  rememberWorkerUrl,
  stripPixels,
  trackingBlock,
  workerBase,
  workerHosts,
  type ReadStatusInfo,
  type ReadStatusLookup,
  type ReadStatusRequest,
  type CopyOutcome,
  type SubmissionOutcome,
  type SubmissionTracking,
  tabApplies, // Reminders
} from '@inlark/core'
import { JmapProvider } from '@inlark/jmap'
import { publicFetch } from './public-fetch'
import { remoteImageData } from './remote-image'
import { SenderAvatarResolver, rasterType } from './sender-avatar'
import { planMutation, safeUndoUpdates, undoForUpdated, type UndoEntry } from './mail-mutations'
import {
  countScopes,
  checkedSplitSettings,
  exportInboxFile,
  importInboxFile,
  isImap,
  ruleSuggestionsFrom,
  rulesScope,
  sumMatches,
  sumUnread,
  tabPlan,
  type TabCounts,
} from './split-inbox'
import { JsonStore, encryptSecret, decryptSecret, secureStorageAvailable } from './storage'
import { imageCode, isTrackedMessageId, trackedMessageId } from './read-status/codes'
import { ReadStatusSecret } from './read-status/secret'
import { ReadStatusCollector } from './read-status/collector'
import { testWorker } from './read-status/worker-client'
import { recoverCopies, settleCopies, type JournalCopy } from './read-status/tracked-send'
import { ReminderEngine } from './reminders/engine' // Reminders

export type Connection = {
  id: string
  name: string
  config: ConnectionConfig
  secret?: string
  localSecret?: string
  /** Only present when the outgoing server has its own password. */
  outgoingSecret?: string
  outgoingLocalSecret?: string
  folders?: FolderMappings
  accounts: Account[]
}
/** The version 1 record, from before IMAP support. Every such connection was JMAP. */
type LegacyConnection = {
  id: string
  serverUrl: string
  username: string
  name: string
  secret?: string
  localSecret?: string
  accounts: Account[]
}
export function migrateConnections(data: unknown, version: number): Connection[] {
  if (version !== 1 || !Array.isArray(data)) throw new Error('Unsupported connections data.')
  return (data as LegacyConnection[]).map((legacy) => {
    if (
      typeof legacy?.id !== 'string' ||
      typeof legacy.serverUrl !== 'string' ||
      typeof legacy.username !== 'string' ||
      !Array.isArray(legacy.accounts)
    )
      throw new Error('Malformed connection record.')
    const { serverUrl, username, ...rest } = legacy
    return {
      ...rest,
      config: { protocol: 'jmap', serverUrl, username },
      accounts: legacy.accounts.map((a) => ({ ...a, protocol: 'jmap' as const })),
    }
  })
}
export const CONNECTIONS_VERSION = 2

type Secrets = { password: string; outgoingPassword?: string }
type Journal = {
  draftId: string
  accountId: string
  /** JMAP: the server email being submitted. */
  emailId?: string
  /** The Message-ID of this attempt, without angle brackets. */
  messageId?: string
  envelope?: OutgoingMessage['envelope']
  /** The prepared MIME is stored beside the journal until its Sent copy is filed. */
  mime?: boolean
  subject?: string
  state: 'preparing' | 'submitting' | 'sent' | 'partial' | 'uncertain' | 'rejected'
  accepted?: string[]
  rejected?: { email: string; reason: string }[]
  /**
   * Only for providers that file their own Sent copy. `appending` is written before APPEND, so
   * a crash in between is recovered as `uncertain` and reconciled by Message-ID before retrying.
   */
  sentCopy?: 'pending' | 'appending' | 'uncertain' | 'failed' | 'filed' | 'server' | 'dismissed'
  sentCopyError?: string
  /** Why a `rejected` attempt was not sent, shown on its draft until the draft is edited. */
  error?: string
  errorKind?: DraftErrorKind
  /** The server draft this message replaced, kept until it has been removed. */
  previousDraft?: Pick<Draft, 'serverId' | 'serverFingerprint' | 'encryption'>
  /** The user has seen and resolved this attempt. */
  dismissed?: boolean
  at: string
  // Read status: sent one copy per recipient; each copy's state is durable before it is sent.
  tracked?: boolean
  copies?: JournalCopy[]
  /** Recipients whose copy may have arrived: never offered for recovery. */
  unconfirmed?: string[]
  /** Gmail's copies may be in Trash and the clean one not yet confirmed in Sent: it must be filed. */
  cleanOwed?: boolean
  /** The clean copy's UID in Sent, once confirmed there. */
  cleanUid?: number
  /** When to look once more for a merged copy Gmail filed after the clean one. */
  sweepAt?: string
  /** Filing attempts in a row that failed for good, and when the next one may run. */
  sentCopyFailures?: number
  sentCopyRetryAt?: string
}
/** Drafts are saved to the server only after this long without an edit; local saves are instant. */
const draftIdleMs = 10_000
const interruptedSend = 'Sending was interrupted before the message left. Review it and send again.'
const closedWhileSending = 'The app closed during sending. Check delivery before retrying.'
/** How long send waits for a draft save already in progress before asking to retry. */
const draftSaveWaitMs = 60_000
/** Read status: how long the periodic retry keeps looking for an unconfirmed send's server copy. */
const unconfirmedLookMs = 60 * 60_000
/** Read status: Gmail may file its merged copy late; looked for once this long after filing. */
const sweepDelayMs = 60_000
/** Read status: waits after each failed filing of a tracked Sent copy; then once per start. */
const sentCopyRetryMs = [1, 5, 15, 60].map((minutes) => minutes * 60_000)
const imageCopyKept =
  "Gmail's Sent copy still has the read status image, so opening it in Gmail may count as an open. It will be retried."
/** Settles when `promise` does or after `ms`, whichever comes first. Never rejects. */
const settledWithin = (promise: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.then(
      () => {},
      () => {},
    ),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))),
  ]).finally(() => clearTimeout(timer))
}
/** Errors that prove nothing left for recipients during submission. */
const definiteSubmissionCodes = [
  'submissionRejected',
  'authentication',
  'outgoingAuthentication',
  'outgoingNetwork',
  'outgoingCertificate',
  'tls',
  'certificate',
  'capability',
  'mailboxes',
  'submission',
  'unsupported',
  'identity',
]
/** Creates the provider for a non-JMAP connection. Replaced in tests. */
export type ProviderFactory = (input: {
  connectionId: string
  config: ConnectionConfig
  secrets: Secrets
  name: string
  folders?: FolderMappings
  /** A test connection must leave nothing behind on disk. */
  temporary?: boolean
  /** Where this connection may keep local data, removed when it is disconnected. */
  directory: string
  readAttachment: (id: string) => Promise<Uint8Array>
  /** The connection's local index is being updated after an upgrade (see `updatingIndex`). */
  onIndexUpdating?: (updating: boolean, ms?: number) => void
}) => MailProvider
export interface ServiceOptions {
  providers?: ProviderFactory
  discover?: (email: string) => Promise<DiscoveryResult>
  crypto?: () => CryptoTransport
  /** Read status: replaces `fetch` when asking the Worker. */
  readStatusFetch?: typeof fetch
}
/** Fingerprints shown to the user are computed here from the certificate itself, never taken on trust. */
function verifiedCertificates(config: ConnectionConfig): ConnectionConfig {
  if (config.protocol !== 'imap') return config
  const verified = (server: ServerSettings): ServerSettings => {
    if (!server.certificate) return server
    try {
      const sha256 = new X509Certificate(server.certificate.pem).fingerprint256
      return { ...server, certificate: { sha256, pem: server.certificate.pem } }
    } catch {
      throw new Error(
        `The trusted certificate for ${server.host} can't be read. Remove it and check the connection again.`,
      )
    }
  }
  return { ...config, incoming: verified(config.incoming), outgoing: verified(config.outgoing) }
}
const errorKind = (error: unknown): DraftErrorKind | undefined =>
  error instanceof ProviderError
    ? error.code === 'outgoingAuthentication'
      ? 'outgoingAuthentication'
      : error.code === 'certificate' || error.code === 'outgoingCertificate'
        ? 'certificate'
        : error.code === 'submissionRejected'
          ? 'rejected'
          : error.code === 'conflict'
            ? 'conflict'
            : connectionErrorCodes.includes(error.code) || error.code === 'outgoingNetwork'
              ? 'connection'
              : undefined
    : error instanceof Error && error.message.includes('another client')
      ? 'conflict'
      : undefined

export class MailService {
  settings: Settings = defaultSettings
  accounts: Account[] = []
  private connections: Connection[] = []
  private providers = new Map<string, MailProvider>()
  private sessionSecrets = new Map<string, Secrets>()
  private localDrafts = new Map<string, Draft>()
  private journals = new Map<string, Journal>()
  private staging = new Map<string, StagedAttachment>()
  private undos = new Map<string, UndoEntry[]>()
  private writes = new Map<string, Promise<unknown>>()
  private busyDrafts = new Set<string>()
  /** Server draft saves in flight, so send can wait for one instead of refusing. */
  private draftSyncs = new Map<string, Promise<Draft>>()
  private refreshing = new Set<string>()
  private filing = new Set<string>()
  /** Read status: unconfirmed tracked sends looked for once after this start, however old. */
  private lookOnStart = new Set<string>()
  /** Accepted sends still filing their Sent copy and tidying up drafts in the background. */
  private finishing = new Map<string, Promise<void>>()
  /** Drafts a send has claimed, from the moment it is called. */
  private sending = new Set<string>()
  /** Settles as each send call returns, so a quit can wait for them. */
  private sendRuns = new Set<Promise<void>>()
  private unreadCounts = new Map<string, number>()
  private notificationBaseline = new Map<string, string>()
  private authArrivals = new Map<string, { since: number; seen: Map<string, number> }>()
  private authCopyQueue: Promise<unknown> = Promise.resolve()
  private latestAuthCopy = 0
  private disposed = false
  private indexingEmit?: ReturnType<typeof setTimeout>
  private timer?: ReturnType<typeof setInterval>
  private logs: { at: string; event: string; state?: string }[] = []
  private senderAvatars = new SenderAvatarResolver()
  readonly encryption: EncryptionService
  readonly readStatusSecret: ReadStatusSecret
  private readonly collector: ReadStatusCollector
  private protectedLoaded = new Set<string>()
  private protectionTransition = false
  private draftWrites: Promise<unknown> = Promise.resolve()
  // Reminders
  private reminders: ReminderEngine
  constructor(
    private store: JsonStore,
    private emit: (event: AppEvent) => void,
    private options: ServiceOptions = {},
  ) {
    this.readStatusSecret = new ReadStatusSecret(store)
    this.collector = new ReadStatusCollector(
      store,
      () => {
        const settings = this.settings.readStatus
        const base = settings?.enabled === false ? undefined : workerBase(settings?.workerUrl)
        return { base, password: this.readStatusSecret.get() }
      },
      () => this.emit({ type: 'readStatus' }),
      { fetch: options.readStatusFetch },
    )
    // Reminders
    this.reminders = new ReminderEngine({
      accounts: () => this.accounts,
      settings: () => this.settings,
      provider: (accountId) => {
        const account = this.accounts.find((a) => a.id === accountId)
        return account && this.providers.get(account.connectionId)
      },
      returnToInbox: (targets) => this.returnToInbox(targets),
      emit: (event) => this.emit(event),
      store: this.store,
      log: (event) => this.log(event),
    })
    this.encryption = new EncryptionService(store, options.crypto, (accountId, email) =>
      this.guard(
        accountId,
        (provider, account) => provider.encryptionHints?.(account, email) || Promise.resolve([]),
      ),
    )
  }
  private log(event: string, state?: string) {
    this.logs.push({ at: new Date().toISOString(), event, state })
    this.logs = this.logs.slice(-200)
  }
  async init() {
    await this.store.init()
    await this.encryption.init()
    this.settings = checkedSplitSettings({
      ...defaultSettings,
      ...(await this.store.read('settings', defaultSettings)),
    })
    this.connections = await this.store.read<Connection[]>('connections', [], {
      version: CONNECTIONS_VERSION,
      migrate: migrateConnections,
    })
    this.accounts = this.connections.flatMap((c) =>
      c.accounts.map((a) => ({
        ...a,
        protocol: c.config.protocol,
        status: 'connecting' as const,
      })),
    )
    // Read status: without the password nothing is tracked; sending itself is unaffected.
    await this.readStatusSecret.load().catch(() => this.log('read-status-secret-unavailable'))
    this.localDrafts = new Map((await this.store.read<Draft[]>('drafts', [])).map((d) => [d.id, d]))
    this.journals = new Map(
      (await this.store.read<Journal[]>('submissions', [])).map((j) => [j.draftId, j]),
    )
    this.staging = new Map(
      (await this.store.read<StagedAttachment[]>('staging', [])).map((a) => [a.id, a]),
    )
    for (const journal of this.journals.values()) {
      const draft = this.localDrafts.get(journal.draftId)
      if (journal.state === 'sent' && draft && (draft.status !== 'sent' || this.hasContent(draft)))
        await this.completeDraft(draft)
      if (journal.state === 'preparing') {
        // Submission only starts after `submitting` is durable, so nothing left the device.
        // Kept as a refused attempt, so the draft goes on saying why it was not sent.
        Object.assign(journal, {
          state: 'rejected',
          error: interruptedSend,
          errorKind: 'connection',
        })
        journal.mime = undefined
        await this.removeMime(journal.draftId)
        if (draft) this.localDrafts.set(draft.id, { ...draft, status: 'local' })
      }
      const current = this.localDrafts.get(journal.draftId)
      const note = current && this.notSentNote(current)
      if (note && current.error !== note.error)
        this.localDrafts.set(current.id, {
          ...current,
          error: note.error,
          errorKind: note.errorKind,
        })
      if (journal.state === 'submitting' && journal.copies)
        await this.recoverTracked(journal, draft)
      else if (journal.state === 'submitting') {
        journal.state = 'uncertain'
        if (draft)
          this.localDrafts.set(draft.id, {
            ...draft,
            status: 'uncertain',
            error: closedWhileSending,
          })
      }
      if (journal.sentCopy === 'appending') journal.sentCopy = 'uncertain'
      // Read status
      if (journal.tracked && (journal.state === 'uncertain' || journal.sentCopyFailures))
        this.lookOnStart.add(journal.draftId)
    }
    await this.persistDrafts()
    await this.persistJournal()
    void Promise.allSettled(this.connections.map((c) => this.reconnect(c.id)))
    this.reminders.start() // Reminders: catch up; accounts that connect later invalidate
    this.timer = setInterval(() => void this.refresh(), 60_000)
    this.collector.start() // Read status
  }
  /** Read status: a tracked send the app closed during settles from its copies, never resent. */
  private async recoverTracked(journal: Journal, draft?: Draft) {
    journal.copies = recoverCopies(journal.copies!)
    const { state, ...settled } = settleCopies(journal.copies)
    Object.assign(journal, settled, { state })
    if (state === 'rejected') {
      // Nothing arrived: like a refused send, the draft keeps its content and says why.
      const error = settled.rejected[0]?.reason || interruptedSend
      Object.assign(journal, { error, errorKind: 'rejected', at: new Date().toISOString() })
      journal.sentCopy = journal.previousDraft = journal.mime = undefined
      await this.removeMime(journal.draftId)
      if (draft)
        this.localDrafts.set(draft.id, { ...draft, status: 'error', error, errorKind: 'rejected' })
    } else if (!draft) return
    else if (state === 'sent') await this.completeDraft(draft)
    else if (state === 'partial') this.localDrafts.set(draft.id, { ...draft, status: 'sent' })
    else
      this.localDrafts.set(draft.id, {
        ...draft,
        status: 'uncertain',
        error: closedWhileSending,
      })
  }
  encryptionStatus = () => this.encryption.status()
  private async sendingIdentity(accountId: string, identityId: string) {
    const identity = (await this.identities(accountId)).find((i) => i.id === identityId)
    if (!identity) throw new Error('Choose a valid sending identity.')
    return identity
  }
  setupEncryption = async (input: {
    accountId: string
    identityId: string
    action: 'create' | 'import' | 'replace' | 'historical'
    importReplacement?: boolean
    password?: string
    keyPassword?: string
  }) =>
    this.encryption.setup(
      await this.sendingIdentity(input.accountId, input.identityId),
      input.action,
      input.password,
      input.keyPassword,
      input.importReplacement,
    )
  setEncryptionPreference = (
    accountId: string,
    identityId: string,
    enabled: boolean,
    prefer: boolean,
  ) => this.encryption.preference(accountId, identityId, enabled, prefer)
  exportEncryptionKey = (fingerprint: string, kind: 'public' | 'backup', password?: string) =>
    this.encryption.exportKey(fingerprint, kind, password)
  revokeEncryptionKey = (fingerprint: string) => this.encryption.revoke(fingerprint)
  postponeEncryptionBackup = (fingerprint: string) => this.encryption.postpone(fingerprint)
  discoverEncryptionKeys = (email: string, refresh?: boolean) =>
    this.encryption.discover(email, refresh)
  acceptEncryptionKey = (email: string, fingerprint: string, confirmed: boolean) =>
    this.encryption.accept(email, fingerprint, confirmed)
  encryptionReadiness = (accountId: string, identityId: string, recipients: string[]) =>
    this.encryption.readiness(accountId, identityId, recipients)
  unlockEncryption = async (password?: string) => {
    const status = await this.encryption.unlock(password)
    for (const id of this.encryption.vault.ids('attachment-meta:')) {
      const attachment = this.encryption.vault.json<StagedAttachment>(id)!
      if (this.staging.get(attachment.id)?.blobId?.startsWith('vault:'))
        this.staging.set(attachment.id, attachment)
    }
    for (const id of this.encryption.vault.ids('draft:')) {
      const draft = this.encryption.vault.json<Draft>(id)!
      // Submission reconciliation is authoritative after a crash.
      const stub = this.localDrafts.get(draft.id)
      const journal = this.journals.get(draft.id)
      if (
        stub &&
        stub.encryption !== 'encrypt' &&
        (stub.status === 'sent' || stub.updatedAt >= draft.updatedAt)
      )
        continue
      if (
        stub?.status === 'sent' &&
        (stub.encryption !== 'encrypt' || journal?.state === 'sent' || journal?.dismissed)
      )
        continue
      this.localDrafts.set(draft.id, { ...draft, ...(stub ? { status: stub.status } : {}) })
      this.protectedLoaded.add(draft.id)
    }
    this.emit({ type: 'encryption', locked: false })
    return status
  }
  lockEncryption = async () => {
    if (this.protectionTransition) throw new Error('The vault is already locking.')
    this.protectionTransition = true
    try {
      await this.draftWrites
      // Sent messages still filing their copy finish first; that never takes user input.
      await Promise.all(this.finishing.values())
      if (this.busyDrafts.size)
        throw new Error('Wait for drafts and sends to finish before locking.')
      await this.persistDrafts()
      await this.encryption.lock()
      this.localDrafts = new Map(
        (await this.store.read<Draft[]>('drafts', [])).map((d) => [d.id, d]),
      )
      this.staging = new Map(
        (await this.store.read<StagedAttachment[]>('staging', [])).map((a) => [a.id, a]),
      )
      this.protectedLoaded.clear()
      this.emit({ type: 'encryption', locked: true })
    } finally {
      this.protectionTransition = false
    }
  }
  transferEncryption = async (input: {
    accountId: string
    identityId: string
    action: 'export' | 'import'
    code?: string
    password?: string
  }) =>
    this.encryption.transfer(
      await this.sendingIdentity(input.accountId, input.identityId),
      input.action,
      input.code,
      input.password,
    )
  private async protectedMime(draft: Draft, messageId: string, serverDraft = false) {
    const { provider } = this.provider(draft.accountId)
    if (!provider.rawMessage) throw new Error('This provider cannot safely support encrypted mail.')
    const identity = await this.sendingIdentity(draft.accountId, draft.identityId)
    const attachments = await Promise.all(
      draft.attachments.map(async (a) => ({
        ...a,
        content: await this.readStagedAttachment(a.id),
      })),
    )
    return this.encryption.compose(draft, identity, messageId, attachments, serverDraft)
  }
  bootstrap = async () => ({
    accounts: this.accounts,
    settings: this.settings,
    secureStorage: secureStorageAvailable(),
    demo: false,
    version: app.getVersion(),
  })
  private hasContent(draft: Draft) {
    return !!(draft.text || draft.html || draft.attachments.length)
  }
  private saveConnections() {
    return this.store.write('connections', this.connections, CONNECTIONS_VERSION)
  }
  private async persistDrafts() {
    const records: [string, Uint8Array | undefined][] = []
    const saved = [...this.localDrafts.values()].map((draft) => {
      if (draft.encryption !== 'encrypt') return draft
      if (this.encryption.vault.unlocked && this.protectedLoaded.has(draft.id))
        records.push(['draft:' + draft.id, Buffer.from(JSON.stringify(draft))])
      return {
        ...draft,
        html: '',
        text: '',
        attachments: [],
        serverFingerprint: draft.serverFingerprint?.match(/^[a-f0-9]{64}$/)?.[0],
        error: 'Unlock the encryption vault to resume this draft.',
      }
    })
    if (records.length) await this.encryption.vault.putMany(records)
    await this.store.write('drafts', saved)
  }
  private async persistJournal() {
    await this.store.write('submissions', [...this.journals.values()])
    this.emit({ type: 'submissions', submissions: this.summaries() })
  }
  private account(id: string): Account {
    const a = this.accounts.find((a) => a.id === id)
    if (!a) throw new Error('Account not found.')
    return a
  }
  private provider(accountId: string) {
    const account = this.account(accountId),
      provider = this.providers.get(account.connectionId)
    if (!provider) throw new Error('This account is disconnected. Reconnect it in Settings.')
    return { account, provider }
  }
  private patchAccounts(connectionId: string, patch: Partial<Account>) {
    this.accounts = this.accounts.map((a) =>
      a.connectionId === connectionId ? { ...a, ...patch } : a,
    )
    this.emit({ type: 'accounts', accounts: this.accounts })
  }
  private status(connectionId: string, state: Account['status'], error?: string) {
    this.patchAccounts(connectionId, { status: state, error })
  }
  /** Outgoing problems are tracked apart from incoming ones: reading can still work. */
  private outgoing(connectionId: string, error?: string) {
    const current = this.accounts.find((a) => a.connectionId === connectionId)
    if (current && current.outgoingError !== error)
      this.patchAccounts(connectionId, { outgoingError: error })
  }
  private async guard<T>(
    accountId: string,
    fn: (provider: MailProvider, account: Account) => Promise<T>,
  ): Promise<T> {
    const { provider, account } = this.provider(accountId)
    try {
      const result = await fn(provider, account)
      if (account.status !== 'connected') this.status(account.connectionId, 'connected')
      return result
    } catch (error) {
      if (error instanceof ProviderError && connectionErrorCodes.includes(error.code))
        this.status(
          account.connectionId,
          error.code === 'authentication' ? 'authentication' : 'offline',
          friendlyError(error),
        )
      // Neither resolves by retrying, so sending stays marked unavailable until the user acts.
      if (isProviderError(error, 'outgoingAuthentication', 'outgoingCertificate'))
        this.outgoing(account.connectionId, friendlyError(error))
      this.log('request-failed', error instanceof ProviderError ? error.code : 'local')
      throw error
    }
  }
  private createProvider(
    id: string,
    input: Pick<ConnectInput, 'config' | 'name' | 'password' | 'outgoingPassword' | 'folders'>,
    temporary = false,
  ): MailProvider {
    const config = input.config
    if (config.protocol === 'jmap')
      return new JmapProvider({
        serverUrl: config.serverUrl,
        authorization:
          'Basic ' + Buffer.from(config.username + ':' + input.password).toString('base64'),
        connectionId: id,
        name: input.name,
      })
    if (!this.options.providers) throw new Error('IMAP accounts are not available in this build.')
    return this.options.providers({
      connectionId: id,
      config,
      name: input.name,
      folders: input.folders,
      secrets: { password: input.password, outgoingPassword: input.outgoingPassword },
      temporary,
      directory: join(this.store.directory, 'index', id),
      readAttachment: this.readStagedAttachment,
      onIndexUpdating: (updating, ms) => {
        if (!updating && ms !== undefined) this.log('index-updated', Math.round(ms) + ' ms')
        this.patchAccounts(id, { updatingIndex: updating || undefined })
      },
    })
  }
  discover = async (email: string): Promise<DiscoveryResult> => {
    if (!this.options.discover) throw new Error('Automatic setup is not available in this build.')
    return this.options.discover(email)
  }
  /** Signs in to each server separately and reports each result. Nothing is saved or sent. */
  testConnection = async (input: ConnectInput): Promise<ConnectionTest> => {
    input = { ...input, config: verifiedCertificates(input.config) }
    const provider = this.createProvider('test-' + randomUUID(), input, true)
    const result: ConnectionTest = { incoming: { ok: false } }
    /** A refused certificate is read again without signing in, so the user can review it. */
    const failed = async (server: 'incoming' | 'outgoing', error: unknown) => {
      const check: ConnectionCheck = { ok: false, error: friendlyError(error) }
      const certificate =
        isProviderError(error, 'certificate', 'outgoingCertificate') &&
        (await provider.inspectCertificate?.(server).catch(() => undefined))
      return certificate ? { ...check, certificate } : check
    }
    try {
      const [accounts] = await Promise.allSettled([provider.connect()])
      if (accounts.status === 'fulfilled') {
        result.incoming = accounts.value.length
          ? { ok: true }
          : { ok: false, error: 'This login does not provide an accessible mail account.' }
        if (accounts.value[0] && provider.folderMappings)
          result.folders = await provider.folderMappings(accounts.value[0]).catch(() => undefined)
      } else result.incoming = await failed('incoming', accounts.reason)
      if (provider.verifyOutgoing)
        result.outgoing = await provider.verifyOutgoing().then(
          () => ({ ok: true }),
          (error) => failed('outgoing', error),
        )
      return result
    } finally {
      provider.dispose()
      await provider.close?.()
    }
  }
  /** `reconnecting` restores a saved login, so labels and names edited since then are kept. */
  connect = async (input: ConnectInput, reconnecting = false): Promise<Account[]> => {
    input = { ...input, config: verifiedCertificates(input.config) }
    const id = input.connectionId || randomUUID()
    const previous = this.connections.find((c) => c.id === id)
    if (previous && previous.config.protocol !== input.config.protocol)
      throw new Error('Remove this account and add it again to change its protocol.')
    const outgoingPassword =
      input.config.protocol === 'imap' && !input.config.outgoingSameCredentials
        ? input.outgoingPassword
        : undefined
    const provider = this.createProvider(id, { ...input, outgoingPassword })
    let accounts: Account[]
    let folders = input.folders ?? previous?.folders
    try {
      accounts = await provider.connect()
      if (!accounts.length)
        throw new Error('This login does not provide an accessible mail account.')
      // A new or edited IMAP login must reach both servers. Restoring one only needs incoming mail.
      if (!reconnecting && provider.verifyOutgoing) await provider.verifyOutgoing()
      if (input.folders && provider.setFolderMappings) {
        const review = await provider.setFolderMappings(accounts[0], input.folders)
        // Saved as plain paths, as the server named them, so a reconnect never creates them again.
        folders = Object.fromEntries(
          Object.keys(input.folders).map((role) => {
            const value = review.mappings[role as keyof typeof review.mappings]
            return [role, value ? { path: value.path } : null]
          }),
        )
      }
      const used = this.accounts.filter((a) => a.connectionId !== id).map((a) => a.color)
      for (const account of accounts) {
        const identities = await provider.identities(account)
        account.email =
          identities[0]?.email ||
          (input.config.protocol === 'imap' ? input.config.email : input.config.username)
        account.sessionOnly = !input.remember
        account.protocol = input.config.protocol
        // Reconnecting must never reset what the user picked for this account.
        const known = this.accounts.find((a) => a.id === account.id)
        account.color = known?.color || nextAccountColor(used)
        account.seed = known?.seed
        account.image = known?.image
        if (reconnecting && known) {
          account.name = known.name
          account.senderName = known.senderName
        } else account.senderName = input.senderName?.trim() || undefined
        // Aliases belong to the account rather than its login, so editing the login keeps them.
        const aliases = known?.aliases?.filter(
          (a) => a.email.toLowerCase() !== account.email.toLowerCase(),
        )
        if (aliases?.length) account.aliases = aliases
        used.push(account.color)
      }
      const keep = (value?: string) =>
        input.remember && secureStorageAvailable() && value ? encryptSecret(value) : undefined
      const local = (value: string | undefined, encrypted?: string) =>
        input.remember && !encrypted ? value : undefined
      const secret = keep(input.password)
      const outgoingSecret = keep(outgoingPassword)
      const connection: Connection = {
        id,
        name: input.name,
        config: input.config,
        secret,
        localSecret: local(input.password, secret),
        outgoingSecret,
        outgoingLocalSecret: outgoingPassword ? local(outgoingPassword, outgoingSecret) : undefined,
        folders,
        accounts,
      }
      this.connections = [...this.connections.filter((c) => c.id !== id), connection]
      await this.saveConnections()
    } catch (error) {
      provider.dispose()
      void provider.close?.()
      if (previous) this.status(id, 'authentication', friendlyError(error))
      throw error
    }
    const old = this.providers.get(id)
    if (old) {
      old.dispose()
      await old.close?.()
    }
    this.providers.set(id, provider)
    this.sessionSecrets.set(id, { password: input.password, outgoingPassword })
    this.accounts = [...this.accounts.filter((a) => a.connectionId !== id), ...accounts]
    provider.subscribe((event) => {
      if (event.type === 'indexing' && event.accountId && event.indexing) {
        this.accounts = this.accounts.map((a) =>
          a.id === event.accountId
            ? { ...a, indexing: event.indexing!.complete ? undefined : event.indexing }
            : a,
        )
        this.emitAccountsSoon()
        return
      }
      if (event.type === 'status' && event.state) {
        this.status(id, event.state, event.message)
        return
      }
      this.reminders.invalidate(event.accountId) // Reminders
      this.emit({ type: 'changed', accountId: event.accountId })
      // Historical indexing adds older mail; only live changes may produce notifications.
      if (!event.historical) void this.refreshConnection(id)
    })
    for (const a of accounts) this.reminders.invalidate(a.id) // Reminders
    this.status(id, 'connected')
    if (!reconnecting) this.outgoing(id, undefined)
    void this.refreshConnection(id)
    this.log('connected', input.config.protocol)
    void this.syncPendingDrafts()
    void this.retrySentCopies(id)
    return accounts
  }
  private emitAccountsSoon() {
    if (this.indexingEmit) return
    this.indexingEmit = setTimeout(() => {
      this.indexingEmit = undefined
      this.emit({ type: 'accounts', accounts: this.accounts })
    }, 1000)
  }
  private secrets(connection: Connection): Secrets | undefined {
    const session = this.sessionSecrets.get(connection.id)
    if (session) return session
    const password = connection.secret ? decryptSecret(connection.secret) : connection.localSecret
    if (!password) return undefined
    const outgoingPassword = connection.outgoingSecret
      ? decryptSecret(connection.outgoingSecret)
      : connection.outgoingLocalSecret
    return { password, outgoingPassword }
  }
  reconnect = async (id: string): Promise<void> => {
    const connection = this.connections.find((c) => c.id === id)
    if (!connection) throw new Error('Connection not found.')
    this.status(id, 'connecting')
    try {
      const secrets = this.secrets(connection)
      if (!secrets) throw new Error('This was a session-only login. Sign in again to reconnect.')
      await this.connect(
        {
          config: connection.config,
          name: connection.name,
          password: secrets.password,
          outgoingPassword: secrets.outgoingPassword,
          remember: !!(connection.secret || connection.localSecret),
          connectionId: id,
        },
        true,
      )
    } catch (error) {
      this.status(
        id,
        error instanceof ProviderError && error.code !== 'authentication'
          ? 'offline'
          : 'authentication',
        friendlyError(error),
      )
      this.log('reconnect-failed')
      throw error
    }
  }
  connectionSettings = async (connectionId: string): Promise<ConnectionSettings> => {
    const connection = this.connections.find((c) => c.id === connectionId)
    if (!connection) throw new Error('Connection not found.')
    return {
      connectionId,
      name: connection.name,
      config: connection.config,
      remember: !!(connection.secret || connection.localSecret),
      folders: connection.folders,
    }
  }
  folderMappings = async (accountId: string) =>
    this.guard(accountId, async (p, a) => {
      if (!p.folderMappings) throw new Error('This server defines its special folders itself.')
      return p.folderMappings(a)
    })
  setFolderMappings = async (accountId: string, mappings: FolderMappings) => {
    const account = this.account(accountId)
    const review = await this.guard(accountId, async (p, a) => {
      if (!p.setFolderMappings) throw new Error('This server defines its special folders itself.')
      return p.setFolderMappings(a, mappings)
    })
    this.connections = this.connections.map((c) =>
      c.id === account.connectionId
        ? {
            ...c,
            folders: Object.fromEntries(
              Object.entries(review.mappings).map(([role, value]) => [
                role,
                value ? { path: value.path } : null,
              ]),
            ),
          }
        : c,
    )
    await this.saveConnections()
    this.emit({ type: 'changed', accountId })
    return review
  }
  /** Saves a change to one account's own settings, which never needs signing in again. */
  private async editAccount(accountId: string, patch: (a: Account) => Partial<Account>) {
    const account = this.account(accountId)
    const apply = (a: Account): Account => (a.id === accountId ? { ...a, ...patch(a) } : a)
    this.accounts = this.accounts.map(apply)
    this.connections = this.connections.map((c) =>
      c.id === account.connectionId ? { ...c, accounts: c.accounts.map(apply) } : c,
    )
    await this.saveConnections()
    this.emit({ type: 'accounts', accounts: this.accounts })
    return this.accounts
  }
  updateAccount = async (accountId: string, appearance: AccountAppearance): Promise<Account[]> => {
    if (appearance.image) {
      const [, type, data] = appearance.image.match(/^data:([^;]+);base64,(.*)$/)!
      if (rasterType(Buffer.from(data, 'base64')) !== type)
        throw new Error('This picture could not be read. Choose a PNG, JPEG or WebP image.')
    }
    return this.editAccount(accountId, () => ({ seed: appearance.seed, image: appearance.image }))
  }
  updateAccountDetails = async (accountId: string, details: AccountDetails): Promise<Account[]> =>
    this.editAccount(accountId, (a) => ({
      name: details.name.trim() || a.name,
      senderName: details.senderName.trim() || undefined,
    }))
  setAliases = async (accountId: string, input: AliasInput[]): Promise<Account[]> => {
    const account = this.account(accountId)
    if (account.protocol !== 'imap')
      throw new Error('This server manages its own sending addresses.')
    const taken = new Set([account.email.toLowerCase()])
    const aliases = input.map((alias): Alias => {
      const email = alias.email.trim()
      if (taken.has(email.toLowerCase()))
        throw new Error(email + ' is already one of this account’s addresses.')
      taken.add(email.toLowerCase())
      // Only a known ID is kept, so drafts and signatures stay with the alias they belong to.
      const id = account.aliases?.some((a) => a.id === alias.id) ? alias.id! : randomUUID()
      const name = alias.name?.trim()
      return { id, email, ...(name ? { name } : {}) }
    })
    return this.editAccount(accountId, () => ({ aliases: aliases.length ? aliases : undefined }))
  }
  disconnect = async (id: string): Promise<void> => {
    const accountIds = new Set(this.accounts.filter((a) => a.connectionId === id).map((a) => a.id))
    const provider = this.providers.get(id)
    provider?.dispose()
    await provider?.close?.()
    this.providers.delete(id)
    this.sessionSecrets.delete(id)
    this.connections = this.connections.filter((c) => c.id !== id)
    this.accounts = this.accounts.filter((a) => a.connectionId !== id)
    for (const draft of this.localDrafts.values())
      if (accountIds.has(draft.accountId)) await this.deleteDraftLocal(draft.id)
    for (const [key, journal] of this.journals)
      if (accountIds.has(journal.accountId)) {
        this.journals.delete(key)
        await this.removeMime(key)
      }
    for (const key of accountIds) {
      this.notificationBaseline.delete(key)
      this.authArrivals.delete(key)
      this.unreadCounts.delete(key)
    }
    // The local message index belongs to this connection only.
    await rm(join(this.store.directory, 'index', id), { recursive: true, force: true })
    this.emit({
      type: 'unread',
      count: [...this.unreadCounts.values()].reduce((sum, n) => sum + n, 0),
    })
    this.undos.clear()
    await this.saveConnections()
    await this.persistDrafts()
    await this.persistJournal()
    this.emit({ type: 'accounts', accounts: this.accounts })
    this.emit({ type: 'changed' })
  }
  mailboxes = (id: string) => this.guard(id, (p, a) => p.mailboxes(a))
  identities = (id: string) => this.guard(id, (p, a) => p.identities(a))
  private async serverMessages(
    provider: MailProvider,
    account: Account,
    ids: string[],
    bodies = true,
    protectedMessage = false,
  ) {
    const messages = await provider.messages(account, ids, bodies)
    if (!provider.rawMessage) return messages
    return Promise.all(
      messages.map(async (message) => {
        if (
          !protectedMessage &&
          !message.security?.encrypted &&
          !/-----BEGIN PGP MESSAGE-----/.test(message.text || '')
        )
          return message
        const raw = await provider.rawMessage!(account, message.id, maxMessageBytes)
        if (securityKind(raw))
          return {
            ...message,
            html: '',
            text: '',
            preview: '',
            protectedRevision: createHash('sha256').update(raw).digest('hex'),
          }
        return message
      }),
    )
  }
  conversation = (id: string, threadId: string, options?: { prefetch?: boolean }) =>
    this.guard(id, async (p, a) => {
      // Reading ahead waits behind the user's own work on the provider's connection.
      const background = { background: !!options?.prefetch }
      const messages = await p.conversation(a, threadId, background)
      const rawMessage = p.rawMessage
      // Largest original read ahead: one short background task on a slow link.
      const readAheadSourceBytes = 768 * 1024
      return Promise.all(
        messages.map(async (message) => {
          // A large original is downloaded by the open, not by a background task the user's
          // open would queue behind. Until then it is neither decrypted nor verified, so it
          // carries no body: the reader shows it loading rather than as plain, unsigned mail.
          if (rawMessage && options?.prefetch && message.size > readAheadSourceBytes) {
            const { html: _html, text: _text, ...pending } = message
            return pending
          }
          const read = rawMessage
            ? await this.encryption.read(
                message,
                await rawMessage.call(p, a, message.id, maxMessageBytes, background),
              )
            : message
          const candidate = this.messageAuthCandidate(read)
          return {
            ...read,
            authCandidate: candidate && { type: candidate.type, value: candidate.value },
          }
        }),
      )
    })
  query = async (query: MailQuery, cursor?: Record<string, number>): Promise<QueryPage> => {
    const tab = tabPlan(this.settings, this.accounts, query)
    const accounts = this.accounts.filter(
      (a) =>
        (!query.accountId || query.accountId === a.id) &&
        (!cursor || a.id in cursor) &&
        (!tab || isImap(a)),
    )
    if (!accounts.length || (tab && 'empty' in tab))
      return { items: [], total: 0, failedAccounts: [] }
    const sent = tab && 'split' in tab ? { ...query, split: tab.split } : query
    const settled = await Promise.allSettled(
      accounts.map(async (a) => {
        // Reminders: due ones lift their conversations in the inbox and its tabs.
        const reminders =
          tabApplies(query) && isImap(a)
            ? (await this.reminders.due(a.id)).map((r) => ({
                threadId: r.threadId,
                kind: r.kind,
                dueAt: new Date(r.dueMs).toISOString(),
                messageId: r.messageId,
              }))
            : []
        const asked = reminders.length ? { ...sent, reminders } : sent
        return {
          accountId: a.id,
          position: cursor?.[a.id] || 0,
          page: await this.guard(a.id, (p, account) =>
            p.query(account, asked, cursor?.[a.id] || 0, 50),
          ),
        }
      }),
    )
    const pages = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
    if (!pages.length)
      throw new Error(
        'Mail is unavailable. Reconnect an account or try again shortly. Previously opened messages remain in your cache.',
      )
    const result = mergePages(pages, 50)
    result.failedAccounts = accounts
      .filter((_, i) => settled[i].status === 'rejected')
      .map((a) => a.id)
    return result
  }
  tabCounts = async (accountId?: string): Promise<Record<string, number>> => {
    const scopes = countScopes(this.settings, this.accounts)
    return sumUnread(
      scopes,
      await this.askTabs(accountId, (p, a) => p.tabCounts?.(a, scopes) ?? Promise.resolve({})),
    )
  }
  tabMatchCount = async (rules: string[]): Promise<number> =>
    sumMatches(
      await this.askTabs(
        undefined,
        (p, a) =>
          p.tabCounts?.(a, { draft: rulesScope(rules, this.accounts) }) ?? Promise.resolve({}),
      ),
    )
  ruleSuggestions = async (text: string, exclude: string[]): Promise<RuleSuggestion[]> => {
    const term = suggestionTerm(text)
    if (term === undefined) return []
    const seen = await this.askTabs(
      undefined,
      (p, a) => p.addressesSeen?.(a, term) ?? Promise.resolve([] as AddressSeen[]),
    )
    return ruleSuggestionsFrom(text, exclude, this.accounts, seen)
  }
  exportInbox = (): Promise<boolean> => exportInboxFile(this.settings)
  importInbox = (): Promise<InboxExport | undefined> => importInboxFile()
  /** Each connected IMAP account's answer for the split inbox; an account that fails is left out. */
  private async askTabs<T = TabCounts>(
    accountId: string | undefined,
    ask: (p: MailProvider, a: Account) => Promise<T>,
  ): Promise<T[]> {
    const accounts = this.accounts.filter(
      (a) => isImap(a) && (!accountId || a.id === accountId) && this.providers.has(a.connectionId),
    )
    const settled = await Promise.allSettled(accounts.map((a) => this.guard(a.id, ask)))
    return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value as T] : []))
  }
  /**
   * Runs one read-plan-write cycle at a time per account. Each cycle checks the server state it
   * read, so two overlapping cycles (archive while the next conversation is marked read) would
   * otherwise make the later one fail with a state mismatch.
   */
  private exclusive<T>(accountId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.writes.get(accountId) || Promise.resolve()).then(task, task)
    const settled = run.catch(() => {})
    this.writes.set(accountId, settled)
    void settled.then(() => {
      if (this.writes.get(accountId) === settled) this.writes.delete(accountId)
    })
    return run
  }
  mutate = async (input: MutationInput): Promise<MutationResult> => {
    const result: MutationResult = { changed: 0, failures: [] },
      undo: UndoEntry[] = []
    for (const accountId of [...new Set(input.targets.map((t) => t.accountId))]) {
      try {
        await this.exclusive(accountId, async () => {
          const { provider, account } = this.provider(accountId)
          const boxes = await provider.mailboxes(account)
          let messages = await provider.conversationMetadata(
            account,
            input.targets.filter((t) => t.accountId === accountId).map((t) => t.threadId),
          )
          // Reminders: only the locations in these roles take part.
          if (input.fromRoles) {
            const roles = new Set(input.fromRoles)
            const from = new Set(boxes.filter((b) => b.role && roles.has(b.role)).map((b) => b.id))
            messages = messages.filter((m) =>
              Object.keys(m.mailboxIds).some((id) => m.mailboxIds[id] && from.has(id)),
            )
          }
          const expectedState = provider.getStateToken(account)
          const plan = planMutation(messages, boxes, input.action, input.mailboxId, {
            exclusiveMailboxes: provider.capabilities.exclusiveMailboxes,
          })
          const changed = await provider.update(
            account,
            input.action === 'destroy' ? {} : plan.changes,
            plan.destroy,
            expectedState,
          )
          result.changed += changed.updated.length
          result.failures.push(...changed.failures)
          if (input.action !== 'destroy')
            undo.push(undoForUpdated(accountId, plan, changed.updated))
        })
        this.emit({ type: 'changed', accountId })
      } catch (error) {
        result.failures.push(friendlyError(error))
      }
    }
    if (undo.length) {
      result.undoId = randomUUID()
      this.undos.set(result.undoId, undo)
      if (this.undos.size > 20) this.undos.delete(this.undos.keys().next().value!)
    }
    return result
  }
  // Reminders
  /** Hides a reminder on every device by labelling its email; `restoreReminder` undoes it. */
  dismissReminder = (target: ReminderTarget): Promise<void> =>
    this.guard(target.accountId, () => this.reminders.dismiss(target))
  restoreReminder = (target: ReminderTarget): Promise<void> =>
    this.guard(target.accountId, () => this.reminders.restore(target))
  /**
   * Moves each thread's archived mail back to its account's inbox, with one undo for all.
   * One move per thread: each account's inbox differs, and a thread that fails stays out of
   * `handled`, so it is tried again later.
   */
  private async returnToInbox(targets: MutationTarget[]) {
    const handled: MutationTarget[] = [],
      undo: UndoEntry[] = []
    let moved = 0
    for (const target of targets)
      try {
        const { provider, account } = this.provider(target.accountId)
        const inbox = (await provider.mailboxes(account)).find((b) => b.role === 'inbox')
        if (!inbox) continue
        const result = await this.mutate({
          targets: [target],
          action: 'move',
          mailboxId: inbox.id,
          fromRoles: ['archive'],
        })
        if (result.undoId) {
          if (result.changed) undo.push(...(this.undos.get(result.undoId) || []))
          this.undos.delete(result.undoId)
        }
        if (result.failures.length) continue
        handled.push(target)
        if (result.changed) moved++
      } catch {
        // Disconnected: tried again on a later pass.
      }
    let undoId: string | undefined
    if (undo.length) {
      undoId = randomUUID()
      this.undos.set(undoId, undo)
      if (this.undos.size > 20) this.undos.delete(this.undos.keys().next().value!)
    }
    return { handled, moved, undoId }
  }
  mutateAll = async (query: MailQuery, action: MailAction): Promise<MutationResult> => {
    if (!['archive', 'trash', 'spam', 'read', 'unread', 'star', 'unstar'].includes(action))
      throw new Error('This action is not supported for all matching conversations.')
    // Snapshot IDs before changing membership so pagination cannot skip shifted rows.
    const targets: MutationInput['targets'] = []
    let matchingTotal = 0
    let cursor: Record<string, number> | undefined
    do {
      const page = await this.query(query, cursor)
      matchingTotal = Math.max(matchingTotal, page.total)
      if (page.failedAccounts.length)
        throw new Error('All accounts must be reachable before applying an action to all results.')
      if (page.incompleteAccounts?.length)
        throw new Error(
          'Some accounts are still indexing, so not every match is known yet. Try again when indexing finishes.',
        )
      targets.push(...page.items.map((c) => ({ accountId: c.accountId, threadId: c.id })))
      cursor = page.next
      if (targets.length > 250_000)
        throw new Error('Narrow your search to fewer than 250,000 conversations.')
      this.emit({
        type: 'progress',
        completed: targets.length,
        total: Math.max(matchingTotal, targets.length),
      })
    } while (cursor)
    const result: MutationResult = { changed: 0, failures: [] },
      combined: UndoEntry[] = []
    for (let i = 0; i < targets.length; i += 50) {
      const part = await this.mutate({ targets: targets.slice(i, i + 50), action })
      result.changed += part.changed
      result.failures.push(...part.failures)
      if (part.undoId) {
        combined.push(...(this.undos.get(part.undoId) || []))
        this.undos.delete(part.undoId)
      }
      this.emit({
        type: 'progress',
        completed: Math.min(i + 50, targets.length),
        total: targets.length,
      })
    }
    if (combined.length) {
      result.undoId = randomUUID()
      this.undos.set(result.undoId, combined)
      if (this.undos.size > 20) this.undos.delete(this.undos.keys().next().value!)
    }
    return result
  }
  undo = async (id: string): Promise<MutationResult> => {
    const entries = this.undos.get(id)
    if (!entries) throw new Error('This undo action has expired.')
    const result: MutationResult = { changed: 0, failures: [] }
    for (const entry of entries) {
      try {
        await this.exclusive(entry.accountId, async () => {
          const { current, state } = await this.guard(entry.accountId, async (p, a) => ({
            current: await p.messages(a, Object.keys(entry.changes)),
            state: p.getStateToken(a),
          }))
          const safe = safeUndoUpdates(entry, current)
          if (Object.keys(safe).length !== Object.keys(entry.changes).length)
            result.failures.push('Some messages changed since this action and were not undone.')
          const changed = await this.guard(entry.accountId, (p, a) => p.update(a, safe, [], state))
          result.changed += changed.updated.length
          result.failures.push(...changed.failures)
        })
        this.emit({ type: 'changed', accountId: entry.accountId })
      } catch (error) {
        result.failures.push(friendlyError(error))
      }
    }
    this.undos.delete(id)
    return result
  }
  folder = async (input: {
    accountId: string
    operation: 'create' | 'rename' | 'delete'
    id?: string
    name?: string
    parentId?: string
  }) => {
    await this.guard(input.accountId, (p, a) =>
      p.folder(a, input.operation, input.id, input.name, input.parentId),
    )
    this.emit({ type: 'changed', accountId: input.accountId })
  }
  // Sent records also serve as tombstones for a stale renderer draft after a crash.
  drafts = async () => [...this.localDrafts.values()]
  stageRemoteAttachments = async (
    accountId: string,
    attachments: Attachment[],
    protectedDraft = false,
  ): Promise<StagedAttachment[]> => {
    if (this.protectionTransition) throw new Error('The vault is locking.')
    const directory = join(this.store.directory, 'attachments')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const staged: StagedAttachment[] = []
    for (const attachment of attachments) {
      const bytes = await this.attachmentBytes(accountId, attachment)
      const item: StagedAttachment = {
        id: randomUUID(),
        name: attachment.name,
        type: attachment.type,
        size: bytes.length,
        cid: attachment.cid,
      }
      if (protectedDraft) {
        await this.protectStagedAttachment(item, bytes)
      } else await writeFile(join(directory, item.id), bytes, { mode: 0o600 })
      this.staging.set(item.id, item)
      staged.push(item)
      await this.persistStaging()
    }
    return staged
  }
  /** Reads a staged attachment. Only IDs recorded by this service resolve to files. */
  private async protectStagedAttachment(attachment: StagedAttachment, bytes: Uint8Array) {
    const protectedAttachment = { ...attachment, blobId: 'vault:' + attachment.id }
    await this.encryption.vault.putMany([
      ['attachment:' + attachment.id, bytes],
      ['attachment-meta:' + attachment.id, Buffer.from(JSON.stringify(protectedAttachment))],
    ])
    Object.assign(attachment, protectedAttachment)
  }
  private persistStaging() {
    return this.store.write(
      'staging',
      [...this.staging.values()].map((attachment) =>
        attachment.blobId?.startsWith('vault:')
          ? {
              id: attachment.id,
              size: attachment.size,
              name: 'Protected attachment',
              type: 'application/octet-stream',
              blobId: attachment.blobId,
            }
          : attachment,
      ),
    )
  }
  readStagedAttachment = async (id: string): Promise<Uint8Array> => {
    if (!this.staging.has(id))
      throw new Error('An attachment is missing. Remove it and attach the file again.')
    if (this.staging.get(id)?.blobId?.startsWith('vault:')) {
      const bytes = this.encryption.vault.read('attachment:' + id)
      if (!bytes) throw new Error('The protected attachment is missing.')
      return bytes
    }
    return readFile(join(this.store.directory, 'attachments', id))
  }
  resumeDraft = async (accountId: string, messageId: string): Promise<Draft> => {
    const existing = [...this.localDrafts.values()].find(
      (d) => d.accountId === accountId && d.serverId === messageId,
    )
    const replacedBy = [...this.journals.values()].find(
      (j) => j.accountId === accountId && j.previousDraft?.serverId === messageId,
    )
    if (replacedBy?.state === 'uncertain')
      throw new Error(
        replacedBy.dismissed
          ? 'This message may already have been sent. Check Sent before writing it again.'
          : 'Delivery isn’t confirmed yet. See Needs attention.',
      )
    if (existing?.status === 'sent' || replacedBy)
      throw new Error('This message has already been sent.')
    if (existing) return existing
    const [message] = await this.guard(accountId, async (p, a) => {
      const [m] = await p.messages(a, [messageId], true)
      return m && p.rawMessage
        ? [await this.encryption.read(m, await p.rawMessage(a, messageId, maxMessageBytes))]
        : [m]
    })
    if (!message?.keywords.$draft) throw new Error('This message is no longer a draft.')
    if (message.security && !['decrypted', 'signed'].includes(message.security.state))
      throw new Error(message.security.detail)
    const identities = await this.identities(accountId)
    const identity =
      identities.find((i) =>
        message.from.some((f) => f.email.toLowerCase() === i.email.toLowerCase()),
      ) || identities[0]
    if (!identity) throw new Error('No sending identity is available for this account.')
    const attachments = await this.stageRemoteAttachments(
      accountId,
      message.attachments || [],
      !!message.security?.encrypted,
    )
    const draft: Draft = {
      id: randomUUID(),
      accountId,
      identityId: identity.id,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      html: message.html || '',
      text: message.text || '',
      attachments,
      updatedAt: new Date().toISOString(),
      status: 'synced',
      encryption: message.security?.encrypted ? 'encrypt' : undefined,
      encryptionRequired: !!message.security?.encrypted,
      serverId: message.id,
      serverFingerprint: draftFingerprint(message),
      references: message.references,
      inReplyTo: message.inReplyTo,
    }
    return this.saveDraft(draft)
  }
  saveDraft = (draft: Draft): Promise<Draft> => {
    const operation = this.draftWrites.then(() => this.saveDraftNow(draft))
    this.draftWrites = operation.catch(() => {})
    return operation
  }
  private async saveDraftNow(draft: Draft): Promise<Draft> {
    if (this.protectionTransition) throw new Error('Wait for the vault to finish locking.')
    this.account(draft.accountId)
    const old = this.localDrafts.get(draft.id)
    // A send owns its draft. A server save does not: edits made meanwhile still reach disk.
    if (
      (this.busyDrafts.has(draft.id) && !this.draftSyncs.has(draft.id)) ||
      old?.status === 'uncertain' ||
      old?.status === 'sent'
    )
      return old || draft
    if (old && old.updatedAt > draft.updatedAt) return old
    // Server revisions belong to the main process. An edit captured before a sync reply
    // must not restore an ID that we have already replaced and removed from the server.
    // Clearing the link after a conflict is the explicit “Keep both versions” action.
    if (
      old?.serverId &&
      old.accountId === draft.accountId &&
      !(old.errorKind === 'conflict' && !draft.serverId)
    )
      draft = {
        ...draft,
        serverId: old.serverId,
        serverFingerprint: old.serverFingerprint,
      }
    if (
      draft.encryption !== 'encrypt' &&
      (old?.encryption === 'encrypt' || draft.encryptionRequired) &&
      !draft.downgradeConfirmed
    )
      throw new Error('Confirm sending or saving this decrypted content without encryption first.')
    if (old?.encryption === 'encrypt' && draft.encryption !== 'encrypt')
      this.requireProtectedDraft(old)
    if (draft.encryption === 'encrypt') {
      if (!this.encryption.vault.unlocked)
        throw new Error('Unlock the encryption vault to save this protected draft.')
      draft = {
        ...draft,
        earlierPlaintext:
          draft.earlierPlaintext ||
          old?.earlierPlaintext ||
          (!!old && old.encryption !== 'encrypt') ||
          (!!draft.serverId && old?.encryption !== 'encrypt'),
      }
      for (const attachment of draft.attachments) {
        const staged = this.staging.get(attachment.id)
        if (!staged) throw new Error('An attachment is missing.')
        if (!staged.blobId?.startsWith('vault:')) {
          const bytes = await this.readStagedAttachment(attachment.id)
          await this.protectStagedAttachment(staged, bytes)
          await this.persistStaging()
          await rm(join(this.store.directory, 'attachments', attachment.id), { force: true })
        }
      }
      this.protectedLoaded.add(draft.id)
    }
    this.localDrafts.set(draft.id, draft)
    await this.persistDrafts()
    if (old?.encryption === 'encrypt' && draft.encryption !== 'encrypt') {
      await this.encryption.vault.put('draft:' + draft.id, undefined)
      this.protectedLoaded.delete(draft.id)
    }
    return draft
  }
  /** Uploads attachments for providers that reference server blobs. Others read staged files. */
  private async uploadDraft(draft: Draft): Promise<Draft> {
    const { provider, account } = this.provider(draft.accountId)
    const attachments: StagedAttachment[] = []
    for (const attachment of draft.attachments) {
      const staged = this.staging.get(attachment.id)
      if (!staged) throw new Error('An attachment is missing. Remove it and attach the file again.')
      if (!provider.capabilities.blobUpload) {
        attachments.push({ ...staged, cid: attachment.cid ?? staged.cid })
        continue
      }
      const data = await this.readStagedAttachment(attachment.id)
      const blobId = await provider.upload(account, data, staged.type)
      attachments.push({ ...staged, blobId })
    }
    return { ...draft, attachments }
  }
  /** A draft being sent, or with a send on record, belongs to the send, not to draft saves. */
  private claimedBySend(id: string) {
    const journal = this.journals.get(id)
    return this.sending.has(id) || (!!journal && journal.state !== 'rejected')
  }
  syncDraft = async (input: Draft): Promise<Draft> => {
    if (this.protectionTransition) throw new Error('The vault is locking.')
    if (this.busyDrafts.has(input.id) || this.claimedBySend(input.id))
      return this.localDrafts.get(input.id) || input
    // One server save per draft at a time: a second request joins it. Its content is still
    // saved locally, and a later background save sends it on.
    const running = this.draftSyncs.get(input.id)
    if (running) return this.saveDraft(input).then(() => running)
    const sync = this.syncDraftNow(input)
    this.draftSyncs.set(input.id, sync)
    try {
      return await sync
    } finally {
      if (this.draftSyncs.get(input.id) === sync) this.draftSyncs.delete(input.id)
    }
  }
  private async syncDraftNow(input: Draft): Promise<Draft> {
    input = await this.saveDraft(input)
    this.busyDrafts.add(input.id)
    let committed: Draft | undefined
    try {
      const { provider, account } = this.provider(input.accountId)
      const current = this.localDrafts.get(input.id)
      if (current && current.updatedAt > input.updatedAt) return current
      if (current && ['uncertain', 'sent'].includes(current.status)) return current
      if (input.serverId) {
        const [remote] = await this.serverMessages(
          provider,
          account,
          [input.serverId],
          true,
          input.encryption === 'encrypt',
        )
        if (!remote || !remote.keywords.$draft)
          throw new ProviderError(
            'conflict',
            'This draft was sent or removed in another client. Your local copy is safe; keep both versions to start a separate draft.',
          )
        if (
          remote &&
          input.serverFingerprint &&
          draftFingerprint(remote) !== input.serverFingerprint
        )
          throw new ProviderError(
            'conflict',
            'This draft changed in another client. Your local copy is safe; save it as a new draft to keep both versions.',
          )
      }
      const protectedMime =
        input.encryption === 'encrypt'
          ? await this.protectedMime(input, randomUUID() + '@inlark.local', true)
          : undefined
      const draft = protectedMime ? input : await this.uploadDraft(input)
      const serverId = await provider.createDraft(account, draft, undefined, protectedMime)
      const [remote] = await this.serverMessages(
        provider,
        account,
        [serverId],
        true,
        input.encryption === 'encrypt',
      )
      // A failed send's reason outlives server saves; editing the draft clears it.
      const note = this.sending.has(input.id) ? undefined : this.notSentNote(input)
      const saved: Draft = {
        ...draft,
        serverId,
        serverFingerprint: remote ? draftFingerprint(remote) : undefined,
        status: 'synced',
        error: note?.error,
        errorKind: note?.errorKind,
      }
      committed = saved
      this.commitSync(saved)
      await this.persistDrafts()
      if (input.serverId && input.serverId !== serverId)
        await this.removePreviousDraft(provider, account, input)
      this.emit({ type: 'changed', accountId: account.id })
      return saved
    } catch (error) {
      const saved: Draft = {
        ...(committed || input),
        status: 'error',
        error: friendlyError(error),
        errorKind: errorKind(error),
      }
      this.commitSync(saved)
      await this.persistDrafts()
      return saved
    } finally {
      this.busyDrafts.delete(input.id)
    }
  }
  /** Records a server save, keeping any newer edit that was saved locally while it ran. */
  private commitSync(result: Draft) {
    const current = this.localDrafts.get(result.id)
    this.localDrafts.set(
      result.id,
      current && current.updatedAt > result.updatedAt
        ? { ...current, serverId: result.serverId, serverFingerprint: result.serverFingerprint }
        : result,
    )
  }
  /** Removes a replaced server draft only if nobody else changed it since it was read. */
  private async removePreviousDraft(
    provider: MailProvider,
    account: Account,
    draft: Pick<Draft, 'serverId' | 'serverFingerprint' | 'encryption'>,
  ) {
    const [remote] = await this.serverMessages(
      provider,
      account,
      [draft.serverId!],
      true,
      draft.encryption === 'encrypt',
    )
    const state = provider.getStateToken(account)
    if (!remote) return
    if (
      !remote.keywords.$draft ||
      !draft.serverFingerprint ||
      draftFingerprint(remote) !== draft.serverFingerprint
    )
      throw new ProviderError(
        'conflict',
        'The previous draft changed in another client and was preserved. Your new copy is saved.',
      )
    const result = await provider.update(account, {}, [draft.serverId!], state)
    if (result.failures.length)
      throw new Error('Your new draft is saved. The previous server copy could not be removed.')
  }
  private async completeDraft(draft: Draft) {
    // A replaced server draft not yet removed stays linked, so it is never offered as a draft.
    const replaced = this.journals.get(draft.id)?.previousDraft
    // Keep a minimal tombstone so a stale renderer copy cannot reappear after a crash.
    this.localDrafts.set(draft.id, {
      id: draft.id,
      accountId: draft.accountId,
      identityId: draft.identityId,
      ...(replaced ? { serverId: replaced.serverId } : {}),
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      html: '',
      text: '',
      attachments: [],
      updatedAt: draft.updatedAt,
      status: 'sent',
    })
    await this.persistDrafts()
    if (draft.encryption === 'encrypt' && this.encryption.vault.unlocked)
      await this.encryption.vault.put('draft:' + draft.id, undefined)
    this.protectedLoaded.delete(draft.id)
    await this.releaseAttachments(draft)
  }
  private async releaseAttachments(draft: Draft) {
    for (const attachment of draft.attachments) {
      if (
        ![...this.localDrafts.values()].some((d) =>
          d.attachments.some((a) => a.id === attachment.id),
        )
      ) {
        await rm(join(this.store.directory, 'attachments', attachment.id), { force: true })
        if (this.staging.get(attachment.id)?.blobId?.startsWith('vault:'))
          await this.encryption.vault.putMany([
            ['attachment:' + attachment.id, undefined],
            ['attachment-meta:' + attachment.id, undefined],
          ])
        this.staging.delete(attachment.id)
      }
    }
    if (draft.attachments.length) await this.persistStaging()
  }
  private async deleteDraftLocal(id: string) {
    const draft = this.localDrafts.get(id)
    if (draft?.encryption === 'encrypt') {
      if (!this.encryption.vault.unlocked)
        throw new Error('Unlock the vault before deleting this draft.')
      await this.encryption.vault.put('draft:' + id, undefined)
      this.protectedLoaded.delete(id)
    }
    this.localDrafts.delete(id)
    if (draft) await this.releaseAttachments(draft)
  }
  deleteDraft = async (id: string) => {
    if (this.busyDrafts.has(id)) throw new Error('Wait for this draft to finish saving.')
    const draft = this.localDrafts.get(id)
    if (draft?.encryption === 'encrypt') this.requireProtectedDraft(draft)
    if (draft?.status === 'uncertain')
      throw new Error('Check this message’s delivery status before deleting the draft.')
    if (draft?.serverId) {
      const result = await this.guard(draft.accountId, async (p, a) => {
        const [remote] = await this.serverMessages(
          p,
          a,
          [draft.serverId!],
          true,
          draft.encryption === 'encrypt',
        )
        const state = p.getStateToken(a)
        // Discarding a local copy must never remove mail already sent or changed elsewhere.
        if (
          !remote?.keywords.$draft ||
          !draft.serverFingerprint ||
          draftFingerprint(remote) !== draft.serverFingerprint
        )
          return { updated: [], failures: [] }
        return p.update(a, {}, [draft.serverId!], state)
      })
      if (result.failures.length)
        throw new Error('The server draft could not be deleted. Your local draft is preserved.')
    }
    await this.deleteDraftLocal(id)
    await this.persistDrafts()
    this.emit({ type: 'changed' })
  }
  deleteServerDraft = async (accountId: string, messageId: string) => {
    const linked = [...this.localDrafts.values()].find(
      (d) => d.accountId === accountId && d.serverId === messageId,
    )
    if (linked) return this.deleteDraft(linked.id)
    const result = await this.exclusive(accountId, () =>
      this.guard(accountId, async (p, a) => {
        const [message] = await p.messages(a, [messageId])
        const state = p.getStateToken(a)
        if (!message) return { updated: [], failures: [] }
        // Only a message that is still a draft may be removed; one sent meanwhile stays.
        if (!message.keywords.$draft) throw new Error('This message is no longer a draft.')
        return p.update(a, {}, [messageId], state)
      }),
    )
    if (result.failures.length) throw new Error('The server draft could not be deleted.')
    this.emit({ type: 'changed', accountId })
  }
  private mimePath(draftId: string) {
    return join(this.store.directory, 'outgoing', draftId + '.eml')
  }
  private async writeMime(draftId: string, mime: Uint8Array) {
    const directory = join(this.store.directory, 'outgoing')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = await open(this.mimePath(draftId), 'w', 0o600)
    try {
      await file.writeFile(mime)
      await file.sync()
    } finally {
      await file.close()
    }
  }
  private removeMime(draftId: string) {
    return rm(this.mimePath(draftId), { force: true })
  }
  private async outgoingMessage(journal: Journal): Promise<OutgoingMessage> {
    return {
      messageId: journal.messageId || journal.draftId + '@inlark.local',
      emailId: journal.emailId,
      envelope: journal.envelope || { from: '', to: [] },
      mime: journal.mime ? await readFile(this.mimePath(journal.draftId)) : undefined,
      // Read status: a retry after a restart must replace the server's copy too.
      ...(journal.tracked ? { replaceServerCopies: true } : {}),
    }
  }
  /** The domain of the address the message is from. */
  private messageDomain(account: Account, identityId: string) {
    const email = account.aliases?.find((a) => a.id === identityId)?.email || account.email
    const domain = email
      .split('@')[1]
      ?.toLowerCase()
      .replace(/[^a-z0-9.-]/g, '')
    return domain || 'inlark.invalid'
  }
  /** A unique Message-ID per attempt, on the domain of the address the message is from. */
  private messageIdFor(account: Account, identityId: string) {
    return randomUUID() + '@' + this.messageDomain(account, identityId)
  }
  private rejectedAddresses(draft: Draft, journal: Journal): Address[] {
    const refused = new Set((journal.rejected || []).map((r) => r.email.toLowerCase()))
    return [...draft.to, ...draft.cc, ...draft.bcc].filter((a) =>
      refused.has(a.email.toLowerCase()),
    )
  }
  /** `filing` reports a send whose Sent copy is still being filed in the background. */
  private sendResult(journal: Journal, draft?: Draft, filing = false): SendResult {
    const pending =
      !filing && ['pending', 'appending', 'uncertain', 'failed'].includes(journal.sentCopy || '')
    const sentCopy = filing ? {} : { sentCopy: pending ? ('pending' as const) : ('filed' as const) }
    if (journal.state === 'partial') {
      const rejected = draft ? this.rejectedAddresses(draft, journal) : []
      const refused = journal.rejected?.length || rejected.length
      const unconfirmed = journal.unconfirmed?.length
      return {
        status: 'partial',
        message:
          'Sent to some recipients. ' +
          (!journal.tracked
            ? refused + ' refused the message.'
            : // Read status: one copy each, so a copy can also be lost with the connection.
              [
                refused ? refused + " didn't get it." : '',
                unconfirmed ? `Delivery to ${unconfirmed} isn't confirmed.` : '',
              ]
                .filter(Boolean)
                .join(' ')) +
          (pending ? ' Sent copy pending.' : ''),
        rejected,
        ...sentCopy,
      }
    }
    return {
      status: 'sent',
      message: pending ? 'Message sent. Sent copy pending.' : 'Message sent.',
      ...sentCopy,
    }
  }
  send = async (input: Draft): Promise<SendResult> => {
    if (this.protectionTransition) throw new Error('The vault is locking.')
    const draft = sendDraftSchema.parse(input)
    if (!draft.to.length && !draft.cc.length && !draft.bcc.length)
      throw new Error('Add at least one recipient.')
    // Already accepted and still filing its copy: report it, never submit again.
    if (this.finishing.has(draft.id)) return this.reconcile(draft.id)
    if (this.sending.has(draft.id)) throw new Error('This message is already sending.')
    // Claimed before any await, so no second send or background save can slip in.
    this.sending.add(draft.id)
    let returned!: () => void
    const run = new Promise<void>((resolve) => (returned = resolve))
    this.sendRuns.add(run)
    try {
      return await this.sendDraft(draft)
    } catch (error) {
      // Nothing left the device, so the draft keeps the reason until it is edited.
      if (!this.journals.has(draft.id) || this.journals.get(draft.id)!.state === 'rejected')
        await this.noteNotSent(draft.id, friendlyError(error), errorKind(error))
      throw error
    } finally {
      this.sending.delete(draft.id)
      this.sendRuns.delete(run)
      returned()
    }
  }
  /**
   * Settles once no send is submitting or still filing its Sent copy, so quitting can wait for
   * them. Undefined when nothing is sending.
   */
  sendsSettled(): Promise<void> | undefined {
    const pending = [...this.sendRuns, ...this.finishing.values()]
    if (!pending.length) return undefined
    // A send that returns hands over to its finishing work, so check again.
    return Promise.allSettled(pending).then(() => this.sendsSettled())
  }
  /**
   * Records why a draft was not sent, as a refused attempt, and (unless `onDraft` is false)
   * notes it on the saved draft. The draft's content is left exactly as saved.
   */
  private async noteNotSent(id: string, error: string, kind?: DraftErrorKind, onDraft = true) {
    const draft = this.localDrafts.get(id)
    const journal = this.journals.get(id)
    if (
      !draft ||
      this.protectionTransition ||
      ['sending', 'sent', 'uncertain'].includes(draft.status) ||
      (journal && journal.state !== 'rejected')
    )
      return
    this.journals.set(id, {
      ...(journal || { draftId: id, accountId: draft.accountId, subject: draft.subject }),
      state: 'rejected',
      at: new Date().toISOString(),
      error,
      errorKind: kind,
    })
    await this.persistJournal().catch(() => this.log('draft-error-save-failed'))
    if (!onDraft) return
    this.localDrafts.set(id, { ...draft, status: 'error', error, errorKind: kind })
    await this.persistDrafts().catch(() => this.log('draft-error-save-failed'))
  }
  /** The reason the draft's last send failed, as long as the draft is unchanged since then. */
  private notSentNote(draft: Pick<Draft, 'id' | 'updatedAt'>) {
    const journal = this.journals.get(draft.id)
    return journal?.state === 'rejected' && journal.error && journal.at >= draft.updatedAt
      ? journal
      : undefined
  }
  private async sendDraft(draft: Draft): Promise<SendResult> {
    // A background save in progress finishes first; send then checks the draft it saved.
    // Should the app quit meanwhile, the next start says it was not sent. Until then it is
    // still sending, so the draft itself says nothing.
    if (this.draftSyncs.has(draft.id))
      await this.noteNotSent(draft.id, interruptedSend, 'connection', false)
    const deadline = Date.now() + draftSaveWaitMs
    let saving: Promise<Draft> | undefined
    while ((saving = this.draftSyncs.get(draft.id)) && Date.now() < deadline)
      await settledWithin(saving, deadline - Date.now())
    if (this.busyDrafts.has(draft.id) || this.draftSyncs.has(draft.id))
      throw new Error('This draft is still saving. Try again in a moment.')
    const existing = this.journals.get(draft.id)
    if (existing && existing.state !== 'rejected') return this.reconcile(draft.id)
    draft = sendDraftSchema.parse(await this.saveDraft(draft))
    const { provider, account } = this.provider(draft.accountId)
    // Read status: a quoted Worker image (current or previous address) never goes out again.
    const base = workerBase(this.settings.readStatus?.workerUrl)
    const hosts = workerHosts(this.settings.readStatus)
    const content = hosts.length ? { ...draft, html: stripPixels(draft.html, hosts) } : draft
    // Decided once: the same answer chooses protected MIME and rules out tracking.
    const encrypted =
      (draft.encryption && draft.encryption !== 'none') ||
      this.encryption.identity(draft.accountId, draft.identityId)?.enabled
    const protection = !encrypted ? 'none' : draft.encryption === 'encrypt' ? 'encrypt' : 'sign'
    const tracking = this.trackingFor(content, account, provider, base, protection)
    this.busyDrafts.add(draft.id)
    const journal: Journal = {
      draftId: draft.id,
      accountId: draft.accountId,
      subject: draft.subject,
      messageId:
        tracking?.messageId ??
        (provider.capabilities.sentCopy === 'client'
          ? this.messageIdFor(account, draft.identityId)
          : draft.id + '@inlark.local'),
      ...(tracking && { tracked: true }),
      state: 'preparing',
      at: new Date().toISOString(),
    }
    this.journals.set(draft.id, journal)
    let accepted = false
    // Set once the accepted send is handed to `finishSend`, which then owns the draft.
    let finishing = false
    // Only set once the durable journal says `submitting` and the network call begins.
    let attempted = false
    let uploaded = draft
    try {
      await this.persistJournal()
      if (draft.serverId) {
        const [remote] = await this.serverMessages(
          provider,
          account,
          [draft.serverId],
          true,
          draft.encryption === 'encrypt',
        )
        if (!remote || !remote.keywords.$draft)
          throw new ProviderError(
            'conflict',
            'This draft was sent or removed in another client. Review it before creating a separate draft.',
          )
        if (remote && draftFingerprint(remote) !== draft.serverFingerprint)
          throw new ProviderError(
            'conflict',
            'This draft changed in another client. Save a separate copy before sending.',
          )
      }
      const protectedMime = encrypted
        ? await this.protectedMime(content, journal.messageId!)
        : undefined
      uploaded = protectedMime ? content : await this.uploadDraft(content)
      const outgoing = await provider.prepareSubmission(
        account,
        uploaded,
        journal.messageId!,
        protectedMime,
        tracking?.images,
      )
      journal.emailId = outgoing.emailId
      journal.envelope = outgoing.envelope
      if (outgoing.mime) {
        await this.writeMime(draft.id, outgoing.mime)
        journal.mime = true
      }
      if (provider.capabilities.sentCopy === 'client') journal.sentCopy = 'pending'
      if (tracking) {
        // Read status: the server's own Sent copy is a recipient's copy, so it is replaced.
        outgoing.replaceServerCopies = true
        journal.copies = (outgoing.copies ?? []).map((c) => ({
          recipient: c.recipient,
          state: 'pending' as const,
        }))
      }
      // Once the message is accepted, the server draft it replaces must go, even after a restart.
      if (draft.serverId && draft.serverId !== journal.emailId)
        journal.previousDraft = {
          serverId: draft.serverId,
          serverFingerprint: draft.serverFingerprint,
          encryption: draft.encryption,
        }
      // Everything needed to recover must be durable before anything leaves the device.
      journal.state = 'submitting'
      await this.persistJournal()
      this.localDrafts.set(draft.id, { ...uploaded, status: 'sending' })
      await this.persistDrafts()
      attempted = true
      const outcome = tracking
        ? await this.submitTracked(journal, account, outgoing)
        : await this.guard(account.id, (p, a) => p.submit(a, outgoing, draft.identityId))
      accepted = true
      this.outgoing(account.connectionId, undefined)
      journal.accepted = outcome.accepted
      journal.rejected = outcome.rejected
      journal.state = outcome.rejected.length || journal.unconfirmed?.length ? 'partial' : 'sent'
      // Acceptance is recorded before filing or cleanup, which may fail independently.
      await this.persistJournal()
      // A partial send keeps its content so the refused recipients can be recovered.
      if (journal.state === 'sent') await this.completeDraft(uploaded)
      else this.localDrafts.set(draft.id, { ...uploaded, status: 'sent' })
      await this.persistDrafts()
      this.finishing.set(draft.id, this.finishSend(journal, uploaded, outgoing))
      finishing = true
      return this.sendResult(journal, uploaded, !!journal.sentCopy)
    } catch (error) {
      if (accepted) {
        this.localDrafts.set(draft.id, { ...uploaded, status: 'sent' })
        this.log('sent-local-save-failed')
        return {
          ...this.sendResult(journal, uploaded),
          message:
            'Message sent. Local status could not be saved; delivery will be reconciled after restart.',
        }
      }
      const ambiguous =
        attempted &&
        !(error instanceof ProviderError && definiteSubmissionCodes.includes(error.code))
      journal.state = ambiguous ? 'uncertain' : 'rejected'
      if (!ambiguous) {
        journal.sentCopy = undefined
        journal.previousDraft = undefined
        await this.removeMime(draft.id)
        journal.mime = undefined
      }
      await this.persistJournal()
      this.localDrafts.set(draft.id, {
        ...draft,
        status: ambiguous ? 'uncertain' : 'error',
        error: friendlyError(error),
        errorKind: ambiguous ? undefined : errorKind(error),
      })
      await this.persistDrafts()
      // Read status: Gmail may have filed a recipient's copy, image included; replace it if so.
      if (ambiguous && journal.tracked && journal.sentCopy) this.fileUnconfirmedCopy(journal)
      if (ambiguous)
        return {
          status: 'uncertain',
          message:
            'Delivery is not confirmed. Your draft is safe. Check status before trying again.',
        }
      throw error
    } finally {
      if (!finishing) this.busyDrafts.delete(draft.id)
    }
  }
  /** Read status: the tracked Message-ID and images, or undefined for an untracked send. */
  private trackingFor(
    draft: Draft,
    account: Account,
    provider: MailProvider,
    base: string | undefined,
    protection: 'none' | 'encrypt' | 'sign',
  ) {
    const settings = this.settings.readStatus
    const password = this.readStatusSecret.get()
    const block = trackingBlock({
      settings,
      passwordSet: !!password,
      draft,
      protection,
      // Only Gmail keeps the Message-ID and lets its own Sent copy be replaced.
      perCopySending:
        !!provider.submitCopies &&
        provider.capabilities.sentCopy === 'client' &&
        account.readStatus === true,
      ownAddresses: ownAddresses(this.accounts),
    })
    if (block || !base || !password) {
      this.log('read-status-untracked', block)
      return undefined
    }
    const messageId = trackedMessageId(password, this.messageDomain(account, draft.identityId))
    const images: SubmissionTracking = {
      imageFor: (recipient) =>
        isAutomatedAddress(recipient)
          ? undefined
          : pixelUrl(base, imageCode(password, messageId, recipient)),
    }
    return { messageId, images }
  }
  /**
   * Read status: sends one copy per recipient over one session. Each copy is durable as
   * `sending` before it leaves, so a crash never sends to anyone twice. Throws, like `submit`,
   * when nothing was accepted.
   */
  private async submitTracked(
    journal: Journal,
    account: Account,
    outgoing: OutgoingMessage,
  ): Promise<SubmissionOutcome> {
    const copies = journal.copies!
    const record = (recipient: string, state: JournalCopy['state'], reason?: string) => {
      const copy = copies.find((c) => c.recipient === recipient)
      if (copy) Object.assign(copy, { state, reason })
    }
    const progress = async (recipient: string, previous?: CopyOutcome) => {
      if (previous) record(previous.recipient, previous.result, previous.reason)
      record(recipient, 'sending')
      await this.persistJournal().catch((error) => {
        if (previous) throw error
        // Before the first copy nothing has left, and nothing will: a plain not-sent.
        record(recipient, 'pending')
        throw new ProviderError(
          'submission',
          'The send record could not be saved, so nothing was sent. Try again.',
        )
      })
    }
    const outcomes = await this.guard(account.id, (p, a) => p.submitCopies!(a, outgoing, progress))
    for (const o of outcomes) record(o.recipient, o.result, o.reason)
    const { state, ...settled } = settleCopies(copies)
    journal.unconfirmed = settled.unconfirmed
    if (state === 'rejected')
      throw new ProviderError(
        'submissionRejected',
        settled.rejected[0]?.reason || 'The message was not sent.',
      )
    if (state === 'uncertain')
      throw new ProviderError('submissionUncertain', 'Delivery is not confirmed.')
    return settled
  }
  /**
   * Finishes an accepted send after it has been reported: files the Sent copy and removes the
   * server draft it replaced. Both are in the journal, so failures are recorded for the user
   * and a quit is resumed on the next start. The message itself is never sent again.
   */
  private async finishSend(journal: Journal, draft: Draft, outgoing: OutgoingMessage) {
    try {
      // The old draft goes first: until then it could be opened and sent a second time.
      await this.removeReplacedDraft(journal)
      if (journal.sentCopy) await this.fileSentCopy(journal, outgoing)
      void this.reminders.afterSend({
        accountId: journal.accountId,
        messageId: journal.messageId!,
        sentCopy: journal.sentCopy,
        followUp: draft.followUp,
        html: draft.html,
        text: draft.text,
      }) // Reminders
    } catch {
      // Filing and cleanup record their own failures; the next refresh retries them.
      this.log('sent-finish-failed')
    } finally {
      this.finishing.delete(draft.id)
      this.busyDrafts.delete(draft.id)
      this.emit({ type: 'submissions', submissions: this.summaries() })
      this.emit({ type: 'changed', accountId: draft.accountId })
    }
  }
  /** Removes the server draft an accepted message replaced, unless it changed elsewhere. */
  private async removeReplacedDraft(journal: Journal) {
    if (!journal.previousDraft) return
    try {
      const { provider, account } = this.provider(journal.accountId)
      await this.removePreviousDraft(provider, account, journal.previousDraft)
    } catch (error) {
      this.log('old-draft-cleanup-failed')
      // A draft changed in another client is preserved; anything else is retried later.
      if (!(error instanceof ProviderError && error.code === 'conflict')) return
    }
    const local = this.localDrafts.get(journal.draftId)
    if (local?.status === 'sent' && local.serverId === journal.previousDraft.serverId) {
      this.localDrafts.set(local.id, {
        ...local,
        serverId: undefined,
        serverFingerprint: undefined,
      })
      await this.persistDrafts()
    }
    journal.previousDraft = undefined
    await this.persistJournal()
  }
  /**
   * Files the Sent copy of an accepted message. Only filing is ever retried: the provider
   * looks for this attempt's Message-ID first, so an earlier unconfirmed append is never
   * duplicated and the message itself is never sent again.
   */
  private async fileSentCopy(journal: Journal, outgoing?: OutgoingMessage) {
    if (!['pending', 'uncertain', 'failed'].includes(journal.sentCopy || '')) return
    if (this.filing.has(journal.draftId)) return
    this.filing.add(journal.draftId)
    try {
      const { provider, account } = this.provider(journal.accountId)
      if (!provider.fileSentCopy) return
      const prepared = outgoing?.mime ? outgoing : await this.outgoingMessage(journal)
      const message = journal.tracked ? this.trackedSentCopy(journal, prepared) : prepared
      journal.sentCopy = 'appending'
      await this.persistJournal()
      try {
        const result = await provider.fileSentCopy(account, message)
        journal.sentCopyFailures = journal.sentCopyRetryAt = undefined
        if (result === 'absent') {
          // Nothing to replace yet; looked for again on the next retry and before a dismiss.
          journal.sentCopy = 'pending'
          await this.persistJournal()
          return
        }
        journal.sentCopy = result
        journal.sentCopyError = undefined
        if (journal.tracked && result === 'filed') {
          // Read status: the clean copy is confirmed in Sent; a late merged copy is swept later.
          journal.cleanOwed = undefined
          journal.sweepAt = new Date(Date.now() + sweepDelayMs).toISOString()
        }
        await this.persistJournal()
        await this.removeMime(journal.draftId)
      } catch (error) {
        journal.sentCopy =
          error instanceof ProviderError && error.code === 'filingUncertain'
            ? 'uncertain'
            : 'failed'
        journal.sentCopyError = friendlyError(error)
        if (journal.tracked && isProviderError(error, 'filing')) this.backOffSentCopy(journal)
        this.log('sent-copy-failed', journal.sentCopy)
        await this.persistJournal()
      }
    } catch {
      this.log('sent-copy-deferred')
    } finally {
      this.filing.delete(journal.draftId)
    }
  }
  /**
   * Read status: the server's copy carries a recipient's image, so it is replaced. Once Gmail's
   * copies may be in Trash, the debt is durable and every later attempt files the clean copy.
   */
  private trackedSentCopy(journal: Journal, prepared: OutgoingMessage): OutgoingMessage {
    return {
      ...prepared,
      // An unconfirmed tracked send is never shown as sent, only cleaned up.
      replaceServerCopies: journal.state === 'uncertain' ? 'ifPresent' : true,
      replacement: {
        hosts: workerHosts(this.settings.readStatus),
        owed: !!journal.cleanOwed,
        owe: async () => {
          journal.cleanOwed = true
          await this.persistJournal()
        },
        confirmed: (uid) => (journal.cleanUid = uid),
      },
    }
  }
  /** Read status: a tracked send whose clean Sent copy is still to be filed, so its MIME stays. */
  private sentCopyOwed(journal: Journal) {
    return (
      !!journal.cleanOwed ||
      (!!journal.tracked &&
        ['sent', 'partial'].includes(journal.state) &&
        ['pending', 'appending', 'uncertain', 'failed'].includes(journal.sentCopy || ''))
    )
  }
  /**
   * Read status: a tracked filing that failed for good (not a dropped connection) is tried again
   * after 1, 5, 15 and 60 minutes, then once per start. An owed clean copy stays owed.
   */
  private backOffSentCopy(journal: Journal) {
    const failures = (journal.sentCopyFailures ?? 0) + 1
    const wait = sentCopyRetryMs[failures - 1]
    journal.sentCopyFailures = failures
    journal.sentCopyRetryAt = wait ? new Date(Date.now() + wait).toISOString() : undefined
    // Nothing was moved yet, so the server's own copy, image included, is still in Sent.
    if (!journal.cleanOwed) journal.sentCopyError += ' ' + imageCopyKept
  }
  /** Read status: whether the periodic retry may file this journal now (see `backOffSentCopy`). */
  private sentCopyDue(journal: Journal) {
    if (!journal.tracked || !journal.sentCopyFailures) return true
    if (!journal.sentCopyRetryAt) return false
    return Date.now() >= Date.parse(journal.sentCopyRetryAt)
  }
  /** Read status: replaces the server's copy of an unconfirmed tracked send in the background. */
  private fileUnconfirmedCopy(journal: Journal) {
    const id = journal.draftId
    const filing = this.fileSentCopy(journal).finally(() => {
      this.finishing.delete(id)
      this.emit({ type: 'submissions', submissions: this.summaries() })
      this.emit({ type: 'changed', accountId: journal.accountId })
    })
    this.finishing.set(id, filing)
  }
  private async retrySentCopies(connectionId: string) {
    const accountIds = new Set(
      this.accounts.filter((a) => a.connectionId === connectionId).map((a) => a.id),
    )
    for (const journal of this.journals.values())
      if (accountIds.has(journal.accountId) && !this.finishing.has(journal.draftId)) {
        const accepted = ['sent', 'partial'].includes(journal.state)
        // Read status: one look after each start, whatever the back-off below says.
        const startLook = this.lookOnStart.delete(journal.draftId)
        // Read status: an unconfirmed tracked send may have left Gmail's copy with an image. It
        // is looked for while recent and once after each start, not every minute forever; a
        // clean copy owed (Gmail's copies may be in Trash) is filed whenever, even if dismissed.
        const unconfirmed =
          journal.tracked &&
          journal.state === 'uncertain' &&
          (startLook ||
            journal.cleanOwed ||
            Date.now() - Date.parse(journal.at) < unconfirmedLookMs)
        if (
          (accepted || unconfirmed) &&
          (!journal.dismissed || this.sentCopyOwed(journal)) &&
          (startLook || this.sentCopyDue(journal))
        )
          await this.fileSentCopy(journal)
        // Even a dismissed send must not leave its old draft behind to be sent again.
        if (accepted || (journal.state === 'uncertain' && journal.dismissed))
          await this.removeReplacedDraft(journal)
        if (journal.sweepAt) await this.sweepSentCopies(journal) // Read status
      }
  }
  /**
   * Read status: once, about a minute after filing (and after a restart within the hour), removes
   * a merged copy with an image that Gmail filed after the clean one. Kept for the next refresh
   * if it fails; never resends anything.
   */
  private async sweepSentCopies(journal: Journal) {
    const due = Date.parse(journal.sweepAt!)
    if (Date.now() < due || this.filing.has(journal.draftId)) return
    this.filing.add(journal.draftId)
    try {
      if (Date.now() - due < unconfirmedLookMs) {
        const { provider, account } = this.provider(journal.accountId)
        await provider.sweepSentCopies?.(account, {
          messageId: journal.messageId!,
          envelope: journal.envelope || { from: '', to: [] },
          replacement: { hosts: workerHosts(this.settings.readStatus), uid: journal.cleanUid },
        })
      }
      journal.sweepAt = undefined
      await this.persistJournal()
    } catch {
      this.log('sent-copy-sweep-failed')
    } finally {
      this.filing.delete(journal.draftId)
    }
  }
  reconcile = async (id: string): Promise<SendResult> => {
    const journal = this.journals.get(id)
    if (!journal) throw new Error('No send attempt found.')
    const draft = this.localDrafts.get(id)
    if (journal.state === 'sent' || journal.state === 'partial') {
      if (
        journal.state === 'sent' &&
        draft &&
        !this.finishing.has(id) &&
        (draft.status !== 'sent' || this.hasContent(draft))
      )
        await this.completeDraft(draft)
      return {
        ...this.sendResult(journal, draft),
        message: 'This message has already been sent.',
      }
    }
    if (journal.state === 'uncertain') {
      const message = await this.outgoingMessage(journal).catch(() => undefined)
      // Only server submission records prove delivery. A Sent copy alone does not.
      if (
        message &&
        (await this.guard(journal.accountId, (p, a) => p.submissionExists(a, message)))
      ) {
        journal.state = 'sent'
        await this.persistJournal()
        if (draft) await this.completeDraft(draft)
        void this.removeReplacedDraft(journal).catch(() => this.log('old-draft-cleanup-failed'))
        this.emit({ type: 'changed', accountId: journal.accountId })
        return { status: 'sent', message: 'Delivery confirmed.', sentCopy: 'filed' }
      }
    }
    return {
      status: 'uncertain',
      message:
        'Delivery is still unconfirmed. Check Sent or the server before creating a replacement message.',
    }
  }
  private summaries(): SubmissionSummary[] {
    return [...this.journals.values()]
      .filter((j) => !j.dismissed)
      .flatMap((j): SubmissionSummary[] => {
        const draft = this.localDrafts.get(j.draftId)
        const copy: SubmissionSummary['sentCopy'] =
          j.sentCopy === 'pending' || j.sentCopy === 'appending'
            ? 'pending'
            : j.sentCopy === 'uncertain' || j.sentCopy === 'failed'
              ? j.sentCopy
              : undefined
        const base = {
          draftId: j.draftId,
          accountId: j.accountId,
          subject: j.subject ?? draft?.subject ?? '',
          at: j.at,
          ...(copy ? { sentCopy: copy } : {}),
          ...(j.sentCopyError ? { error: j.sentCopyError } : {}),
        }
        if (j.state === 'uncertain') return [{ ...base, state: 'uncertain' }]
        if (j.state === 'partial')
          return [
            {
              ...base,
              state: 'partial',
              rejected: draft
                ? this.rejectedAddresses(draft, j)
                : (j.rejected || []).map((r) => ({ name: '', email: r.email })),
              ...(j.tracked ? { unconfirmed: j.unconfirmed ?? [] } : {}),
            },
          ]
        if (j.state === 'sent' && copy && !this.finishing.has(j.draftId))
          return [{ ...base, state: 'sent' }]
        return []
      })
  }
  submissions = async () => this.summaries()
  retrySentCopy = async (id: string): Promise<SendResult> => {
    const journal = this.journals.get(id)
    if (!journal || !['sent', 'partial'].includes(journal.state))
      throw new Error('Only a sent message can have its Sent copy filed again.')
    await this.fileSentCopy(journal)
    return this.sendResult(journal, this.localDrafts.get(id))
  }
  private copyDraft(source: Draft, patch: Partial<Draft>): Draft {
    return {
      ...source,
      id: randomUUID(),
      serverId: undefined,
      serverFingerprint: undefined,
      status: 'local',
      error: undefined,
      errorKind: undefined,
      updatedAt: new Date().toISOString(),
      ...patch,
    }
  }
  private requireProtectedDraft(draft: Draft) {
    if (
      draft.encryption === 'encrypt' &&
      (this.protectionTransition ||
        !this.encryption.vault.unlocked ||
        !this.protectedLoaded.has(draft.id))
    )
      throw new Error('Unlock the vault before recovering or changing this protected draft.')
  }
  recoverRejected = async (id: string): Promise<Draft> => {
    const journal = this.journals.get(id)
    const draft = this.localDrafts.get(id)
    await this.finishing.get(id)
    if (journal?.state !== 'partial' || journal.dismissed || !draft)
      throw new Error('There are no refused recipients to recover for this message.')
    const refused = new Set(
      this.rejectedAddresses(draft, journal).map((a) => a.email.toLowerCase()),
    )
    // A tracked partial may have only unconfirmed copies: its record must stay.
    if (!refused.size)
      throw new Error('There are no refused recipients to recover for this message.')
    this.requireProtectedDraft(draft)
    if (this.busyDrafts.has(id)) throw new Error('Wait for this draft to finish saving.')
    this.busyDrafts.add(id)
    try {
      const only = (list: Address[]) => list.filter((a) => refused.has(a.email.toLowerCase()))
      const recovery = this.copyDraft(draft, {
        to: only(draft.to),
        cc: only(draft.cc),
        bcc: only(draft.bcc),
      })
      this.localDrafts.set(recovery.id, recovery)
      if (recovery.encryption === 'encrypt') this.protectedLoaded.add(recovery.id)
      journal.dismissed = true
      await this.completeDraft(draft)
      await this.persistJournal()
      return recovery
    } finally {
      this.busyDrafts.delete(id)
    }
  }
  replaceUncertain = async (id: string): Promise<Draft> => {
    const journal = this.journals.get(id)
    const draft = this.localDrafts.get(id)
    if (journal?.state !== 'uncertain' || !draft)
      throw new Error('Only an unconfirmed message can be replaced.')
    this.requireProtectedDraft(draft)
    if (this.busyDrafts.has(id)) throw new Error('Wait for this draft to finish saving.')
    this.busyDrafts.add(id)
    try {
      // The unconfirmed record stays, so its evidence remains available for later checks.
      const replacement = this.copyDraft(draft, {})
      this.localDrafts.set(replacement.id, replacement)
      if (replacement.encryption === 'encrypt') this.protectedLoaded.add(replacement.id)
      await this.persistDrafts()
      return replacement
    } finally {
      this.busyDrafts.delete(id)
    }
  }
  dismissSubmission = async (id: string): Promise<void> => {
    await this.finishing.get(id)
    const journal = this.journals.get(id)
    if (!journal) return
    const draft = this.localDrafts.get(id)
    if (draft && ['partial', 'uncertain'].includes(journal.state)) this.requireProtectedDraft(draft)
    // Read status: one last look for Gmail's copy with an image before it is no longer retried.
    if (journal.tracked && journal.state === 'uncertain') await this.fileSentCopy(journal)
    journal.dismissed = true
    // Read status: a clean Sent copy still owed keeps its MIME, and filing goes on.
    const owed = this.sentCopyOwed(journal)
    if (!owed && journal.sentCopy && journal.sentCopy !== 'filed' && journal.sentCopy !== 'server')
      journal.sentCopy = 'dismissed'
    if (draft && ['partial', 'uncertain'].includes(journal.state)) await this.completeDraft(draft)
    if (!owed) {
      await this.removeMime(id)
      journal.mime = undefined
    }
    await this.persistJournal()
    // As the dialog says, its draft goes too, so a delivered message is not sent twice.
    if (journal.state === 'uncertain') await this.removeReplacedDraft(journal)
  }
  stageAttachments = async (protectedDraft = false): Promise<StagedAttachment[]> => {
    const result = await dialog.showOpenDialog({
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return []
    if (this.protectionTransition) throw new Error('The vault is locking.')
    const directory = join(this.store.directory, 'attachments')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const attachments: StagedAttachment[] = []
    const types: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.zip': 'application/zip',
      '.ics': 'text/calendar',
    }
    for (const path of result.filePaths) {
      const size = (await stat(path)).size
      if (size > 100_000_000) throw new Error('Files over 100 MB cannot be attached.')
      const a = {
        id: randomUUID(),
        name: basename(path),
        size,
        type: types[extname(path).toLowerCase()] || 'application/octet-stream',
      }
      if (protectedDraft) {
        await this.protectStagedAttachment(a, await readFile(path))
      } else {
        await copyFile(path, join(directory, a.id))
        await chmod(join(directory, a.id), 0o600)
      }
      this.staging.set(a.id, a)
      attachments.push(a)
    }
    await this.persistStaging()
    return attachments
  }
  private async attachmentBytes(accountId: string, attachment: Attachment): Promise<Uint8Array> {
    if (attachment.blobId.startsWith('decrypted:')) {
      const data = this.encryption.attachments.get(attachment.blobId)
      if (!this.encryption.vault.unlocked || data?.accountId !== accountId)
        throw new Error('Unlock and reopen this message to access its attachment.')
      return data.content
    }
    return this.guard(accountId, (p, a) => p.download(a, attachment))
  }
  attachment = async (accountId: string, attachment: Attachment, open: boolean): Promise<void> => {
    const result = await dialog.showSaveDialog({
      title: open ? 'Save and open attachment' : 'Save attachment',
      defaultPath: basename(attachment.name),
    })
    if (result.canceled || !result.filePath) return
    const bytes = await this.attachmentBytes(accountId, attachment)
    await writeFile(result.filePath, bytes, { mode: 0o600 })
    if (open) {
      const error = await shell.openPath(result.filePath)
      if (error) throw new Error('The file was saved, but no application could open it.')
    }
  }
  inlineImage = async (accountId: string, attachment: Attachment): Promise<string> => {
    if (!/^image\/(png|jpeg|gif|webp|avif)$/i.test(attachment.type) || attachment.size > 10_000_000)
      throw new Error('Unsupported inline image.')
    const bytes = await this.attachmentBytes(accountId, attachment)
    return 'data:' + attachment.type + ';base64,' + Buffer.from(bytes).toString('base64')
  }
  remoteImage = async (value: string, userInitiated = false): Promise<string | null> =>
    this.settings.remoteImages || (userInitiated && this.encryption.vault.unlocked)
      ? remoteImageData(value, undefined, (url) =>
          // Read status: never load the Worker's images, or opening mail would count as an open.
          isWorkerImage(url, workerHosts(this.settings.readStatus)),
        )
      : null
  senderAvatar = async (email: string): Promise<string | null> => {
    if (!this.settings.remoteImages) return null
    return this.senderAvatars.get(email)
  }
  unsubscribe = async (accountId: string, messageId: string) => {
    const [message] = await this.guard(accountId, async (p, a) => {
      const [m] = await p.messages(a, [messageId], true)
      return m && p.rawMessage
        ? [await this.encryption.read(m, await p.rawMessage(a, messageId, maxMessageBytes))]
        : [m]
    })
    const info = message?.unsubscribe
    if (!info) throw new Error('This message has no supported unsubscribe method.')
    if (info.url.startsWith('mailto:')) return { kind: 'mailto' as const, url: info.url }
    if (info.oneClick) {
      const response = await publicFetch(info.url, {
        method: 'POST',
        body: 'List-Unsubscribe=One-Click',
        headersOnly: true,
      })
      if (response.status < 200 || response.status >= 300)
        throw new Error('The unsubscribe request failed. Try the link in the message.')
      return { kind: 'done' as const }
    }
    await this.openExternal(info.url)
    return { kind: 'browser' as const }
  }
  openExternal = async (value: string): Promise<void> => {
    const url = new URL(value)
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password)
      throw new Error('This link type is not supported.')
    if (url.protocol === 'mailto:') this.emit({ type: 'mailto', url: value })
    else await shell.openExternal(url.toString())
  }
  setSettings = async (input: Settings) => {
    // Read status: a changed Worker address is remembered, so its images stay blocked.
    const readStatus = rememberWorkerUrl(this.settings.readStatus, input.readStatus)
    const settings: Settings = readStatus ? { ...input, readStatus } : input
    await this.store.write('settings', settings)
    if (!settings.remoteImages) this.senderAvatars.clear()
    if (this.settings.autoCopyAuth === false && settings.autoCopyAuth !== false) {
      // Re-enabling applies to future arrivals, including mail beyond the visible page.
      for (const baseline of this.authArrivals.values()) baseline.since = Date.now()
    }
    const readStatusChanged =
      JSON.stringify(this.settings.readStatus) !== JSON.stringify(settings.readStatus)
    this.settings = settings
    if (readStatusChanged) void this.collector.collectNow() // Read status
    this.reminders.invalidate() // Reminders
    return settings
  }
  // Read status
  readStatus = async (requests: ReadStatusRequest[]): Promise<(ReadStatusLookup | null)[]> => {
    const password = this.readStatusSecret.get()
    const on = this.settings.readStatus?.enabled !== false
    if (!on || !password || !workerBase(this.settings.readStatus?.workerUrl))
      return requests.map(() => null)
    return requests.map(({ messageId, recipients }) => {
      if (!isTrackedMessageId(password, messageId)) return null
      // Automated recipients got no image, so they get no status row.
      const emails = [...new Set(recipients.map((r) => r.trim().toLowerCase()))].filter(
        (email) => !isAutomatedAddress(email),
      )
      return {
        recipients: emails.map((email) => ({
          email,
          fetches: this.collector.fetches(imageCode(password, messageId, email)),
        })),
      }
    })
  }
  readStatusInfo = async (): Promise<ReadStatusInfo> => {
    const { lastCollectedAt, error } = this.collector.info()
    return {
      passwordSet: !!this.readStatusSecret.get(),
      secureStorage: secureStorageAvailable(),
      ...(lastCollectedAt && { lastCollectedAt }),
      ...(error && { error }),
    }
  }
  setReadStatusPassword = async (password: string | null): Promise<ReadStatusInfo> => {
    await this.readStatusSecret.set(password)
    this.emit({ type: 'readStatus' })
    void this.collector.collectNow()
    return this.readStatusInfo()
  }
  testReadStatus = async (workerUrl: string, password?: string) => {
    // The saved password only ever goes to the saved address.
    const saved = workerBase(this.settings.readStatus?.workerUrl)
    const tested = workerBase(workerUrl)
    if (!password && tested && tested !== saved)
      return { ok: false, message: 'Enter the password for this address.' }
    const given = password || this.readStatusSecret.get()
    if (!given) return { ok: false, message: 'Enter the password first.' }
    return testWorker(workerUrl, given, this.options.readStatusFetch)
  }
  diagnostics = async () =>
    JSON.stringify(
      {
        version: app.getVersion(),
        platform: process.platform,
        electron: process.versions.electron,
        secureStorage: secureStorageAvailable(),
        accounts: this.accounts.map((a, index) => ({
          index,
          protocol: a.protocol || 'jmap',
          status: a.status,
          outgoing: a.outgoingError ? 'error' : 'ok',
          indexing: a.indexing
            ? { indexed: a.indexing.indexed, total: a.indexing.total }
            : undefined,
        })),
        submissions: [...this.journals.values()].map((j) => ({
          state: j.state,
          sentCopy: j.sentCopy,
        })),
        events: this.logs,
      },
      null,
      2,
    )
  private messageAuthCandidate(message: Message) {
    if (
      message.keywords.$draft ||
      (message.security &&
        ['locked', 'missingKey', 'integrityFailure'].includes(message.security.state)) ||
      message.security?.signature === 'invalid' ||
      /-----BEGIN PGP MESSAGE-----/.test(message.text || '')
    )
      return undefined
    return selectAuthCandidate(message)
  }
  /** Track message IDs rather than conversation timestamps (which can tie or contain old mail). */
  private authArrivalMessages(account: Account, messages: Message[], inboxIds: Set<string>) {
    const now = Date.now(),
      cutoff = now - 5 * 60_000
    let baseline = this.authArrivals.get(account.id)
    const initial = !baseline
    if (!baseline) {
      baseline = { since: Math.floor(now / 1000) * 1000, seen: new Map() }
      this.authArrivals.set(account.id, baseline)
    }
    for (const [id, at] of baseline.seen) if (at < cutoff) baseline.seen.delete(id)
    const arrivals: Message[] = []
    for (const message of messages) {
      const at = Date.parse(message.receivedAt)
      if (!Number.isFinite(at) || at < cutoff || at > now + 60_000) continue
      const seen = baseline.seen.has(message.id)
      baseline.seen.set(message.id, at)
      if (
        !initial &&
        !seen &&
        at > baseline.since &&
        !message.keywords.$draft &&
        Object.keys(message.mailboxIds).some((id) => inboxIds.has(id) && message.mailboxIds[id])
      )
        arrivals.push(message)
    }
    return arrivals.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
  }
  private authNotification(account: Account, message: Message, title: string, body: string) {
    if (!Notification.isSupported()) return
    try {
      const notification = new Notification({ title, body, silent: false })
      notification.on('click', () =>
        this.emit({ type: 'open', accountId: account.id, threadId: message.threadId }),
      )
      // Notification errors must not change the account's connection status or log secrets.
      notification.on('failed', () => this.log('auth-notification-failed'))
      notification.show()
    } catch {
      this.log('auth-notification-failed')
    }
  }
  private async copyIncomingAuth(provider: MailProvider, account: Account, arrivals: Message[]) {
    if (this.settings.autoCopyAuth === false || !arrivals.length || this.disposed) return undefined
    let selected: { message: Message; candidate: AuthCandidate } | undefined
    // Limit body work to fresh arrivals; fetching never marks them as read or opens a URL.
    for (const arrival of arrivals) {
      try {
        let [message] = await provider.messages(account, [arrival.id], true)
        if (!message) continue
        if (provider.rawMessage) {
          const raw = await provider.rawMessage(account, message.id, maxMessageBytes)
          message = await this.encryption.read(message, raw)
        }
        const candidate = this.messageAuthCandidate(message)
        if (candidate) {
          selected = { message, candidate }
          break
        }
      } catch {
        this.log('auth-extraction-failed')
      }
    }
    if (!selected) return undefined
    const { message, candidate } = selected
    const copy = this.authCopyQueue.then(async () => {
      const at = Date.parse(message.receivedAt)
      // Recheck after asynchronous body/decryption work and while waiting behind another account.
      if (
        this.disposed ||
        this.settings.autoCopyAuth === false ||
        at <= (this.authArrivals.get(account.id)?.since ?? Infinity) ||
        at < this.latestAuthCopy ||
        Date.now() - at > 5 * 60_000 ||
        this.providers.get(account.connectionId) !== provider ||
        !this.accounts.some((a) => a.id === account.id) ||
        (message.security?.encrypted && !this.encryption.vault.unlocked)
      )
        return undefined
      const label = candidate.type === 'code' ? 'code' : 'link'
      try {
        await clipboard.writeText(candidate.value)
        if ((await clipboard.readText()) !== candidate.value) throw new Error('Clipboard mismatch')
      } catch {
        this.log('auth-copy-failed')
        this.authNotification(
          account,
          message,
          `Couldn’t copy verification ${label}`,
          `${account.name} · Open the email to copy it manually.`,
        )
        return undefined
      }
      this.latestAuthCopy = at
      const sender = message.from[0]?.name || message.from[0]?.email || 'New email'
      this.authNotification(
        account,
        message,
        `Verification ${label} copied`,
        `${candidate.value}\n${sender} · ${account.name}`,
      )
      return message.threadId
    })
    this.authCopyQueue = copy.catch(() => {})
    return copy
  }
  async refreshConnection(id: string) {
    if (this.refreshing.has(id)) return
    this.refreshing.add(id)
    try {
      for (const account of this.accounts.filter((a) => a.connectionId === id)) {
        try {
          const { provider } = this.provider(account.id)
          const mailboxes = await provider.mailboxes(account)
          this.unreadCounts.set(
            account.id,
            mailboxes.filter((b) => b.role === 'inbox').reduce((sum, b) => sum + b.unreadEmails, 0),
          )
          this.emit({
            type: 'unread',
            count: [...this.unreadCounts.values()].reduce((sum, n) => sum + n, 0),
          })
          const page = await provider.query(account, { view: 'inbox' }, 0, 25)
          const authMessages = page.items.flatMap((conversation) => conversation.messages)
          // A burst of normal mail must not hide an authentication email behind the first page.
          let tail = page
          if (this.authArrivals.has(account.id) && this.settings.autoCopyAuth !== false) {
            const since = Math.max(
              this.authArrivals.get(account.id)!.since,
              Date.now() - 5 * 60_000,
            )
            while (
              tail.next !== undefined &&
              tail.items.length &&
              Date.parse(tail.items.at(-1)!.receivedAt) >= since
            ) {
              const next = await provider.query(account, { view: 'inbox' }, tail.next, 25)
              authMessages.push(...next.items.flatMap((conversation) => conversation.messages))
              if (next.next !== undefined && next.next <= tail.next) break
              tail = next
            }
          }
          const arrivals = this.authArrivalMessages(
            account,
            authMessages,
            new Set(mailboxes.filter((box) => box.role === 'inbox').map((box) => box.id)),
          )
          const copiedThread = await this.copyIncomingAuth(provider, account, arrivals)
          const current = page.items[0]?.receivedAt || new Date().toISOString(),
            previous = this.notificationBaseline.get(account.id)
          const newItems = previous
            ? page.items.filter((c) => c.receivedAt > previous && c.unread && c.id !== copiedThread)
            : []
          this.notificationBaseline.set(
            account.id,
            previous && previous > current ? previous : current,
          )
          if (
            previous &&
            newItems.length &&
            this.settings.notifications &&
            Notification.isSupported()
          ) {
            const notification = new Notification({
              title:
                newItems.length === 1
                  ? newItems[0].from[0]?.name || 'New email'
                  : newItems.length + ' new conversations',
              body: newItems.length === 1 ? newItems[0].subject : account.name,
              silent: false,
            })
            notification.on('click', () =>
              this.emit({ type: 'open', accountId: account.id, threadId: newItems[0].id }),
            )
            notification.show()
          }
          this.status(id, 'connected')
          this.emit({ type: 'changed', accountId: account.id })
        } catch (error) {
          this.status(
            id,
            error instanceof ProviderError && error.code === 'authentication'
              ? 'authentication'
              : 'offline',
            friendlyError(error),
          )
        }
      }
    } finally {
      this.refreshing.delete(id)
    }
  }
  private async syncPendingDrafts() {
    const pending = [...this.localDrafts.values()]
      .filter(
        (d) =>
          ['local', 'error'].includes(d.status) &&
          d.identityId &&
          !this.claimedBySend(d.id) &&
          d.errorKind !== 'conflict' &&
          !d.error?.includes('another client') &&
          this.accounts.some((a) => a.id === d.accountId && a.status === 'connected') &&
          Date.now() - Date.parse(d.updatedAt) > draftIdleMs,
      )
      .slice(0, 20)
    for (const draft of pending) {
      try {
        await this.syncDraft(draft)
      } catch {
        this.log('background-draft-sync-failed')
      }
    }
  }
  // Reminders
  /** Waking from sleep: providers learn their index may be stale, then a refresh as before. */
  async resume() {
    for (const provider of this.providers.values()) provider.resumed?.()
    await this.refresh()
  }
  async refresh() {
    await Promise.allSettled(
      this.connections.map(async (c) => {
        const connected = this.accounts.some(
          (a) => a.connectionId === c.id && a.status === 'connected',
        )
        // Rediscover advertised endpoints after outages or session changes. Never replay writes.
        if (this.providers.has(c.id) && connected) {
          await this.refreshConnection(c.id)
          await this.retrySentCopies(c.id)
        } else if (c.secret || c.localSecret || this.sessionSecrets.has(c.id))
          await this.reconnect(c.id)
      }),
    )
    await this.syncPendingDrafts()
  }
  dispose() {
    this.disposed = true
    this.reminders.dispose() // Reminders
    void this.encryption.lock()
    if (this.timer) clearInterval(this.timer)
    this.collector.stop() // Read status
    if (this.indexingEmit) clearTimeout(this.indexingEmit)
    for (const provider of this.providers.values()) {
      provider.dispose()
      void provider.close?.()
    }
  }
}
