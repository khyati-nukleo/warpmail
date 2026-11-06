// Generates the Warpmail icon SVGs and exports every raster size the desktop app needs.
// Run from the repo root: node design/icon/build.mjs
// Output goes to design/icon/out/ — nothing in apps/desktop/resources is touched.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')
const store = join(root, 'node_modules/.pnpm')
const sharpDir = readdirSync(store).filter((d) => d.startsWith('sharp@')).sort().pop()
const sharp = createRequire(import.meta.url)(join(store, sharpDir, 'node_modules/sharp'))
const out = join(here, 'out')
mkdirSync(out, { recursive: true })

// Seeded random so every run produces the same streaks and particles.
function rng(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const f = (n) => Math.round(n * 10) / 10
const pts = (list) => list.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')

// Shared geometry -------------------------------------------------------------
const TILE = { x: 32, y: 32, s: 448, r: 100 }
const tileRect = `<rect x="${TILE.x}" y="${TILE.y}" width="${TILE.s}" height="${TILE.s}" rx="${TILE.r}"/>`
const angle = (-33 * Math.PI) / 180 // direction of travel: up and to the right
const dir = [Math.cos(angle), Math.sin(angle)]
const perp = [-dir[1], dir[0]]

// Envelope faces in local coordinates (centred on 0,0), separated later by dark seams.
function envelope(w, h, apexY = 0.12, seamAt = 0.62) {
  const [x0, x1, y0, y1] = [-w / 2, w / 2, -h / 2, h / 2]
  const A = [0, h * apexY]
  const P1 = [x0 + (A[0] - x0) * seamAt, y0 + (A[1] - y0) * seamAt]
  const P2 = [-P1[0], P1[1]]
  return {
    w, h,
    flap: [[x0, y0], [x1, y0], A],
    left: [[x0, y0], P1, [x0, y1]],
    right: [[x1, y0], [x1, y1], P2],
    bottom: [[x0, y1], P1, A, P2, [x1, y1]],
    seams: [`M${f(x0)},${f(y0)} L${f(A[0])},${f(A[1])} L${f(x1)},${f(y0)}`, `M${f(x0)},${f(y1)} L${f(P1[0])},${f(P1[1])}`, `M${f(x1)},${f(y1)} L${f(P2[0])},${f(P2[1])}`],
  }
}

const background = `
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#11264d"/>
      <stop offset="1" stop-color="#040a1a"/>
    </linearGradient>
    <radialGradient id="halo" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(262 250) scale(230)">
      <stop offset="0" stop-color="#2f7bff" stop-opacity=".55"/>
      <stop offset=".45" stop-color="#2456d8" stop-opacity=".22"/>
      <stop offset="1" stop-color="#1a3a9a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="flap" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#e3eafa"/>
    </linearGradient>
    <linearGradient id="lower" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f1f5ff"/>
      <stop offset="1" stop-color="#c3d0ee"/>
    </linearGradient>`

function envelopeGroup(env, transform, seamWidth, shadow = true) {
  return `
  <g transform="${transform}">
    ${shadow ? `<rect x="${-env.w / 2 + 6}" y="${-env.h / 2 + 14}" width="${env.w}" height="${env.h}" rx="12" fill="#020613" opacity=".6" filter="url(#soft)"/>` : ''}
    <g clip-path="url(#env-clip)">
      <polygon points="${pts(env.bottom)}" fill="url(#lower)"/>
      <polygon points="${pts(env.left)}" fill="#d9e2f6"/>
      <polygon points="${pts(env.right)}" fill="#cdd8f1"/>
      <polygon points="${pts(env.flap)}" fill="url(#flap)"/>
      <g stroke="#0a1530" stroke-width="${seamWidth}" stroke-linecap="round" stroke-linejoin="round" fill="none">
        ${env.seams.map((d) => `<path d="${d}"/>`).join('\n        ')}
      </g>
    </g>
  </g>`
}

// Detailed icon (64px and up) ------------------------------------------------------
function detailedIcon() {
  const rand = rng(7)
  const C = [282, 236]
  const env = envelope(236, 150)

  // Warped grid: points are pulled towards the envelope, like space bending around it.
  const warp = ([x, y]) => {
    const dx = C[0] - x, dy = C[1] - y
    const k = 0.42 * Math.exp(-(dx * dx + dy * dy) / (190 * 190))
    return [x + dx * k, y + dy * k]
  }
  const grid = []
  for (let v = 0; v <= 512; v += 44) {
    const h = [], vert = []
    for (let t = 0; t <= 512; t += 8) {
      h.push(warp([t, v]))
      vert.push(warp([v, t]))
    }
    grid.push(`M${pts(h).replace(/ /g, ' L')}`, `M${pts(vert).replace(/ /g, ' L')}`)
  }

  // Speed streaks trailing behind the envelope.
  const palette = ['#41d9ff', '#41d9ff', '#5b8cff', '#9a5cff', '#c06bff', '#ffffff']
  const streaks = []
  const defs = []
  for (let i = 0; i < 30; i++) {
    const s = (rand() * 2 - 1) * 118
    const core = 1 - Math.abs(s) / 118
    const back = -40 - rand() * 70
    const len = 90 + rand() * 230 * (0.5 + core)
    const end = [C[0] + perp[0] * s + dir[0] * back, C[1] + perp[1] * s + dir[1] * back]
    const start = [end[0] - dir[0] * len, end[1] - dir[1] * len]
    const color = palette[Math.floor(rand() * palette.length)]
    const width = color === '#ffffff' ? 1.2 + rand() * 1.5 : 1.8 + rand() * 5 * (0.4 + core)
    defs.push(`<linearGradient id="s${i}" gradientUnits="userSpaceOnUse" x1="${f(start[0])}" y1="${f(start[1])}" x2="${f(end[0])}" y2="${f(end[1])}">
      <stop offset="0" stop-color="${color}" stop-opacity="0"/>
      <stop offset=".75" stop-color="${color}" stop-opacity="${f(0.55 + core * 0.35)}"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity=".95"/>
    </linearGradient>`)
    streaks.push(`<line x1="${f(start[0])}" y1="${f(start[1])}" x2="${f(end[0])}" y2="${f(end[1])}" stroke="url(#s${i})" stroke-width="${f(width)}" stroke-linecap="round"/>`)
  }

  const dots = []
  for (let i = 0; i < 46; i++) {
    const s = (rand() * 2 - 1) * 135
    const back = -50 - rand() * 230
    const [x, y] = [C[0] + perp[0] * s + dir[0] * back, C[1] + perp[1] * s + dir[1] * back]
    const fill = rand() < 0.6 ? '#bff4ff' : '#ffffff'
    dots.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(0.7 + rand() * 1.9)}" fill="${fill}" opacity="${f(0.35 + rand() * 0.6)}"/>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
  <defs>${background}
    <clipPath id="tile">${tileRect}</clipPath>
    <clipPath id="env-clip"><rect x="${-env.w / 2}" y="${-env.h / 2}" width="${env.w}" height="${env.h}" rx="12"/></clipPath>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".13"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity=".02"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".5"/>
      <stop offset=".45" stop-color="#9fc2ff" stop-opacity=".12"/>
      <stop offset="1" stop-color="#41d9ff" stop-opacity=".35"/>
    </linearGradient>
    <filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="12"/></filter>
    ${defs.join('\n    ')}
  </defs>
  <g clip-path="url(#tile)">
    <rect width="512" height="512" fill="url(#bg)"/>
    <rect width="512" height="512" fill="url(#halo)"/>
    <path d="${grid.join(' ')}" stroke="#4d7fd6" stroke-opacity=".2" stroke-width="1.3"/>
    <g filter="url(#blur)" opacity=".9">${streaks.join('')}</g>
    <g>${streaks.join('')}</g>
    <g>${dots.join('')}</g>
    ${envelopeGroup(env, `translate(${C[0]} ${C[1]}) rotate(-22) skewX(-6)`, 7)}
    <path d="M32 32H480V218C390 150 250 128 32 168Z" fill="url(#sheen)"/>
  </g>
  <rect x="${TILE.x + 1.5}" y="${TILE.y + 1.5}" width="${TILE.s - 3}" height="${TILE.s - 3}" rx="${TILE.r - 1.5}" stroke="url(#rim)" stroke-width="3"/>
</svg>
`
}

// Simplified icon (16–48px): no grid, no particles, bigger envelope, three thick streaks.
function smallIcon({ unread = false } = {}) {
  const C = [276, 238]
  const env = envelope(270, 176)
  const trail = [
    { s: -46, back: -60, len: 210, w: 30, c: '#41d9ff' },
    { s: 10, back: -50, len: 250, w: 30, c: '#7b6bff' },
    { s: 66, back: -60, len: 170, w: 26, c: '#41d9ff' },
  ]
  const defs = []
  const lines = trail.map((t, i) => {
    const end = [C[0] + perp[0] * t.s + dir[0] * t.back, C[1] + perp[1] * t.s + dir[1] * t.back]
    const start = [end[0] - dir[0] * t.len, end[1] - dir[1] * t.len]
    defs.push(`<linearGradient id="t${i}" gradientUnits="userSpaceOnUse" x1="${f(start[0])}" y1="${f(start[1])}" x2="${f(end[0])}" y2="${f(end[1])}">
      <stop offset="0" stop-color="${t.c}" stop-opacity=".15"/>
      <stop offset="1" stop-color="${t.c}"/>
    </linearGradient>`)
    return `<line x1="${f(start[0])}" y1="${f(start[1])}" x2="${f(end[0])}" y2="${f(end[1])}" stroke="url(#t${i})" stroke-width="${t.w}" stroke-linecap="round"/>`
  })
  const badge = unread
    ? `<circle cx="428" cy="84" r="62" fill="#7ff3ff"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
  <defs>${background}
    <clipPath id="tile">${tileRect}</clipPath>
    <clipPath id="env-clip"><rect x="${-env.w / 2}" y="${-env.h / 2}" width="${env.w}" height="${env.h}" rx="16"/></clipPath>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10"/></filter>
    ${unread ? `<mask id="cut"><rect width="512" height="512" fill="#fff"/><circle cx="428" cy="84" r="94" fill="#000"/></mask>` : ''}
    ${defs.join('\n    ')}
  </defs>
  <g ${unread ? 'mask="url(#cut)"' : ''}>
    <g clip-path="url(#tile)">
      <rect width="512" height="512" fill="url(#bg)"/>
      <rect width="512" height="512" fill="url(#halo)"/>
      ${lines.join('\n      ')}
      ${envelopeGroup(env, `translate(${C[0]} ${C[1]}) rotate(-20)`, 15)}
    </g>
  </g>
  ${badge}
</svg>
`
}

// White single-colour mark for the sidebar (shown at 24px on the dark sidebar).
function mark() {
  const env = envelope(56, 36)
  const C = [58, 40]
  const D = dir, N = perp
  const trail = [
    { s: -8, back: -24, len: 30, w: 5, o: 1 },
    { s: 3, back: -24, len: 42, w: 5, o: 0.8 },
    { s: 14, back: -24, len: 24, w: 4.5, o: 0.55 },
  ].map((t) => {
    const end = [C[0] + N[0] * t.s + D[0] * t.back, C[1] + N[1] * t.s + D[1] * t.back]
    const start = [end[0] - D[0] * t.len, end[1] - D[1] * t.len]
    return `<line x1="${f(start[0])}" y1="${f(start[1])}" x2="${f(end[0])}" y2="${f(end[1])}" stroke-width="${t.w}" opacity="${t.o}"/>`
  })
  const g = `translate(${C[0]} ${C[1]}) rotate(-20)`
  const body = `x="${-env.w / 2}" y="${-env.h / 2}" width="${env.w}" height="${env.h}"`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" fill="#ffffff">
  <defs>
    <mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="96" height="96">
      <rect width="96" height="96" fill="#fff"/>
      <g transform="${g}">
        <rect x="${-env.w / 2 - 4}" y="${-env.h / 2 - 4}" width="${env.w + 8}" height="${env.h + 8}" rx="7" fill="#000"/>
        <rect ${body} rx="4" fill="#fff"/>
        <g stroke="#000" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none">
          ${env.seams.map((p) => `<path d="${p}"/>`).join('')}
        </g>
      </g>
    </mask>
  </defs>
  <g mask="url(#cut)">
    <g stroke="#ffffff" stroke-linecap="round">${trail.join('')}</g>
    <rect transform="${g}" ${body} rx="4"/>
  </g>
</svg>
`
}

// Export ---------------------------------------------------------------------------
const svgs = {
  'icon.svg': detailedIcon(),
  'icon-small.svg': smallIcon(),
  'icon-small-unread.svg': smallIcon({ unread: true }),
  'icon-mark.svg': mark(),
}
for (const [name, svg] of Object.entries(svgs)) writeFileSync(join(out, name), svg)

const render = (svg, size) => sharp(Buffer.from(svg), { density: Math.max(72, (72 * size) / 512) * 4 }).resize(size, size).png().toBuffer()

const pngs = {}
for (const size of [1024, 512, 256, 128, 64]) pngs[size] = await render(svgs['icon.svg'], size)
for (const size of [48, 32, 24, 16]) pngs[size] = await render(svgs['icon-small.svg'], size)

writeFileSync(join(out, 'icon.png'), pngs[1024]) // electron-builder source for macOS/Linux, and the window icon
writeFileSync(join(out, 'icon-512.png'), pngs[512])
writeFileSync(join(out, 'tray.png'), pngs[24])
writeFileSync(join(out, 'tray@2x.png'), pngs[48])
writeFileSync(join(out, 'tray-unread.png'), await render(svgs['icon-small-unread.svg'], 24))
writeFileSync(join(out, 'tray-unread@2x.png'), await render(svgs['icon-small-unread.svg'], 48))

// Windows .ico: simplified art for 16–48px, detailed art for 64–256px (PNG-compressed entries).
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const header = Buffer.alloc(6 + 16 * icoSizes.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(icoSizes.length, 4)
let offset = header.length
icoSizes.forEach((size, i) => {
  const e = 6 + i * 16
  header.writeUInt8(size === 256 ? 0 : size, e)
  header.writeUInt8(size === 256 ? 0 : size, e + 1)
  header.writeUInt16LE(1, e + 4)
  header.writeUInt16LE(32, e + 6)
  header.writeUInt32LE(pngs[size].length, e + 8)
  header.writeUInt32LE(offset, e + 12)
  offset += pngs[size].length
})
writeFileSync(join(out, 'icon.ico'), Buffer.concat([header, ...icoSizes.map((s) => pngs[s])]))

// Preview sheet: every size at true pixels on dark and light, plus 4x zooms of the tiny ones.
const sheetSizes = [256, 128, 64, 48, 32, 24, 16]
const W = 1180, H = 760
const comps = []
for (const [row, bg] of [[0, '#1b1d22'], [1, '#eceef2']]) {
  comps.push({ input: { create: { width: W, height: 300, channels: 4, background: bg } }, left: 0, top: row * 300 })
  let x = 30
  for (const s of sheetSizes) {
    comps.push({ input: pngs[s], left: x, top: row * 300 + 150 - s / 2 })
    x += s + 40
  }
}
comps.push({ input: { create: { width: W, height: 160, channels: 4, background: '#1b1d22' } }, left: 0, top: 600 })
let zx = 30
for (const s of [48, 32, 24, 16]) {
  const z = await sharp(pngs[s]).resize(s * 4, s * 4, { kernel: 'nearest' }).toBuffer()
  comps.push({ input: z, left: zx, top: 600 + (160 - s * 4) / 2 })
  zx += s * 4 + 30
}
const mk = await sharp(Buffer.from(svgs['icon-mark.svg']), { density: 300 }).resize(96, 96).png().toBuffer()
const mk24 = await sharp(Buffer.from(svgs['icon-mark.svg']), { density: 300 }).resize(24, 24).png().toBuffer()
const tu = await sharp(await render(svgs['icon-small-unread.svg'], 48)).png().toBuffer()
comps.push({ input: mk, left: zx + 20, top: 632 }, { input: mk24, left: zx + 140, top: 668 }, { input: tu, left: zx + 200, top: 656 })
await sharp({ create: { width: W, height: H, channels: 4, background: '#000' } }).composite(comps).png().toFile(join(out, 'preview.png'))

console.log('Wrote', readdirSync(out).join(', '))
