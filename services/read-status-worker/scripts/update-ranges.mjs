// Regenerates the googleRanges block of src/ranges.js from Google's published list.
// Run from this folder: node scripts/update-ranges.mjs   (Node 20 or newer, no dependencies)
// appleRanges is hand-kept and left untouched.
import { readFile, writeFile } from 'node:fs/promises'

const SOURCE = 'https://www.gstatic.com/ipranges/goog.json'
const target = new URL('../src/ranges.js', import.meta.url)
const BEGIN = '// BEGIN GOOGLE RANGES'
const END = '// END GOOGLE RANGES'

const response = await fetch(SOURCE)
if (!response.ok) throw new Error(`Could not fetch ${SOURCE}: ${response.status}`)
const list = await response.json()
const prefixes = [
  ...new Set(list.prefixes.map((entry) => entry.ipv4Prefix ?? entry.ipv6Prefix).filter(Boolean)),
]
if (prefixes.length === 0) throw new Error('goog.json had no prefixes; leaving ranges.js alone')

const today = new Date().toISOString().slice(0, 10)
const block = `${BEGIN}
/**
 * Google, from ${SOURCE} (list created ${list.creationTime ?? 'unknown'}).
 * Regenerate with \`node scripts/update-ranges.mjs\`. Last run ${today}.
 * @type {string[]}
 */
export const googleRanges = [
${prefixes.map((prefix) => `  '${prefix}',`).join('\n')}
]
${END}`

const text = await readFile(target, 'utf8')
const start = text.indexOf(BEGIN)
const end = text.indexOf(END)
if (start === -1 || end === -1 || end < start) throw new Error('Markers not found in ranges.js')
await writeFile(target, text.slice(0, start) + block + text.slice(end + END.length))
console.log(`Wrote ${prefixes.length} Google ranges to src/ranges.js`)
