import type { JSONContent } from '@tiptap/react'

export interface DraftSplit {
  /** Leading empty paragraphs. */
  before: JSONContent[]
  /** The user's own text. */
  own: JSONContent[]
  /** Everything from the first quote, forward header or signature on. */
  rest: JSONContent[]
  /** The own part as plain text. */
  text: string
}

/** The part of a ProseMirror node that `ownRange` needs. */
interface DocumentLike {
  forEach(callback: (node: NodeLike, offset: number) => void): void
}
interface NodeLike {
  nodeSize: number
  toJSON(): JSONContent
}

const quoteHeader = /^On .+wrote:\s*$/s
const forwardHeaders = ['---------- Forwarded message ----------', '-----Original Message-----']

function inlineText(node: JSONContent): string {
  if (node.type === 'hardBreak') return '\n'
  if (node.text !== undefined) return node.text
  return (node.content || []).map(inlineText).join('')
}

function isEmptyParagraph(node: JSONContent): boolean {
  return node.type === 'paragraph' && !node.attrs?.signature && !inlineText(node).trim()
}

function isQuoteIntro(node: JSONContent | undefined): boolean {
  return node?.type === 'paragraph' && quoteHeader.test(inlineText(node))
}

function isBoundary(node: JSONContent): boolean {
  if (node.type === 'signature' || node.type === 'blockquote') return true
  if (node.type !== 'paragraph') return false
  if (node.attrs?.signature) return true
  const text = inlineText(node)
  return quoteHeader.test(text) || forwardHeaders.some((header) => text.startsWith(header))
}

/** Where the leading blanks end and the own text ends, as indexes into the top-level nodes. */
function boundaries(content: JSONContent[]): { start: number; end: number } {
  let stop = content.findIndex(isBoundary)
  if (stop < 0) stop = content.length
  else if (content[stop].type === 'blockquote' && stop > 0 && isQuoteIntro(content[stop - 1]))
    stop--
  let start = 0
  while (start < stop && isEmptyParagraph(content[start])) start++
  let end = stop
  while (end > start && isEmptyParagraph(content[end - 1])) end--
  // Only blanks before the boundary: they all stay in front.
  return end === start ? { start: stop, end: stop } : { start, end }
}

function listItemText(item: JSONContent): string {
  return (item.content || []).map(inlineText).join('\n')
}

function blockText(node: JSONContent): string {
  if (node.type === 'bulletList' || node.type === 'orderedList') {
    return (node.content || [])
      .map(
        (item, index) =>
          `${node.type === 'bulletList' ? '-' : index + 1 + '.'} ${listItemText(item)}`,
      )
      .join('\n')
  }
  return inlineText(node)
}

/** Split a composer document into the user's own text and the parts that are never sent. */
export function splitDraft(doc: JSONContent): DraftSplit {
  const content = doc.content || []
  const { start, end } = boundaries(content)
  const own = content.slice(start, end)
  return {
    before: content.slice(0, start),
    own,
    rest: content.slice(end),
    text: own
      .map(blockText)
      .filter((block) => block.trim())
      .join('\n\n'),
  }
}

/** Put the improved own nodes between the untouched leading blanks and the rest. */
export function joinDraft(split: DraftSplit, own: JSONContent[]): JSONContent {
  return { type: 'doc', content: [...split.before, ...own, ...split.rest] }
}

interface Run {
  text: string
  marks: NonNullable<JSONContent['marks']>
}
interface Range extends Run {
  start: number
  end: number
}

const keptMarks = new Set(['bold', 'italic', 'link'])

function markedRuns(nodes: JSONContent[]): Run[] {
  const runs: Run[] = []
  const visit = (node: JSONContent) => {
    const marks = (node.marks || []).filter((mark) => keptMarks.has(mark.type))
    if (node.text && marks.length) runs.push({ text: node.text, marks })
    node.content?.forEach(visit)
  }
  nodes.forEach(visit)
  return runs
}

/** Each marked run goes on the first place its exact text occurs, unless that overlaps another. */
function placeRuns(block: string, runs: Run[]): Range[] {
  const ranges: Range[] = []
  for (const run of runs) {
    const start = block.indexOf(run.text)
    if (start < 0) continue
    const end = start + run.text.length
    if (ranges.some((range) => start < range.end && end > range.start)) continue
    ranges.push({ ...run, start, end })
  }
  return ranges.sort((a, b) => a.start - b.start)
}

/** Inline nodes for block[from, to), with hard breaks for newlines and the placed marks. */
function inline(block: string, from: number, to: number, ranges: Range[]): JSONContent[] {
  const nodes: JSONContent[] = []
  const push = (start: number, end: number, marks?: Run['marks']) => {
    block
      .slice(start, end)
      .split('\n')
      .forEach((text, index) => {
        if (index) nodes.push({ type: 'hardBreak' })
        if (text) nodes.push(marks ? { type: 'text', text, marks } : { type: 'text', text })
      })
  }
  let at = from
  for (const range of ranges) {
    if (range.start < at || range.end > to) continue
    push(at, range.start)
    push(range.start, range.end, range.marks)
    at = range.end
  }
  push(at, to)
  return nodes
}

/** The improved text as composer nodes, keeping bold, italic and links where their text survived. */
export function ownTextContent(text: string, original: JSONContent[]): JSONContent[] {
  const runs = markedRuns(original)
  return text
    .split(/\n{2,}/)
    .filter((block) => block.trim())
    .map((block): JSONContent => {
      const ranges = placeRuns(block, runs)
      const lines = block.split('\n')
      const kind = lines.every((line) => line.startsWith('- '))
        ? 'bulletList'
        : lines.every((line) => /^\d+\. /.test(line))
          ? 'orderedList'
          : undefined
      if (!kind) return { type: 'paragraph', content: inline(block, 0, block.length, ranges) }
      let offset = 0
      const items = lines.map((line): JSONContent => {
        const from = offset + (kind === 'bulletList' ? 2 : line.indexOf(' ') + 1)
        offset += line.length + 1
        return {
          type: 'listItem',
          content: [{ type: 'paragraph', content: inline(block, from, offset - 1, ranges) }],
        }
      })
      return { type: kind, content: items }
    })
}

/** Document positions covering the own text, or undefined when there is none. */
export function ownRange(doc: DocumentLike): { from: number; to: number } | undefined {
  const nodes: { json: JSONContent; from: number; to: number }[] = []
  doc.forEach((node, offset) =>
    nodes.push({ json: node.toJSON(), from: offset, to: offset + node.nodeSize }),
  )
  const { start, end } = boundaries(nodes.map((node) => node.json))
  if (start >= end) return undefined
  return { from: nodes[start].from, to: nodes[end - 1].to }
}
