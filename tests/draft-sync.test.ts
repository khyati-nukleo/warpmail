import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverSaves } from '../apps/desktop/src/renderer/src/draft-sync'

const held = () => {
  const pending: (() => void)[] = []
  const save = vi.fn(() => new Promise<void>((resolve) => pending.push(resolve)))
  const finish = async () => {
    pending.shift()?.()
    await vi.advanceTimersByTimeAsync(0)
  }
  return { save, finish }
}

describe('server draft saves', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  it('saves once, 10 seconds after the last edit', async () => {
    const save = vi.fn(async () => {})
    const saves = serverSaves(save)
    saves.schedule()
    await vi.advanceTimersByTimeAsync(3000)
    saves.schedule()
    await vi.advanceTimersByTimeAsync(3000)
    saves.schedule()
    await vi.advanceTimersByTimeAsync(9999)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(save).toHaveBeenCalledTimes(1)
  })
  it('follows a save in progress with one trailing save, however many pauses occur', async () => {
    const { save, finish } = held()
    const saves = serverSaves(save)
    saves.schedule()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(save).toHaveBeenCalledTimes(1)
    for (let pause = 0; pause < 3; pause++) {
      saves.schedule()
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(save).toHaveBeenCalledTimes(1)
    await finish()
    expect(save).toHaveBeenCalledTimes(2)
    await finish()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(save).toHaveBeenCalledTimes(2)
  })
  it('keeps saving after a failed save', async () => {
    const save = vi.fn(async () => {
      throw new Error('Offline')
    })
    const saves = serverSaves(save)
    saves.schedule()
    await vi.advanceTimersByTimeAsync(10_000)
    saves.schedule()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(save).toHaveBeenCalledTimes(2)
  })
  it('cancels a save that was due and says so', async () => {
    const save = vi.fn(async () => {})
    const saves = serverSaves(save)
    expect(saves.cancel()).toBe(false)
    saves.schedule()
    expect(saves.cancel()).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(save).not.toHaveBeenCalled()
    expect(saves.cancel()).toBe(false)
  })
  it('cancels a trailing save but lets the save in progress finish', async () => {
    const { save, finish } = held()
    const saves = serverSaves(save)
    saves.schedule()
    await vi.advanceTimersByTimeAsync(10_000)
    saves.schedule()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(saves.cancel()).toBe(true)
    let settled = false
    void saves.settled().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await finish()
    expect(settled).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
  })
  it('is settled immediately when no save is in progress', async () => {
    const saves = serverSaves(vi.fn(async () => {}))
    saves.schedule()
    let settled = false
    void saves.settled().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
  })
})
