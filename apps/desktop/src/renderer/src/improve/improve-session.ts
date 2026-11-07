import type { ImproveResult, ImproveStyle } from '@inlark/core'
import { changedFacts, type FactChange } from './changed-facts'
import { wordDiff, type DiffPart } from './word-diff'

export type ImproveSession =
  | { phase: 'closed' }
  | { phase: 'waiting'; id: string; style: ImproveStyle; original: string; partial: string }
  | {
      phase: 'preview'
      id: string
      style: ImproveStyle
      original: string
      text: string
      diff: DiffPart[]
      facts: FactChange[]
    }
  | { phase: 'error'; id: string; style: ImproveStyle; original: string; message: string }

export type ImproveAction =
  | { type: 'start'; id: string; style: ImproveStyle; original: string }
  | { type: 'partial'; id: string; text: string }
  | { type: 'result'; id: string; result: ImproveResult }
  | { type: 'close' }

/** Only the newest request may change the session; events from older requests are dropped. */
export function improveReducer(state: ImproveSession, action: ImproveAction): ImproveSession {
  switch (action.type) {
    case 'start':
      return {
        phase: 'waiting',
        id: action.id,
        style: action.style,
        original: action.original,
        partial: '',
      }
    case 'partial':
      if (state.phase !== 'waiting' || state.id !== action.id) return state
      return { ...state, partial: action.text }
    case 'result': {
      if (state.phase === 'closed' || state.id !== action.id) return state
      const { result } = action
      if (result.ok) {
        return {
          phase: 'preview',
          id: state.id,
          style: state.style,
          original: state.original,
          text: result.text,
          diff: wordDiff(state.original, result.text),
          facts: changedFacts(state.original, result.text),
        }
      }
      if (result.error === 'cancelled') return { phase: 'closed' }
      return {
        phase: 'error',
        id: state.id,
        style: state.style,
        original: state.original,
        message: result.message,
      }
    }
    case 'close':
      return { phase: 'closed' }
  }
}

export type ImproveUnavailableReason =
  'encrypted' | 'encryptionPending' | 'noKey' | 'empty' | 'locked'

/** Whether Improve can run. `hasKey` is undefined while the key status is still loading. */
export function improveAvailability(input: {
  protection: 'none' | 'encrypt' | 'sign'
  hasKey: boolean | undefined
  ownText: string
  locked: boolean
  /** Encryption may still be switched on for these recipients: see `encryptionUndecided`. */
  encryptionUndecided?: boolean
}): { available: true } | { available: false; reason: ImproveUnavailableReason } {
  if (input.locked) return { available: false, reason: 'locked' }
  if (input.protection === 'encrypt') return { available: false, reason: 'encrypted' }
  if (input.encryptionUndecided) return { available: false, reason: 'encryptionPending' }
  if (input.hasKey === false) return { available: false, reason: 'noKey' }
  if (!input.ownText.trim()) return { available: false, reason: 'empty' }
  return { available: true }
}

/**
 * Whether the draft may still turn encrypted on its own. The composer switches encryption on
 * when the recipients' keys recommend it, so text must not leave before that's settled.
 * `lookup` is the recipients' encryption check: off when it can't run (an address is invalid).
 */
export function encryptionUndecided(input: {
  hasRecipients: boolean
  lookup: 'off' | 'pending' | 'done' | 'failed'
  recommend: boolean
  /** Khyati picked a protection mode herself, so no recommendation will override it. */
  chosen: boolean
  protection: 'none' | 'encrypt' | 'sign'
}): boolean {
  if (input.protection === 'encrypt' || input.chosen) return false
  if (input.hasRecipients && input.lookup === 'pending') return true
  return input.lookup === 'done' && input.recommend
}

/** What a key press means in each phase of the session. */
export function previewKeyAction(
  phase: ImproveSession['phase'],
  key: string,
): 'accept' | 'keep' | 'cancel' | 'retry' | undefined {
  if (phase === 'preview') return key === 'Enter' ? 'accept' : key === 'Escape' ? 'keep' : undefined
  if (phase === 'waiting') return key === 'Escape' ? 'cancel' : undefined
  if (phase === 'error') return key === 'Enter' ? 'retry' : key === 'Escape' ? 'keep' : undefined
  return undefined
}
