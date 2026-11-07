import { decryptSecret, encryptSecret, type JsonStore } from '../storage'

const name = 'read-status-secret'

/** The Worker password, shared by every tracked email; kept encrypted in secure storage. */
export class ReadStatusSecret {
  private password: string | undefined
  constructor(private readonly store: JsonStore) {}
  async load(): Promise<void> {
    const saved = await this.store.read<{ password?: string }>(name, {})
    this.password = saved.password ? decryptSecret(saved.password) : undefined
  }
  get(): string | undefined {
    return this.password
  }
  async set(password: string | null): Promise<void> {
    if (!password) {
      await this.store.write(name, {})
      this.password = undefined
      return
    }
    await this.store.write(name, { password: encryptSecret(password) })
    this.password = password
  }
}
