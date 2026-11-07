import { describe, expect, it } from 'vitest'
import {
  addPixel,
  isWorkerImage,
  pixelUrl,
  readStatusLimits,
  stripPixels,
  trackedRecipients,
  trackingBlock,
  workerBase,
} from '../packages/core/src'

const base = 'https://read.example.com'
const person = (email: string) => ({ name: '', email })
const draft = (over: Record<string, unknown> = {}) => ({
  to: [person('alex@example.org')],
  cc: [],
  bcc: [],
  html: '<p>Hello</p>',
  readStatus: undefined as boolean | undefined,
  ...over,
})
const input = (over: Record<string, unknown> = {}) => ({
  settings: { enabled: true, workerUrl: base },
  passwordSet: true,
  draft: draft(),
  protection: 'none' as const,
  perCopySending: true,
  ownAddresses: ['me@example.com', 'me.alias@example.com'],
  ...over,
})

describe('workerBase', () => {
  it('accepts https origins and local http', () => {
    expect(workerBase('https://read.example.com')).toBe(base)
    expect(workerBase('https://read.example.com/')).toBe(base)
    expect(workerBase('http://localhost:8787')).toBe('http://localhost:8787')
    expect(workerBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
  })
  it('rejects everything else', () => {
    for (const bad of [
      'http://read.example.com',
      'https://u:p@read.example.com',
      'https://read.example.com/x',
      '',
      'nonsense',
      undefined,
    ])
      expect(workerBase(bad)).toBeUndefined()
  })
})

describe('pixels', () => {
  it('builds the pixel url', () => {
    expect(pixelUrl(base, 'abc')).toBe('https://read.example.com/p/abc.gif')
  })
  it('adds the pixel before the last body end, or appends', () => {
    const src = pixelUrl(base, 'abc')
    const out = addPixel('<html><body><p>Hi</p></BODY></html>', src)
    expect(out).toMatch(/<img src="[^"]+abc\.gif"[^>]*><\/BODY><\/html>$/)
    expect(out.indexOf('<img')).toBeGreaterThan(out.indexOf('<p>Hi</p>'))
    expect(addPixel('<p>Hi</p>', src)).toMatch(/^<p>Hi<\/p><img src=/)
  })
  it('recognises worker images', () => {
    expect(isWorkerImage('https://READ.example.com/p/x.gif', base)).toBe(true)
    expect(isWorkerImage('https://read.example.com:443/p/x.gif', base)).toBe(true)
    expect(isWorkerImage('https://read.example.com./p/x.gif', base)).toBe(true)
    expect(isWorkerImage('https://READ.example.com.:443/p/x.gif', base)).toBe(true)
    expect(isWorkerImage('https://read.example.com.evil.example/p/x.gif', base)).toBe(false)
    expect(isWorkerImage('http://read.example.com/p/x.gif', base)).toBe(true)
    expect(isWorkerImage('https://read.example.com:8443/p/x.gif', base)).toBe(true)
    expect(isWorkerImage('ftp://read.example.com/x', base)).toBe(false)
    expect(stripPixels('<p>a</p><img src="https://read.example.com./p/x.gif">', base)).toBe(
      '<p>a</p>',
    )
    expect(isWorkerImage('https://read.example.com/p/x.gif', undefined)).toBe(false)
  })
  it('strips worker images however the tag is written', () => {
    const w = 'https://read.example.com/p/y.gif'
    const cdn = '<img src="https://cdn.example.com/a.png">'
    for (const tag of [
      `<img alt="a src=x" src="${w}">`,
      `<img alt=it's src="${w}">`,
      `<img alt="unclosed src="${w}>`,
      `<img src='${w}'>`,
      `<img src=${w}>`,
      `<img\nwidth=1\nsrc\n=\n"${w}"\n/>`,
      `<img data-src="${w}">`,
      `<img alt="see https://read.example.com">`,
    ])
      expect(stripPixels(`<p>a</p>${tag}${cdn}`, base), tag).toBe(`<p>a</p>${cdn}`)
    expect(stripPixels(`<imgx src="${w}">`, base)).toContain('<imgx')
  })
  it('strips worker images only', () => {
    const html =
      '<p>a</p><img src="https://READ.example.com/p/abc.gif" width=1>' +
      "<IMG SRC='https://read.example.com:443/p/x.gif'>" +
      '<img src="https://cdn.example.com/a.png">'
    expect(stripPixels(html, base)).toBe('<p>a</p><img src="https://cdn.example.com/a.png">')
    expect(stripPixels(html, undefined)).toBe(html)
  })
})

describe('trackingBlock', () => {
  it('is undefined for an eligible draft; absent settings default to on but have no address', () => {
    expect(trackingBlock(input())).toBeUndefined()
    expect(trackingBlock(input({ settings: undefined }))).toBe('notConfigured')
  })
  it('reports each reason in order', () => {
    expect(trackingBlock(input({ settings: { enabled: false } }))).toBe('off')
    expect(trackingBlock(input({ settings: { enabled: true } }))).toBe('notConfigured')
    expect(trackingBlock(input({ passwordSet: false }))).toBe('notConfigured')
    expect(trackingBlock(input({ perCopySending: false }))).toBe('unsupported')
    expect(trackingBlock(input({ draft: draft({ readStatus: false }) }))).toBe('switchedOff')
    expect(trackingBlock(input({ protection: 'sign' }))).toBe('protected')
    expect(trackingBlock(input({ protection: 'encrypt' }))).toBe('protected')
    expect(trackingBlock(input({ draft: draft({ cc: [person('Me.Alias@Example.com')] }) }))).toBe(
      'self',
    )
    expect(trackingBlock(input({ draft: draft({ html: '  ' }) }))).toBe('noHtml')
    expect(trackingBlock(input({ draft: draft({ to: [person('noreply@example.org')] }) }))).toBe(
      'automated',
    )
    const many = Array.from({ length: readStatusLimits.recipients + 1 }, (_, i) =>
      person(`p${i}@example.org`),
    )
    expect(trackingBlock(input({ draft: draft({ to: many }) }))).toBe('tooMany')
  })
  it('orders checks: off beats notConfigured, unsupported beats switchedOff, protected beats self, self beats noHtml', () => {
    expect(trackingBlock(input({ settings: { enabled: false }, passwordSet: false }))).toBe('off')
    expect(
      trackingBlock(input({ perCopySending: false, draft: draft({ readStatus: false }) })),
    ).toBe('unsupported')
    expect(trackingBlock(input({ protection: 'sign', draft: draft({ readStatus: false }) }))).toBe(
      'switchedOff',
    )
    const self = draft({ bcc: [person('me@example.com')] })
    expect(trackingBlock(input({ protection: 'sign', draft: self }))).toBe('protected')
    expect(trackingBlock(input({ draft: { ...self, html: '' } }))).toBe('self')
  })
})

describe('trackedRecipients', () => {
  it('lowercases, trims and de-duplicates in order', () => {
    expect(
      trackedRecipients({
        to: [person('Alex@Example.org')],
        cc: [person(' alex@example.org'), person('sam@example.org')],
        bcc: [],
      }),
    ).toEqual(['alex@example.org', 'sam@example.org'])
  })
})
