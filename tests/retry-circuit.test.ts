/**
 * Retry + circuit breaker + observer tests — real HTTP against a Hono test
 * server whose failure pattern we control per-request. No mocks, no fakes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { AgentClient, AgentClientError } from '../src/index'

let server: ServerType
let baseUrl: string

// Failure script: array of status codes to return per request; after the
// script is exhausted returns 200. Set per-test in beforeEach.
let scriptedStatuses: number[] = []
let retryAfterOn: { [status: number]: number } = {}
let requestCount = 0

beforeAll(async () => {
  const app = new Hono()
  app.get('/v1/agents/:slug/chat/completions', (c) => {
    requestCount++
    const status = scriptedStatuses.shift() ?? 200
    if (status === 200) {
      return c.json({
        slug: c.req.param('slug'),
        pricing: { per_token_usd: 0.00002, currency: 'USD', platform_fee_percent: 0.2 },
        hosting: { mode: 'centralized', endpoint: 'test' },
        payment_methods: [{ type: 'x402' }],
        capabilities: ['chat.completions'],
        openai_compatible: true,
      })
    }
    const headers: Record<string, string> = {}
    if (retryAfterOn[status]) headers['Retry-After'] = String(retryAfterOn[status])
    return c.text(`status ${status}`, status as 400, headers)
  })

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://localhost:${info.port}`
      resolve()
    })
  })
})

afterAll(() => server?.close())

beforeEach(() => {
  scriptedStatuses = []
  retryAfterOn = {}
  requestCount = 0
})

// ----- Retry behavior -----

describe('retry', () => {
  it('retries on 429 then succeeds — regression: retry loop must actually re-request', async () => {
    scriptedStatuses = [429, 429, 200]
    const client = new AgentClient(baseUrl, {
      retry: { maxRetries: 3, baseDelayMs: 10, jitter: false },
    })
    const info = await client.discover('test-agent')
    expect(info.slug).toBe('test-agent')
    expect(requestCount).toBe(3) // two failures, one success
  })

  it('retries on 500/502/503/504 — regression: transient server errors must not be fatal', async () => {
    for (const status of [500, 502, 503, 504]) {
      scriptedStatuses = [status, 200]
      requestCount = 0
      const client = new AgentClient(baseUrl, { retry: { baseDelayMs: 5, jitter: false } })
      await client.discover('test-agent')
      expect(requestCount).toBe(2)
    }
  })

  it('does NOT retry 400/401/403/404 — regression: retrying client errors wastes resources + DoSes the server', async () => {
    for (const status of [400, 401, 403, 404]) {
      scriptedStatuses = [status]
      requestCount = 0
      const client = new AgentClient(baseUrl, { retry: { baseDelayMs: 5, jitter: false } })
      const err = await client.discover('test-agent').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AgentClientError)
      expect((err as AgentClientError).status).toBe(status)
      expect(requestCount).toBe(1) // no retry
    }
  })

  it('stops retrying after maxRetries — regression: infinite retries hang caller', async () => {
    scriptedStatuses = [500, 500, 500, 500, 500] // more failures than retries
    const client = new AgentClient(baseUrl, { retry: { maxRetries: 2, baseDelayMs: 5, jitter: false } })
    const res = await client.discover('test-agent').catch((e: unknown) => e)
    // Eventually returns the last error (discover throws on non-2xx)
    expect((res as AgentClientError).status).toBe(500)
    expect(requestCount).toBe(3) // 1 initial + 2 retries
  })

  it('respects Retry-After header on 429 — regression: hammering a rate-limited server gets banned', async () => {
    scriptedStatuses = [429, 200]
    retryAfterOn = { 429: 1 }
    const client = new AgentClient(baseUrl, {
      retry: { maxRetries: 2, baseDelayMs: 50, jitter: false, respectRetryAfter: true },
    })
    const startMs = Date.now()
    await client.discover('test-agent')
    const elapsed = Date.now() - startMs
    expect(elapsed).toBeGreaterThanOrEqual(900) // at least ~1s as header requested
    expect(elapsed).toBeLessThan(2000)
  })

  it('exponential backoff without jitter is deterministic', async () => {
    scriptedStatuses = [500, 500, 200]
    const delays: number[] = []
    const client = new AgentClient(baseUrl, {
      retry: { maxRetries: 3, baseDelayMs: 20, jitter: false, maxDelayMs: 10_000 },
      observer: { onRetry: (i) => delays.push(i.delayMs) },
    })
    await client.discover('test-agent')
    // attempt 0 → delay = 20 * 2^0 = 20ms
    // attempt 1 → delay = 20 * 2^1 = 40ms
    expect(delays).toEqual([20, 40])
  })

  it('caps exponential backoff at maxDelayMs', async () => {
    scriptedStatuses = [500, 500, 500, 200]
    const delays: number[] = []
    const client = new AgentClient(baseUrl, {
      retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 150, jitter: false },
      observer: { onRetry: (i) => delays.push(i.delayMs) },
    })
    await client.discover('test-agent')
    // 100, 150 (capped), 150 (capped)
    for (const d of delays) expect(d).toBeLessThanOrEqual(150)
  })
})

// ----- Circuit breaker -----

describe('circuit breaker', () => {
  it('opens after N consecutive failures — regression: cascading failures should stop trying early', async () => {
    // 5 consecutive 500s — all retries exhausted means 1 failure per "call"
    // CB counts a top-level call as one failure.
    scriptedStatuses = Array(50).fill(500) // plenty of failure
    const opened: unknown[] = []
    const client = new AgentClient(baseUrl, {
      retry: { maxRetries: 0, baseDelayMs: 5, jitter: false },
      circuitBreaker: { failuresToOpen: 3, openDurationMs: 1000 },
      observer: { onCircuitOpen: (i) => opened.push(i) },
    })
    // Make 3 failing calls; 3rd should open the breaker
    for (let i = 0; i < 3; i++) {
      await client.discover('test-agent').catch(() => null)
    }
    expect(opened).toHaveLength(1)
    expect((opened[0] as { failures: number }).failures).toBe(3)

    // 4th call rejects immediately without hitting the server
    const beforeCount = requestCount
    const err = await client.discover('test-agent').catch((e: unknown) => e)
    expect(requestCount).toBe(beforeCount) // no server call made
    expect(err).toBeInstanceOf(AgentClientError)
    expect((err as AgentClientError).message).toMatch(/Circuit breaker open/)
  })

  it('closes after openDurationMs — regression: breaker stuck open locks users out', async () => {
    scriptedStatuses = [500, 500, 500]
    let closed = 0
    const client = new AgentClient(baseUrl, {
      retry: { maxRetries: 0, baseDelayMs: 5, jitter: false },
      circuitBreaker: { failuresToOpen: 2, openDurationMs: 100 },
      observer: { onCircuitClose: () => { closed++ } },
    })
    // Trip the breaker
    await client.discover('test-agent').catch(() => null)
    await client.discover('test-agent').catch(() => null)

    // Wait past open window
    await new Promise((r) => setTimeout(r, 150))

    // Next call should go through (circuit half-opens)
    scriptedStatuses = [200]
    const info = await client.discover('test-agent')
    expect(info.slug).toBe('test-agent')
    expect(closed).toBe(1)
  })

  it('isolates circuits per-slug — regression: one slug\'s breaker must not affect others', async () => {
    scriptedStatuses = Array(20).fill(500)
    const opened: string[] = []
    const client = new AgentClient(baseUrl, {
      retry: { maxRetries: 0, baseDelayMs: 5, jitter: false },
      circuitBreaker: { failuresToOpen: 2, openDurationMs: 5000 },
      observer: { onCircuitOpen: (i) => opened.push(i.slug) },
    })
    // Trip breaker on agent-a
    await client.discover('agent-a').catch(() => null)
    await client.discover('agent-a').catch(() => null)
    expect(opened).toContain('agent-a')

    // agent-b circuit is still closed; script hasn't returned 200 yet so it'll fail,
    // but the server IS called (circuit didn't block us)
    const countBefore = requestCount
    await client.discover('agent-b').catch(() => null)
    expect(requestCount).toBe(countBefore + 1)
  })
})

// ----- Observer -----

describe('observer hooks', () => {
  it('onRequest + onResponse fire per attempt', async () => {
    scriptedStatuses = [500, 200]
    const events: Array<{ type: string; attempt: number; status?: number }> = []
    const client = new AgentClient(baseUrl, {
      retry: { maxRetries: 2, baseDelayMs: 5, jitter: false },
      observer: {
        onRequest: (i) => events.push({ type: 'req', attempt: i.attempt }),
        onResponse: (i) => events.push({ type: 'res', attempt: i.attempt, status: i.status }),
      },
    })
    await client.discover('test-agent')
    expect(events).toEqual([
      { type: 'req', attempt: 0 },
      { type: 'res', attempt: 0, status: 500 },
      { type: 'req', attempt: 1 },
      { type: 'res', attempt: 1, status: 200 },
    ])
  })

  it('onRetry fires with delay + reason', async () => {
    scriptedStatuses = [503, 200]
    const retries: unknown[] = []
    const client = new AgentClient(baseUrl, {
      retry: { maxRetries: 2, baseDelayMs: 5, jitter: false },
      observer: { onRetry: (i) => retries.push(i) },
    })
    await client.discover('test-agent')
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({ attempt: 0, reason: 'http_503', status: 503 })
  })

  it('onResponse exposes X-Request-Id from server — regression: clients need server request-id for trace correlation', async () => {
    // Ephemeral server that always returns 200 with a request id
    const app = new Hono()
    const reqId = 'req_0123456789abcdef'
    app.get('/v1/agents/:slug/chat/completions', (c) => {
      return c.json(
        { slug: 'test-agent', pricing: { per_token_usd: 0, currency: 'USD', platform_fee_percent: 0 }, hosting: { mode: 'centralized', endpoint: '' }, payment_methods: [], capabilities: [], openai_compatible: true },
        { headers: { 'X-Request-Id': reqId } },
      )
    })
    const idServer: ServerType = await new Promise((r) => {
      const s = serve({ fetch: app.fetch, port: 0 }, () => r(s))
    })
    const port = (idServer.address() as { port: number }).port

    let captured: string | undefined
    const client = new AgentClient(`http://localhost:${port}`, {
      retry: { maxRetries: 0 },
      observer: { onResponse: (i) => { captured = i.requestId } },
    })
    await client.discover('test-agent')
    expect(captured).toBe(reqId)
    idServer.close()
  })
})

// ----- Custom fetch injection -----

describe('fetch injection', () => {
  it('uses options.fetch when provided — regression: cannot inject telemetry or mocks otherwise', async () => {
    const calls: string[] = []
    const customFetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      return new Response(JSON.stringify({ slug: 'x', pricing: { per_token_usd: 0, currency: 'USD', platform_fee_percent: 0 }, hosting: { mode: 'centralized', endpoint: '' }, payment_methods: [], capabilities: [], openai_compatible: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const client = new AgentClient('https://example.com', { fetch: customFetch as typeof fetch, retry: { maxRetries: 0 } })
    await client.discover('test-agent')
    expect(customFetch).toHaveBeenCalledTimes(1)
    expect(calls[0]).toContain('https://example.com/v1/agents/test-agent/chat/completions')
  })
})
