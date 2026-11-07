import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  settingsSchema,
  undoSendChoices,
  undoSendOnQuit,
  undoSendSeconds,
} from '../packages/core/src'

describe('Undo send settings', () => {
  it('waits 10 seconds and sends anyway on quit unless changed', () => {
    expect(undoSendSeconds(defaultSettings)).toBe(10)
    expect(undoSendOnQuit(defaultSettings)).toBe('send')
  })
  it('offers Off, 5, 10, 20 and 30 seconds', () => {
    expect(undoSendChoices).toEqual([0, 5, 10, 20, 30])
    expect(undoSendSeconds({ ...defaultSettings, undoSendSeconds: 0 })).toBe(0)
    expect(undoSendSeconds({ ...defaultSettings, undoSendSeconds: 30 })).toBe(30)
  })
  it('treats a value that is not a choice as the default', () => {
    expect(undoSendSeconds({ ...defaultSettings, undoSendSeconds: 7 as never })).toBe(10)
  })
  it('keeps both settings through the settings schema and refuses other values', () => {
    const saved = settingsSchema.parse({
      ...defaultSettings,
      undoSendSeconds: 20,
      undoSendOnQuit: 'draft',
    })
    expect(saved).toMatchObject({ undoSendSeconds: 20, undoSendOnQuit: 'draft' })
    expect(() => settingsSchema.parse({ ...defaultSettings, undoSendSeconds: 7 })).toThrow()
    expect(() => settingsSchema.parse({ ...defaultSettings, undoSendOnQuit: 'ask' })).toThrow()
  })
})
