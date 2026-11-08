import type { Address, AddressSeen, ReminderFacts, ReminderLabel, SplitScope } from '@inlark/core'

/**
 * Persistent IMAP metadata, injected into the provider. The desktop app implements this with
 * SQLite in a worker thread; tests may run the same implementation in-process.
 *
 * Every method is scoped by `accountId`. Rows from different accounts never interact: threads,
 * Message-ID lookups and aliases are all per account.
 *
 * IDs are opaque, stable application IDs. A message ID identifies one message at one location
 * (mailbox + UIDVALIDITY + UID); `relocate` moves an ID after a confirmed server move. A
 * Message-ID header is never used to locate a message for a mutation.
 */
export interface MetadataIndex {
  close(): Promise<void>

  /**
   * Reconciles the server's folder list. Existing paths keep their IDs; new paths get new IDs;
   * paths no longer listed are removed together with their messages. Returns all mailboxes.
   */
  syncMailboxes(accountId: string, folders: FolderListing[]): Promise<IndexedMailbox[]>
  listMailboxes(accountId: string): Promise<IndexedMailbox[]>
  /** Keeps the mailbox ID (and its messages) when this app renames a folder. */
  renameMailbox(accountId: string, mailboxId: string, path: string, name: string): Promise<void>
  updateMailbox(accountId: string, mailboxId: string, patch: MailboxStatePatch): Promise<void>
  /**
   * Called when UIDVALIDITY changed: every stored location in the mailbox is stale, so its
   * messages are removed and indexing restarts. Threads and aliases stay.
   */
  resetMailbox(accountId: string, mailboxId: string, uidValidity: string): Promise<void>

  /**
   * Inserts or updates messages by location. A new location gets a new ID and a thread; an
   * existing location keeps its ID and has flags, modseq, preview and server identity refreshed.
   * Server identity may join threads, but never replaces a location used for mutations.
   * Returns the ID for each input, in order.
   */
  upsertMessages(accountId: string, messages: NewMessage[]): Promise<string[]>
  updateFlags(
    accountId: string,
    mailboxId: string,
    updates: { uid: number; flags: string[]; modseq?: string }[],
  ): Promise<void>
  /** Removes messages that no longer exist at these UIDs (expunged or vanished). */
  removeUids(accountId: string, mailboxId: string, uids: number[]): Promise<void>
  /** Removes messages by ID, e.g. after a confirmed deletion. */
  removeMessages(accountId: string, ids: string[]): Promise<void>
  /** All stored UIDs for a mailbox, ascending. Used to detect expunges during reconciliation. */
  knownUids(accountId: string, mailboxId: string): Promise<number[]>
  /** Moves an existing ID to a new location after the server confirmed the move. */
  relocate(accountId: string, id: string, location: MessageLocation): Promise<void>
  setPreview(accountId: string, id: string, preview: string): Promise<void>
  /** Messages of a mailbox whose List-Id, Precedence and Auto-Submitted were never read, newest first. */
  uncheckedHeaders(
    accountId: string,
    mailboxId: string,
    limit: number,
  ): Promise<{ uid: number; uidValidity: string }[]>
  /** Stores the fetched automation headers, marks them checked and recomputes `automated`. */
  setAutomationHeaders(
    accountId: string,
    mailboxId: string,
    uidValidity: string,
    rows: {
      uid: number
      listId: string | null
      precedence: string | null
      autoSubmitted: string | null
    }[],
  ): Promise<void>

  /** Messages by ID, in no particular order. Unknown IDs are skipped. */
  messages(accountId: string, ids: string[]): Promise<IndexedMessage[]>
  /** Messages at these UIDs of one mailbox. */
  messagesAt(accountId: string, mailboxId: string, uids: number[]): Promise<IndexedMessage[]>
  /** Every message of these conversations, following aliases of merged threads. */
  threadMessages(accountId: string, threadIds: string[]): Promise<IndexedMessage[]>
  /** The current ID for a thread ID that may have been merged into another. */
  resolveThread(accountId: string, threadId: string): Promise<string>
  /** Messages whose Message-ID header matches, optionally within one mailbox. */
  findByMessageId(
    accountId: string,
    messageId: string,
    mailboxId?: string,
  ): Promise<IndexedMessage[]>

  /**
   * Conversations with at least one message matching `filter`, newest first by the latest
   * matching message. `after` continues from the last item of a previous page (keyset
   * pagination), so rows indexed meanwhile cannot shift or duplicate what was already shown.
   */
  conversations(
    accountId: string,
    filter: ConversationFilter,
    page: { limit: number; offset?: number; after?: ConversationCursor },
  ): Promise<{ items: ConversationRow[]; total: number }>
  /**
   * Conversations and unread emails per tab, in one query. `conversations` counts threads with an
   * inbox message in the tab; `unread` counts unseen inbox emails, each server identity once.
   */
  tabCounts(
    accountId: string,
    inboxId: string,
    scopes: Record<string, SplitScope>,
  ): Promise<Record<string, { conversations: number; unread: number }>>
  /**
   * From and To addresses on mail received after `sinceMs` in these mailboxes, whose address or
   * name contains `term` (lowercase; empty for all), most emails first, for rule suggestions.
   */
  addressesSeen(
    accountId: string,
    mailboxIds: string[],
    sinceMs: number,
    term: string,
  ): Promise<AddressSeen[]>
  // Reminders
  /** Per recent thread, what reminders are derived from: its latest message from a person. */
  reminderFacts(accountId: string, query: ReminderFactsQuery): Promise<ReminderFacts[]>
  /** Sent mail since `sinceMs` with a Message-ID and no stored ask-check, newest first. */
  askChecksNeeded(
    accountId: string,
    sentId: string,
    sinceMs: number,
    limit: number,
  ): Promise<{ id: string; messageId: string }[]>
  /** Stores ask-checks by Message-ID, so Gmail's copies share one answer. */
  setAskChecks(accountId: string, rows: { messageId: string; asks: boolean }[]): Promise<void>
  /** Total and unread message counts stored for the account, for progress reporting. */
  counts(accountId: string): Promise<{ messages: number }>

  getMeta(accountId: string, key: string): Promise<string | undefined>
  setMeta(accountId: string, key: string, value: string | undefined): Promise<void>

  /**
   * Original sources kept on disk so recent mail opens without the server. An entry is keyed by
   * the server identity when known (Gmail's copies share one), otherwise by location. It is
   * dropped when its email is gone from every indexed location, so a removed message or a
   * UIDVALIDITY reset takes it along. Only what the server sent is stored, never decrypted text.
   */
  storedSource(accountId: string, message: SourceLocation): Promise<Uint8Array | undefined>
  /**
   * Stores sources of messages still indexed, then drops the oldest mail (by received date)
   * until the account's sources fit in `limitBytes`. Returns the locations written; the rest
   * were removed meanwhile or would only have been evicted at once.
   */
  storeSources(
    accountId: string,
    sources: { message: SourceLocation & { receivedAt: string }; raw: Uint8Array }[],
    limitBytes: number,
  ): Promise<MessageLocation[]>
  /** Messages worth storing next, newest first: unstored, recent, small, and not evicted at once. */
  sourceCandidates(accountId: string, filter: SourceCandidateFilter): Promise<IndexedMessage[]>
}

export interface SourceLocation extends MessageLocation {
  emailId?: string
}

export interface SourceCandidateFilter {
  mailboxIds: string[]
  /** ISO date; only mail received at or after it. */
  after: string
  /** Largest RFC822.SIZE to include. */
  maxSize: number
  limit: number
  /** The store's cap: older mail that would only be evicted again is left out. */
  limitBytes: number
  /** Message IDs to skip, e.g. ones that could not be downloaded this session. */
  exclude?: string[]
}

export interface FolderListing {
  path: string
  name: string
  delimiter: string
  parentPath: string | null
  /** The server-declared special-use flag, e.g. `\\Sent`. Never guessed from a name. */
  specialUse: string | null
  /** A flag the client library guessed from the name; kept separate so it can be reviewed. */
  guessedSpecialUse: string | null
  /** The folder cannot hold messages (`\\Noselect` / `\\NonExistent`). */
  noSelect: boolean
}

export interface IndexedMailbox extends FolderListing {
  id: string
  uidValidity: string | null
  uidNext: number | null
  highestModseq: string | null
  total: number
  unread: number
  /**
   * Every UID at or above this, up to `uidNext` at the last sync, is indexed. `null` means
   * nothing is indexed yet. Historical indexing walks this down towards 1.
   */
  indexedFrom: number | null
  /** Historical indexing reached UID 1. */
  complete: boolean
}

export type MailboxStatePatch = Partial<
  Pick<
    IndexedMailbox,
    'uidValidity' | 'uidNext' | 'highestModseq' | 'total' | 'unread' | 'indexedFrom' | 'complete'
  >
>

export interface MessageLocation {
  mailboxId: string
  uidValidity: string
  uid: number
}

export interface NewMessage extends MessageLocation {
  modseq?: string
  /** Account-wide server identity; unlike Message-ID, safe for display deduplication. */
  emailId?: string
  /** Without angle brackets. `null` when the header is missing or unusable. */
  messageId: string | null
  inReplyTo: string[]
  /** Oldest first, as in the header; the index may keep only the most recent entries. */
  references: string[]
  subject: string
  from: Address[]
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  /** ISO 8601 INTERNALDATE. */
  receivedAt: string
  sentAt?: string
  size: number
  flags: string[]
  hasAttachment: boolean
  preview: string
  /** The server's BODYSTRUCTURE, kept to find body parts and attachments later. */
  bodyStructure?: BodyPart
  unsubscribe?: { url: string; oneClick: boolean }
  /** Present when List-Id, Precedence and Auto-Submitted were fetched for this message. */
  automation?: { listId: string | null; precedence: string | null; autoSubmitted: string | null }
  autoSubmitted?: string | null // Read status: read back from the stored header
}

export interface IndexedMessage extends NewMessage {
  id: string
  threadId: string
}

/** A trimmed BODYSTRUCTURE node. `part` is the IMAP section number, e.g. `1.2`. */
export interface BodyPart {
  part?: string
  type: string
  parameters?: Record<string, string>
  id?: string
  encoding?: string
  size?: number
  disposition?: string
  dispositionParameters?: Record<string, string>
  childNodes?: BodyPart[]
}

export interface ConversationFilter {
  /** Only messages in these mailboxes. */
  mailboxIds?: string[]
  /** Never messages in these mailboxes (e.g. Junk and Trash for “All mail”). */
  excludeMailboxIds?: string[]
  /** Only these message IDs, e.g. server search results. */
  ids?: string[]
  flagged?: boolean
  unseen?: boolean
  hasAttachment?: boolean
  /** ISO dates, inclusive lower and exclusive upper bound on `receivedAt`. */
  after?: string
  before?: string
  /** Only conversations in this tab. Needs exactly one `mailboxIds` entry: the inbox. */
  split?: SplitScope
  // Reminders
  /** Threads in the result sort by `sortMs` (ms) when it is after their latest date; adds none. */
  boost?: { threadId: string; sortMs: number }[]
}

export interface ConversationCursor {
  receivedAt: string
  threadId: string
  // Reminders
  /** The row's boosted sort time, when it had one. */
  sortMs?: number
}

export interface ConversationRow {
  threadId: string
  /** The newest message matching the filter, which represents the conversation in lists. */
  latest: IndexedMessage
  /** Emails in the whole conversation, matching or not, counting each server identity once. */
  count: number
  // Reminders
  /** Set only when a boost moved the row: the time it sorts by. */
  sortMs?: number
}

// Reminders
export interface ReminderFactsQuery {
  inboxId: string
  /** The archive role's folder: returns move mail back from it. */
  archiveId?: string
  /** Mailboxes whose messages count: not Drafts, Trash, Junk or the label folders. */
  mailboxIds: string[]
  labelIds: Partial<Record<ReminderLabel, string>>
  important: Extract<SplitScope, { kind: 'important' }>
  /** Threads with mail in `mailboxIds` since then; older ones only when in `threadIds`. */
  sinceMs: number
  threadIds?: string[]
  /** Emails with a copy here are unsent drafts (Gmail lists them in All Mail too). */
  draftsId?: string
  /** My addresses, lowercase: what tells my messages from everyone else's. */
  own?: string[]
}
