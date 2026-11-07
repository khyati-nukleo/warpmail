import { useEffect, useReducer, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Editor } from '@tiptap/react'
import { improveErrorMessages, type ImproveResult, type ImproveStyle } from '@inlark/core'
import { api } from '../api'
import type { Protection } from '../ComposerProtection'
import { splitDraft } from './draft-split'
import {
  improveAvailability,
  improveReducer,
  type ImproveUnavailableReason,
} from './improve-session'
import { acceptImprovement } from './apply-improvement'

/** What the composer says when Improve can't run. Locked needs no words: the toolbar is off. */
export const unavailableLines: Partial<Record<ImproveUnavailableReason, string>> = {
  empty: 'Write something first, then improve it.',
  encrypted: 'Improve is off for encrypted messages.',
  noKey: 'Improve needs an Anthropic API key.',
}

const failed: ImproveResult = { ok: false, error: 'failed', message: improveErrorMessages.failed }

/** The composer's Improve session: asks main for a rewrite and applies it once accepted. */
export function useImprove({
  editor,
  protection,
  locked,
}: {
  editor: Editor | null
  protection: Protection
  locked: boolean
}) {
  const queryClient = useQueryClient()
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => api.aiStatus() })
  const hasKey = status.data?.hasKey
  const [session, dispatch] = useReducer(improveReducer, { phase: 'closed' })
  // The line shown under the toolbar after Improve was asked for but couldn't run.
  const [notice, setNotice] = useState<ImproveUnavailableReason>()
  // The request main is still working on, so it can be cancelled.
  const pending = useRef<string | undefined>(undefined)
  const open = session.phase !== 'closed'
  const availability = improveAvailability({
    protection,
    hasKey,
    ownText: editor ? splitDraft(editor.getJSON()).text : '',
    locked,
  })

  const cancelPending = () => {
    const id = pending.current
    pending.current = undefined
    if (id) void api.cancelImprove(id).catch(() => {})
  }

  const start = (style: ImproveStyle) => {
    if (!editor) return
    const { text } = splitDraft(editor.getJSON())
    const check = improveAvailability({ protection, hasKey, ownText: text, locked })
    if (!check.available) {
      if (check.reason !== 'locked') setNotice(check.reason)
      return
    }
    setNotice(undefined)
    // Main cancels the previous request when this one starts; the session ignores its events.
    const id = crypto.randomUUID()
    pending.current = id
    dispatch({ type: 'start', id, style, original: text })
    void api
      .improveDraft({ id, text, style })
      .catch(() => failed)
      .then((result) => {
        if (pending.current === id) pending.current = undefined
        dispatch({ type: 'result', id, result })
        // Main has recorded this request's use, so Settings → AI shows this month's count.
        void queryClient.invalidateQueries({ queryKey: ['ai-status'] })
      })
  }

  const accept = () => {
    if (session.phase !== 'preview' || !editor) return
    // One transaction: the editor's own update handler saves it, and one undo restores the original.
    acceptImprovement(editor, session.text)
    dispatch({ type: 'close' })
  }

  const keep = () => {
    cancelPending()
    dispatch({ type: 'close' })
  }

  const retry = () => {
    if (session.phase === 'error') start(session.style)
  }

  // Text as it streams in; the session drops anything from an older request.
  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.type === 'improve') dispatch({ type: 'partial', id: event.id, text: event.text })
      }),
    [],
  )

  // Closing the composer stops a request that is still running.
  useEffect(() => cancelPending, [])

  // Improve is off for encrypted mail, so turning encryption on ends the session.
  useEffect(() => {
    if (protection !== 'encrypt') return
    cancelPending()
    dispatch({ type: 'close' })
  }, [protection])

  useEffect(() => {
    setNotice(undefined)
  }, [protection, hasKey])
  useEffect(() => {
    if (!editor) return
    const clear = () => setNotice(undefined)
    editor.on('update', clear)
    return () => {
      editor.off('update', clear)
    }
  }, [editor])

  // Back to the editor when the preview closes, once it is visible and editable again, so
  // Ctrl+Z works at once after accepting.
  const wasOpen = useRef(false)
  useEffect(() => {
    const closed = wasOpen.current && !open
    wasOpen.current = open
    if (!closed || !editor) return
    const frame = requestAnimationFrame(() => editor.commands.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, editor])

  return { session, availability, hasKey, notice, start, accept, keep, retry }
}

export type Improve = ReturnType<typeof useImprove>
