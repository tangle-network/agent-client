/**
 * agent-client tests — a real Hono server on a local port, real HTTP,
 * real SSE streaming. The client talks to it over fetch.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { AgentClient, AgentClientError } from '../src/index'

// ----- Test server plumbing -----

interface TestServerState {
  discoveryResponse: Record<string, unknown> | { status: number; body: string }
  chatChunks: string[]
  chatStatus: number
  chatErrorBody: Record<string, unknown> | null
  lastRequest: { headers: Record<string, string>; body: string } | null
}

const state: TestServerState = {
  discoveryResponse: {
    slug: 'test-agent',
    pricing: { per_token_usd: 0.00002, currency: 'USD', platform_fee_percent: 0.2 },
    hosting: { mode: 'centralized', endpoint: 'https://test.tangle.tools' },
    payment_methods: [{ type: 'x402' }, { type: 'api_key' }],
    capabilities: ['chat.completions'],
    openai_compatible: true,
  },
  chatChunks: ['Hello', ', ', 'world!'],
  chatStatus: 200,
  chatErrorBody: null,
  lastRequest: null,
}

function resetState() {
  state.discoveryResponse = {
    slug: 'test-agent',
    pricing: { per_token_usd: 0.00002, currency: 'USD', platform_fee_percent: 0.2 },
    hosting: { mode: 'centralized', endpoint: 'https://test.tangle.tools' },
    payment_methods: [{ type: 'x402' }, { type: 'api_key' }],
    capabilities: ['chat.completions'],
    openai_compatible: true,
  }
  state.chatChunks = ['Hello', ', ', 'world!']
  state.chatStatus = 200
  state.chatErrorBody = null
  state.lastRequest = null
}

function buildApp() {
  const app = new Hono()

  app.get('/v1/agents/:slug/chat/completions', (c) => {
    if ('status' in state.discoveryResponse) {
      return c.text(state.discoveryResponse.body, state.discoveryResponse.status as 400)
    }
    return c.json(state.discoveryResponse)
  })

  app.post('/v1/agents/:slug/chat/completions', async (c) => {
    const headersObj: Record<string, string> = {}
    c.req.raw.headers.forEach((v, k) => { headersObj[k] = v })
    state.lastRequest = { headers: headersObj, body: await c.req.text() }

    if (state.chatStatus !== 200) {
      return c.json(state.chatErrorBody ?? { error: { message: `status ${state.chatStatus}` } }, state.chatStatus as 400)
    }

    // Stream real SSE chunks
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const delta of state.chatChunks) {
          const chunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }
        const done = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
  })

  return app
}

let server: ServerType
let baseUrl: string

beforeAll(async () => {
  const app = buildApp()
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://localhost:${info.port}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
})

beforeEach(() => resetState())

// ----- Constructor -----

describe('AgentClient constructor', () => {
  it('strips trailing slash from baseUrl — regression: double slash breaks route matching', () => {
    const client = new AgentClient(`${baseUrl}///`)
    // Use the client to confirm no "//" appears in constructed URL
    return expect(client.discover('test-agent')).resolves.toBeDefined()
  })

  it('warns on non-HTTPS non-localhost — regression: silent cleartext API key in production', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    new AgentClient('http://prod.example.com')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/WARNING.*HTTPS/))
    warnSpy.mockRestore()
  })

  it('does NOT warn on https:// — regression: false-positive warnings train people to ignore warnings', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    new AgentClient('https://prod.example.com')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('does NOT warn on http://localhost — regression: blocks local dev loop', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    new AgentClient('http://localhost:3000')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// ----- discover -----

describe('discover', () => {
  it('returns agent metadata', async () => {
    const client = new AgentClient(baseUrl)
    const info = await client.discover('test-agent')
    expect(info.slug).toBe('test-agent')
    expect(info.pricing.per_token_usd).toBe(0.00002)
    expect(info.openai_compatible).toBe(true)
  })

  it('rejects invalid slugs — regression: path injection via "../admin"', async () => {
    const client = new AgentClient(baseUrl)
    await expect(client.discover('../admin')).rejects.toBeInstanceOf(AgentClientError)
    await expect(client.discover('agent with spaces')).rejects.toBeInstanceOf(AgentClientError)
    await expect(client.discover('Agent-With-Caps')).rejects.toBeInstanceOf(AgentClientError)
    await expect(client.discover('-leading-dash')).rejects.toBeInstanceOf(AgentClientError)
    await expect(client.discover('')).rejects.toBeInstanceOf(AgentClientError)
  })

  it('accepts valid slug patterns', async () => {
    const client = new AgentClient(baseUrl)
    // The server always returns the same body; we're just asserting the client doesn't reject at validation
    await expect(client.discover('valid-agent')).resolves.toBeDefined()
    await expect(client.discover('agent_123')).resolves.toBeDefined()
    await expect(client.discover('a.b.c')).resolves.toBeDefined()
    await expect(client.discover('0-digit-first-ok-if-digit')).resolves.toBeDefined()
  })

  it('throws AgentClientError on non-2xx with status preserved', async () => {
    state.discoveryResponse = { status: 404, body: 'agent not found' }
    const client = new AgentClient(baseUrl)
    const err = await client.discover('test-agent').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentClientError)
    expect((err as AgentClientError).status).toBe(404)
    expect((err as AgentClientError).body).toBe('agent not found')
  })
})

// ----- Auth paths -----

describe('chat auth headers', () => {
  it('sends API key as Bearer — regression: wrong header name locks out all consumers', async () => {
    const client = new AgentClient(baseUrl)
    await client.chat('test-agent', [{ role: 'user', content: 'hi' }], { apiKey: 'ak_secret' })
    expect(state.lastRequest?.headers['authorization']).toBe('Bearer ak_secret')
  })

  it('sends x402 signature as X-Payment-Signature', async () => {
    const client = new AgentClient(baseUrl)
    await client.chat('test-agent', [{ role: 'user', content: 'hi' }], { x402Signature: '{"commitment":"0xA"}' })
    expect(state.lastRequest?.headers['x-payment-signature']).toBe('{"commitment":"0xA"}')
  })

  it('sends MPP credential with default method — regression: missing method default breaks integration', async () => {
    const client = new AgentClient(baseUrl)
    await client.chat('test-agent', [{ role: 'user', content: 'hi' }], { mppCredential: 'b64cred' })
    expect(state.lastRequest?.headers['authorization']).toBe('Payment blueprintevm b64cred')
  })

  it('sends MPP credential with explicit method override', async () => {
    const client = new AgentClient(baseUrl)
    await client.chat('test-agent', [{ role: 'user', content: 'hi' }], {
      mppCredential: 'b64cred',
      mppMethod: 'x402evm',
    })
    expect(state.lastRequest?.headers['authorization']).toBe('Payment x402evm b64cred')
  })

  it('sends no auth header when no auth option given — regression: silently injecting stale auth', async () => {
    const client = new AgentClient(baseUrl)
    await client.chat('test-agent', [{ role: 'user', content: 'hi' }])
    expect(state.lastRequest?.headers['authorization']).toBeUndefined()
    expect(state.lastRequest?.headers['x-payment-signature']).toBeUndefined()
  })

  it('apiKey takes precedence over x402 when both provided — regression: ambiguous auth dispatch', async () => {
    const client = new AgentClient(baseUrl)
    await client.chat('test-agent', [{ role: 'user', content: 'hi' }], {
      apiKey: 'ak_priority',
      x402Signature: '{"commitment":"should-not-win"}',
    })
    expect(state.lastRequest?.headers['authorization']).toBe('Bearer ak_priority')
    expect(state.lastRequest?.headers['x-payment-signature']).toBeUndefined()
  })
})

// ----- Chat flow -----

describe('chat + chatStream', () => {
  it('assembles stream chunks in order — regression: out-of-order delivery corrupts output', async () => {
    state.chatChunks = ['The ', 'quick ', 'brown ', 'fox']
    const client = new AgentClient(baseUrl)
    const text = await client.chat('test-agent', [{ role: 'user', content: 'hi' }], { apiKey: 'ak_1' })
    expect(text).toBe('The quick brown fox')
  })

  it('chatStream yields a chunk per delta + handles [DONE] — regression: stream hang on missing terminator', async () => {
    state.chatChunks = ['A', 'B', 'C']
    const client = new AgentClient(baseUrl)
    const received: string[] = []
    for await (const chunk of client.chatStream('test-agent', [{ role: 'user', content: 'hi' }], { apiKey: 'ak_1' })) {
      if (chunk.content) received.push(chunk.content)
    }
    expect(received).toEqual(['A', 'B', 'C'])
  })

  it('sends temperature + maxTokens when provided', async () => {
    const client = new AgentClient(baseUrl)
    await client.chat('test-agent', [{ role: 'user', content: 'hi' }], {
      apiKey: 'ak_1',
      temperature: 0.7,
      maxTokens: 100,
    })
    const body = JSON.parse(state.lastRequest!.body) as { temperature?: number; max_tokens?: number }
    expect(body.temperature).toBe(0.7)
    expect(body.max_tokens).toBe(100)
  })

  it('omits temperature/maxTokens when not provided — regression: unintended null sent to upstream', async () => {
    const client = new AgentClient(baseUrl)
    await client.chat('test-agent', [{ role: 'user', content: 'hi' }], { apiKey: 'ak_1' })
    const body = JSON.parse(state.lastRequest!.body) as Record<string, unknown>
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('sets stream: true on the request', async () => {
    const client = new AgentClient(baseUrl)
    await client.chat('test-agent', [{ role: 'user', content: 'hi' }], { apiKey: 'ak_1' })
    const body = JSON.parse(state.lastRequest!.body) as { stream: boolean }
    expect(body.stream).toBe(true)
  })
})

// ----- Error handling -----

describe('errors', () => {
  it('throws AgentClientError with paymentInfo on 402 — regression: consumers need structured payment prompts', async () => {
    state.chatStatus = 402
    state.chatErrorBody = {
      error: {
        message: 'Payment required',
        payment_methods: ['x402', 'api_key'],
        x402: { operator: '0x1', chain_id: 3799 },
      },
    }
    const client = new AgentClient(baseUrl)
    const err = await client
      .chat('test-agent', [{ role: 'user', content: 'hi' }])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentClientError)
    const agentErr = err as AgentClientError
    expect(agentErr.status).toBe(402)
    expect(agentErr.message).toBe('Payment required')
    const info = agentErr.paymentInfo as { payment_methods: string[]; x402: Record<string, unknown> } | null
    expect(info?.payment_methods).toEqual(['x402', 'api_key'])
    expect(info?.x402.operator).toBe('0x1')
  })

  it('paymentInfo returns null for non-402 errors', async () => {
    const err = new AgentClientError('boom', 500, JSON.stringify({ error: { message: 'x' } }))
    expect(err.paymentInfo).toBeNull()
  })

  it('paymentInfo returns null when body is not valid JSON', async () => {
    const err = new AgentClientError('boom', 402, 'not-json')
    expect(err.paymentInfo).toBeNull()
  })

  it('paymentInfo returns null when body absent', () => {
    const err = new AgentClientError('boom', 402)
    expect(err.paymentInfo).toBeNull()
  })

  it('throws AgentClientError with status on non-2xx chat', async () => {
    state.chatStatus = 500
    state.chatErrorBody = { error: { message: 'internal' } }
    // Disable retries so this test runs fast + tests the error surface
    const client = new AgentClient(baseUrl, { retry: { maxRetries: 0 } })
    const err = await client
      .chat('test-agent', [{ role: 'user', content: 'hi' }], { apiKey: 'ak_1' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentClientError)
    expect((err as AgentClientError).status).toBe(500)
  })

  it('throws when SSE stream contains an error frame — regression: silent success on mid-stream agent failure', async () => {
    // Replace the POST handler state: send a stream that includes an error frame
    // We intercept by adding a special chunk that our handler currently doesn't support,
    // so do this via a one-off Hono app on a second port.
    const errorApp = new Hono()
    errorApp.post('/v1/agents/:slug/chat/completions', () => {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"partial"}}]}\n\n`))
          controller.enqueue(enc.encode(`data: {"error":{"message":"agent exploded"}}\n\n`))
          controller.enqueue(enc.encode(`data: [DONE]\n\n`))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    })

    const errorServer: ServerType = await new Promise((resolve) => {
      const s = serve({ fetch: errorApp.fetch, port: 0 }, () => resolve(s))
    })
    const errorPort = (errorServer.address() as { port: number }).port
    const client = new AgentClient(`http://localhost:${errorPort}`)

    const err = await client
      .chat('test-agent', [{ role: 'user', content: 'hi' }], { apiKey: 'ak_1' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentClientError)
    expect((err as AgentClientError).message).toBe('agent exploded')
    errorServer.close()
  })

  it('skips malformed JSON lines in the stream — regression: one bad chunk must not kill the whole stream', async () => {
    const brokenApp = new Hono()
    brokenApp.post('/v1/agents/:slug/chat/completions', () => {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode(`data: {broken-json\n\n`))
          controller.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"valid"}}]}\n\n`))
          controller.enqueue(enc.encode(`data: [DONE]\n\n`))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    })

    const server2: ServerType = await new Promise((resolve) => {
      const s = serve({ fetch: brokenApp.fetch, port: 0 }, () => resolve(s))
    })
    const port2 = (server2.address() as { port: number }).port
    const client = new AgentClient(`http://localhost:${port2}`)

    const text = await client.chat('test-agent', [{ role: 'user', content: 'hi' }], { apiKey: 'ak_1' })
    expect(text).toBe('valid')
    server2.close()
  })

  it('rejects invalid slug before making request — regression: validation must happen client-side', async () => {
    const client = new AgentClient(baseUrl)
    await expect(
      client.chat('../../admin', [{ role: 'user', content: 'hi' }], { apiKey: 'ak_1' })
    ).rejects.toBeInstanceOf(AgentClientError)
    // No request reached server
    expect(state.lastRequest).toBeNull()
  })
})
