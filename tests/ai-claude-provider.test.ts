import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { improveErrorMessages, type ImproveErrorKind } from '@inlark/core'
import { createClaudeProvider } from '../apps/desktop/src/main/ai/claude'
import { improveInstructions, styleInstruction } from '../apps/desktop/src/main/ai/instructions'
import { ImproveError, type ImproveUsage } from '../apps/desktop/src/main/ai/provider'

const apiKey = 'sk-ant-' + 'test'.repeat(8)
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Step = { event: string; data: unknown }
type Reply =
  { status: number; error: { type: string; message: string } } | { events: Step[]; hold?: boolean }

interface Recorded {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: any
}

const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  delete process.env.ANTHROPIC_AUTH_TOKEN
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r).closeAllConnections())),
  )
})

async function startServer(reply: Reply | ((req: Recorded) => Reply)) {
  const requests: Recorded[] = []
  let closed = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const rec: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      }
      requests.push(rec)
      res.on('close', () => closed++)
      const r = typeof reply === 'function' ? reply(rec) : reply
      if ('status' in r) {
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: r.error }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const step of r.events) {
        if (res.destroyed) return
        res.write(`event: ${step.event}\ndata: ${JSON.stringify(step.data)}\n\n`)
        await wait(15)
      }
      if (r.hold) return
      res.end()
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { baseURL, requests, closedCount: () => closed }
}

function message(model = 'claude-opus-5-5') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 120,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

function textEvents(deltas: string[], stopReason = 'end_turn', index = 0): Step[] {
  return [
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    },
    ...deltas.map((text) => ({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 40 },
      },
    },
  ]
}

const start: Step = { event: 'message_start', data: { type: 'message_start', message: message() } }
const stop: Step = { event: 'message_stop', data: { type: 'message_stop' } }
const okReply = (deltas: string[], stopReason = 'end_turn'): Reply => ({
  events: [start, ...textEvents(deltas, stopReason), stop],
})

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const v of iter) out.push(v)
  return out
}

async function failureOf(p: Promise<unknown>): Promise<ImproveError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ImproveError)
    return e as ImproveError
  }
  throw new Error('expected a failure')
}

describe('claude provider', () => {
  it('streams snapshots of the improved text', async () => {
    const s = await startServer(okReply(['Hello', ' Sam,']))
    const provider = createClaudeProvider({ apiKey, baseURL: s.baseURL, maxRetries: 0 })
    const values = await collect(
      provider.improve('hello sam', 'polish', new AbortController().signal),
    )
    expect(values).toEqual(['Hello', 'Hello Sam,'])
  })

  it('sends the fixed instructions, the style and only the given text', async () => {
    const s = await startServer(okReply(['Hi']))
    const provider = createClaudeProvider({ apiKey, baseURL: s.baseURL, maxRetries: 0 })
    await collect(provider.improve('Lunch at noon?', 'shorter', new AbortController().signal))
    const req = s.requests[0]!
    expect(req.url).toContain('/v1/messages')
    expect(req.body.model).toBe('claude-opus-5-5')
    expect(req.body.system[0].text).toBe(improveInstructions)
    expect(req.body.output_config.effort).toBe('low')
    expect(req.body.fallbacks).toBe('default')
    expect(req.body.temperature).toBeUndefined()
    expect(req.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    // SDK 1.x sends the API key as a bearer token.
    expect(req.headers.authorization).toBe(`Bearer ${apiKey}`)
    const content = req.body.messages[0].content
    expect(content).toContain(styleInstruction('shorter'))
    expect(content).toContain('Lunch at noon?')
  })

  it('starts over when a fallback model takes over mid-stream', async () => {
    const s = await startServer({
      events: [
        start,
        ...textEvents(['Draft A']).slice(0, 3),
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'fallback',
              from: { model: 'claude-opus-5-5' },
              to: { model: 'claude-opus-4-8' },
              trigger: { type: 'refusal' },
            },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
        ...textEvents(['Draft B'], 'end_turn', 2),
        stop,
      ],
    })
    const provider = createClaudeProvider({ apiKey, baseURL: s.baseURL, maxRetries: 0 })
    const values = await collect(provider.improve('x', 'polish', new AbortController().signal))
    expect(values.at(-1)).toBe('Draft B')
    expect(values).toContain('Draft A')
  })

  it.each<[number, string, ImproveErrorKind]>([
    [401, 'authentication_error', 'badKey'],
    [403, 'permission_error', 'badKey'],
    [402, 'billing_error', 'billing'],
    [429, 'rate_limit_error', 'rateLimit'],
    [500, 'api_error', 'unavailable'],
    [529, 'overloaded_error', 'unavailable'],
    [400, 'invalid_request_error', 'failed'],
  ])('maps HTTP %i to a kind', async (status, type, kind) => {
    const s = await startServer({ status, error: { type, message: 'secret server detail' } })
    const provider = createClaudeProvider({ apiKey, baseURL: s.baseURL, maxRetries: 0 })
    const err = await failureOf(
      collect(provider.improve('x', 'polish', new AbortController().signal)),
    )
    expect(err.kind).toBe(kind)
    expect(err.message).toBe(improveErrorMessages[kind])
    expect(err.message).not.toContain('secret server detail')
  })

  it('maps an error event in the middle of the stream', async () => {
    const s = await startServer({
      events: [
        start,
        ...textEvents(['Hi']).slice(0, 2),
        {
          event: 'error',
          data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        },
      ],
    })
    const provider = createClaudeProvider({ apiKey, baseURL: s.baseURL, maxRetries: 0 })
    const err = await failureOf(
      collect(provider.improve('x', 'polish', new AbortController().signal)),
    )
    expect(err.kind).toBe('unavailable')
  })

  it('reports offline when nothing is listening', async () => {
    const provider = createClaudeProvider({ apiKey, baseURL: 'http://127.0.0.1:1', maxRetries: 0 })
    const err = await failureOf(
      collect(provider.improve('x', 'polish', new AbortController().signal)),
    )
    expect(err.kind).toBe('offline')
  })

  it('cancels when the signal aborts', async () => {
    const s = await startServer({
      events: [start, ...textEvents(['One', ' two', ' three']).slice(0, 4)],
      hold: true,
    })
    const provider = createClaudeProvider({ apiKey, baseURL: s.baseURL, maxRetries: 0 })
    const ac = new AbortController()
    const run = (async () => {
      for await (const _ of provider.improve('x', 'polish', ac.signal)) ac.abort()
    })()
    const err = await failureOf(run)
    expect(err.kind).toBe('cancelled')
    await vi.waitFor(() => expect(s.closedCount()).toBe(1))
  })

  it('flags refusals and cut-off answers', async () => {
    for (const [stop_reason, kind] of [
      ['refusal', 'refused'],
      ['max_tokens', 'tooLong'],
    ] as const) {
      const s = await startServer(okReply(['Partial'], stop_reason))
      const provider = createClaudeProvider({ apiKey, baseURL: s.baseURL, maxRetries: 0 })
      const err = await failureOf(
        collect(provider.improve('x', 'polish', new AbortController().signal)),
      )
      expect(err.kind).toBe(kind)
    }
  })

  it('reports token usage once, including on abort', async () => {
    const seen: ImproveUsage[] = []
    const s = await startServer(okReply(['Hi']))
    const provider = createClaudeProvider({
      apiKey,
      baseURL: s.baseURL,
      maxRetries: 0,
      onUsage: (u) => seen.push(u),
    })
    await collect(provider.improve('x', 'polish', new AbortController().signal))
    expect(seen).toEqual([
      { inputTokens: 120, outputTokens: 40, cacheWriteTokens: 0, cacheReadTokens: 0 },
    ])

    const seen2: ImproveUsage[] = []
    const s2 = await startServer({
      events: [start, ...textEvents(['One', ' two']).slice(0, 3)],
      hold: true,
    })
    const p2 = createClaudeProvider({
      apiKey,
      baseURL: s2.baseURL,
      maxRetries: 0,
      onUsage: (u) => seen2.push(u),
    })
    const ac = new AbortController()
    const run = (async () => {
      for await (const _ of p2.improve('x', 'polish', ac.signal)) ac.abort()
    })()
    await failureOf(run)
    expect(seen2).toHaveLength(1)
  })

  it('checks a key without sending any draft', async () => {
    const s = await startServerRaw(200, {
      type: 'model',
      id: 'claude-opus-5-5',
      display_name: 'Claude',
      created_at: '2026-01-01T00:00:00Z',
    })
    const provider = createClaudeProvider({ apiKey, baseURL: s.baseURL, maxRetries: 0 })
    await expect(provider.check()).resolves.toBeUndefined()
    expect(s.requests[0]!.method).toBe('GET')
    expect(s.requests[0]!.url).toContain('/v1/models/claude-opus-5-5')

    const bad = await startServer({
      status: 401,
      error: { type: 'authentication_error', message: 'no' },
    })
    const p2 = createClaudeProvider({ apiKey, baseURL: bad.baseURL, maxRetries: 0 })
    const err = await failureOf(p2.check())
    expect(err.kind).toBe('badKey')
  })

  it('never logs', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )
    const s = await startServer(okReply(['Hi']))
    const provider = createClaudeProvider({ apiKey, baseURL: s.baseURL, maxRetries: 0 })
    await collect(provider.improve('x', 'polish', new AbortController().signal))
    const bad = await startServer({
      status: 401,
      error: { type: 'authentication_error', message: 'no' },
    })
    const p2 = createClaudeProvider({ apiKey, baseURL: bad.baseURL, maxRetries: 0 })
    await failureOf(collect(p2.improve('x', 'polish', new AbortController().signal)))
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('ignores Anthropic credentials from the environment', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-token'
    const s = await startServer(okReply(['Hi']))
    const provider = createClaudeProvider({ apiKey, baseURL: s.baseURL, maxRetries: 0 })
    await collect(provider.improve('x', 'polish', new AbortController().signal))
    expect(s.requests[0]!.headers.authorization).toBe(`Bearer ${apiKey}`)
    expect(JSON.stringify(s.requests[0]!.headers)).not.toContain('env-token')
  })
})

/** A server that answers every request with one JSON body. */
async function startServerRaw(status: number, body: unknown) {
  const requests: Recorded[] = []
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: null,
    })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}
