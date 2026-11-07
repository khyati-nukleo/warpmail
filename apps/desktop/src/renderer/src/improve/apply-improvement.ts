import type { Editor, JSONContent } from '@tiptap/react'
import { ownRange, ownTextContent } from './draft-split'

/**
 * Replace the user's own text with the improved text in one undoable step.
 * Returns false, changing nothing, when the draft has no own text.
 */
export function acceptImprovement(editor: Editor, text: string): boolean {
  const range = ownRange(editor.state.doc)
  if (!range) return false
  const originalNodes: JSONContent[] = []
  editor.state.doc.forEach((node, offset) => {
    if (offset >= range.from && offset + node.nodeSize <= range.to)
      originalNodes.push(node.toJSON())
  })
  const nodes = ownTextContent(text, originalNodes).map((json) => editor.schema.nodeFromJSON(json))
  editor.view.dispatch(editor.state.tr.replaceWith(range.from, range.to, nodes))
  return true
}
