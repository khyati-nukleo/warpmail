import type { IndexedMessage } from './metadata-index'

export type SourceKey = Pick<IndexedMessage, 'id' | 'mailboxId' | 'uidValidity' | 'uid'> & {
  emailId?: string
}
/**
 * Full sources downloaded to read a message, kept so its original is never fetched twice.
 * Bounded by total size, and no single message may take more than `entryLimit` (a quarter of
 * the cache by default); the least recently used are dropped first. An entry answers for the
 * exact server location it was read from or, when the server reports one, for every location
 * of the same server identity (Gmail shows one email under each of its labels).
 */
export class SourceCache {
  private entries = new Map<string, { key: SourceKey; raw: Uint8Array }>()
  private bytes = 0
  constructor(
    private limit = 64 * 1024 * 1024,
    private entryLimit = limit / 4,
  ) {}
  get size() {
    return this.entries.size
  }
  private static slot(row: SourceKey) {
    return row.emailId ? 'e:' + row.emailId : 'i:' + row.id
  }
  get(row: SourceKey): Uint8Array | undefined {
    const slot = SourceCache.slot(row)
    const entry = this.entries.get(slot)
    if (!entry) return undefined
    const at = entry.key
    if (
      !row.emailId &&
      (at.mailboxId !== row.mailboxId || at.uidValidity !== row.uidValidity || at.uid !== row.uid)
    )
      return undefined
    this.entries.delete(slot)
    this.entries.set(slot, entry)
    return entry.raw
  }
  set(row: SourceKey, raw: Uint8Array) {
    this.drop(SourceCache.slot(row))
    if (raw.length > this.entryLimit || raw.length > this.limit) return
    const { id, mailboxId, uidValidity, uid, emailId } = row
    this.entries.set(SourceCache.slot(row), {
      key: { id, mailboxId, uidValidity, uid, ...(emailId ? { emailId } : {}) },
      raw,
    })
    this.bytes += raw.length
    for (const oldest of this.entries.keys()) {
      if (this.bytes <= this.limit) break
      this.drop(oldest)
    }
  }
  private drop(slot: string) {
    const entry = this.entries.get(slot)
    if (!entry) return
    this.bytes -= entry.raw.length
    this.entries.delete(slot)
  }
  private dropWhere(test: (key: SourceKey) => boolean) {
    for (const [slot, entry] of [...this.entries]) if (test(entry.key)) this.drop(slot)
  }
  /** Drops the entries read from these message IDs. */
  delete(ids: string[]) {
    if (!ids.length) return
    const gone = new Set(ids)
    this.dropWhere((key) => gone.has(key.id))
  }
  /** Drops a folder's entries, or only those at the given UIDs. */
  forget(mailboxId: string, uids?: number[]) {
    const gone = uids && new Set(uids)
    this.dropWhere((key) => key.mailboxId === mailboxId && (!gone || gone.has(key.uid)))
  }
}
