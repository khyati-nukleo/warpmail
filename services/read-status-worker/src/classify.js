import { appleRanges, googleRanges } from './ranges.js'

/**
 * Parse an IPv4 address into a 32-bit number.
 * @param {string} text
 * @returns {bigint | null}
 */
function parseV4(text) {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = (value << 8n) | BigInt(n)
  }
  return value
}

/**
 * Parse an IPv6 address into a 128-bit number.
 * @param {string} text
 * @returns {bigint | null}
 */
function parseV6(text) {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || (text.match(/::/g) ?? []).length > 1) return null
  let head = text
  let tail = ''
  const gap = text.indexOf('::')
  if (gap !== -1) {
    head = text.slice(0, gap)
    tail = text.slice(gap + 2)
  }
  /** @param {string} side @returns {number[] | null} */
  const groups = (side) => {
    if (side === '') return []
    const out = []
    const pieces = side.split(':')
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]
      if (piece.includes('.')) {
        if (i !== pieces.length - 1) return null
        const v4 = parseV4(piece)
        if (v4 === null) return null
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn))
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null
        out.push(parseInt(piece, 16))
      }
    }
    return out
  }
  const left = groups(head)
  const right = groups(tail)
  if (!left || !right) return null
  const missing = 8 - left.length - right.length
  if (gap === -1 ? missing !== 0 : missing < 1) return null
  const all = [...left, ...new Array(gap === -1 ? 0 : missing).fill(0), ...right]
  let value = 0n
  for (const group of all) value = (value << 16n) | BigInt(group)
  return value
}

/**
 * Parse an address; IPv4-mapped IPv6 (::ffff:a.b.c.d) becomes IPv4.
 * @param {string} text
 * @returns {{ bits: 32 | 128, value: bigint } | null}
 */
function parseIp(text) {
  const trimmed = text.trim()
  if (trimmed.includes(':')) {
    const v6 = parseV6(trimmed)
    if (v6 === null) return null
    if (v6 >> 32n === 0xffffn) return { bits: 32, value: v6 & 0xffffffffn }
    return { bits: 128, value: v6 }
  }
  const v4 = parseV4(trimmed)
  return v4 === null ? null : { bits: 32, value: v4 }
}

/**
 * Whether an IPv4 or IPv6 address falls inside any of the CIDR ranges.
 * Anything unparseable is simply not in range.
 * @param {string} ip
 * @param {string[]} ranges
 * @returns {boolean}
 */
export function inRanges(ip, ranges) {
  const address = parseIp(ip)
  if (!address) return false
  for (const range of ranges) {
    const [base, lengthText, extra] = range.split('/')
    if (extra !== undefined || lengthText === undefined || !/^\d{1,3}$/.test(lengthText)) continue
    const network = parseIp(base)
    const length = Number(lengthText)
    if (!network || network.bits !== address.bits || length > network.bits) continue
    const shift = BigInt(network.bits - length)
    if (address.value >> shift === network.value >> shift) return true
  }
  return false
}

/**
 * Guess who fetched the image from the network it came from.
 * @param {string} ip
 * @param {string} userAgent
 * @param {number} [asn]
 * @returns {'apple' | 'google' | 'other'}
 */
export function classify(ip, userAgent, asn) {
  if (asn === 714 || asn === 6185 || inRanges(ip, appleRanges)) return 'apple'
  if (userAgent.includes('GoogleImageProxy') || inRanges(ip, googleRanges)) return 'google'
  return 'other'
}
