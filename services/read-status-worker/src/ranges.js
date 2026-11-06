/**
 * Published network ranges used to tell who fetched the image.
 * Only the source type is ever stored, never the address.
 */

/**
 * Apple (AS714 / AS6185). Hand-kept: 17.0.0.0/8 is Apple's IPv4 block
 * (ARIN, NetRange 17.0.0.0 - 17.255.255.255); the IPv6 prefixes are from Apple's
 * published allocations (iCloud Private Relay / Mail Privacy Protection). Checked 2026-11-06.
 * @type {string[]}
 */
export const appleRanges = ['17.0.0.0/8', '2620:149::/32', '2a01:b740::/32']

// BEGIN GOOGLE RANGES
/**
 * Google, a subset of https://www.gstatic.com/ipranges/goog.json that covers Gmail's
 * image proxy. Regenerate with `node scripts/update-ranges.mjs`. Last set by hand 2026-11-06.
 * @type {string[]}
 */
export const googleRanges = [
  '66.102.0.0/20',
  '66.249.64.0/19',
  '64.233.160.0/19',
  '72.14.192.0/18',
  '74.125.0.0/16',
  '209.85.128.0/17',
  '2001:4860::/32',
  '2404:6800::/32',
  '2607:f8b0::/32',
  '2800:3f0::/32',
  '2a00:1450::/32',
  '2c0f:fb50::/32',
]
// END GOOGLE RANGES
