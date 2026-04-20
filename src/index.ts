/**
 * @tangle-network/agent-client
 *
 * Client SDK for calling Tangle agent gateway endpoints.
 *
 * Usage:
 *   const client = new AgentClient('https://gtm.tangle.tools')
 *   const info = await client.discover('my-agent')
 *   const response = await client.chat('my-agent', [{ role: 'user', content: 'Hello' }], { apiKey: 'ak_...' })
 *   for await (const chunk of client.chatStream('my-agent', messages, { apiKey: 'ak_...' })) {
 *     process.stdout.write(chunk.content ?? '')
 *   }
 */

// --- Types ---

export interface AgentInfo {
  slug: string
  pricing: {
    per_token_usd: number
    currency: string
    platform_fee_percent: number
  }
  hosting: {
    mode: 'sovereign' | 'centralized'
    endpoint: string
  }
  payment_methods: Array<{ type: string; [key: string]: unknown }>
  capabilities: string[]
  openai_compatible: boolean
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatChunk {
  id: string
  content: string | null
  finishReason: string | null
}

export interface AuthOptions {
  /** API key (e.g. "ak_abc123") — sent as Bearer token */
  apiKey?: string
  /** x402 SpendAuth JSON — sent as X-Payment-Signature header */
  x402Signature?: string
  /** MPP credential (base64url) — sent as Authorization: Payment header */
  mppCredential?: string
  /** MPP method name (default: "blueprintevm") */
  mppMethod?: string
}

export interface ChatOptions extends AuthOptions {
  /** Whether to stream (default: true) */
  stream?: boolean
  temperature?: number
  maxTokens?: number
}

// --- Retry + resilience config ---

export interface RetryConfig {
  /** Max retry attempts (default 3; 0 disables retries). */
  maxRetries?: number
  /** Base delay in ms before first retry (default 500). */
  baseDelayMs?: number
  /** Max cap on any single delay — exponential backoff tops out here (default 10000). */
  maxDelayMs?: number
  /** HTTP status codes to retry on (default [408, 429, 500, 502, 503, 504]). */
  retryStatuses?: number[]
  /** Respect a `Retry-After` header from 429/503 responses (default true). */
  respectRetryAfter?: boolean
  /** Add ±25% jitter to each delay so clients don't thunder in sync (default true). */
  jitter?: boolean
}

export interface CircuitBreakerConfig {
  /** Consecutive failures that trip the breaker open (default 5). */
  failuresToOpen?: number
  /** How long the breaker stays open before going half-open (ms, default 30s). */
  openDurationMs?: number
}

export interface ObserverHooks {
  onRequest?: (info: { slug: string; attempt: number; method: string; url: string }) => void
  onResponse?: (info: { slug: string; attempt: number; status: number; durationMs: number; requestId?: string }) => void
  onRetry?: (info: { slug: string; attempt: number; nextAttempt: number; delayMs: number; reason: string; status?: number }) => void
  onCircuitOpen?: (info: { slug: string; failures: number; openUntilMs: number }) => void
  onCircuitClose?: (info: { slug: string }) => void
  onError?: (info: { slug: string; attempt: number; error: Error }) => void
}

export interface AgentClientOptions {
  retry?: RetryConfig
  circuitBreaker?: CircuitBreakerConfig
  observer?: ObserverHooks
  /** Override global fetch (useful in tests or to inject telemetry). */
  fetch?: typeof globalThis.fetch
}

// --- Client ---

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/

const DEFAULT_RETRY_STATUSES = [408, 429, 500, 502, 503, 504]

interface CircuitState {
  failures: number
  openUntilMs: number
}

export class AgentClient {
  private baseUrl: string
  private retry: Required<RetryConfig>
  private breaker: Required<CircuitBreakerConfig>
  private observer: ObserverHooks
  private fetchImpl: typeof globalThis.fetch
  private circuits = new Map<string, CircuitState>()

  constructor(baseUrl: string, options: AgentClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    if (!this.baseUrl.startsWith('https://') && !this.baseUrl.startsWith('http://localhost')) {
      console.warn('[agent-client] WARNING: baseUrl is not HTTPS. API keys and payment credentials will be sent in cleartext.')
    }

    this.retry = {
      maxRetries: options.retry?.maxRetries ?? 3,
      baseDelayMs: options.retry?.baseDelayMs ?? 500,
      maxDelayMs: options.retry?.maxDelayMs ?? 10_000,
      retryStatuses: options.retry?.retryStatuses ?? DEFAULT_RETRY_STATUSES,
      respectRetryAfter: options.retry?.respectRetryAfter ?? true,
      jitter: options.retry?.jitter ?? true,
    }
    this.breaker = {
      failuresToOpen: options.circuitBreaker?.failuresToOpen ?? 5,
      openDurationMs: options.circuitBreaker?.openDurationMs ?? 30_000,
    }
    this.observer = options.observer ?? {}
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  private validateSlug(slug: string): void {
    if (!SLUG_RE.test(slug)) throw new AgentClientError(`Invalid agent slug: ${slug}`, 400)
  }

  private circuitFor(slug: string): CircuitState {
    let state = this.circuits.get(slug)
    if (!state) {
      state = { failures: 0, openUntilMs: 0 }
      this.circuits.set(slug, state)
    }
    return state
  }

  /** Returns whether the circuit for `slug` is currently open (blocking calls). */
  private circuitIsOpen(slug: string): boolean {
    const state = this.circuitFor(slug)
    if (state.openUntilMs > Date.now()) return true
    if (state.openUntilMs > 0) {
      // Half-open window — reset for retry attempt
      state.openUntilMs = 0
      this.observer.onCircuitClose?.({ slug })
    }
    return false
  }

  private recordFailure(slug: string): void {
    const state = this.circuitFor(slug)
    state.failures += 1
    if (state.failures >= this.breaker.failuresToOpen) {
      const openUntilMs = Date.now() + this.breaker.openDurationMs
      state.openUntilMs = openUntilMs
      this.observer.onCircuitOpen?.({ slug, failures: state.failures, openUntilMs })
    }
  }

  private recordSuccess(slug: string): void {
    const state = this.circuitFor(slug)
    state.failures = 0
    state.openUntilMs = 0
  }

  private computeDelay(attempt: number, retryAfterSeconds?: number): number {
    if (this.retry.respectRetryAfter && retryAfterSeconds !== undefined && !isNaN(retryAfterSeconds)) {
      return Math.min(retryAfterSeconds * 1000, this.retry.maxDelayMs)
    }
    // Exponential backoff: baseDelay * 2^attempt, capped at maxDelay
    const base = Math.min(this.retry.baseDelayMs * 2 ** attempt, this.retry.maxDelayMs)
    if (!this.retry.jitter) return base
    // ±25% jitter
    const jitterRange = base * 0.25
    return Math.max(0, base - jitterRange + Math.random() * 2 * jitterRange)
  }

  /**
   * fetch with retry + circuit breaker.
   * Throws AgentClientError on final failure (including circuit open).
   */
  private async fetchWithRetry(slug: string, url: string, init: RequestInit): Promise<Response> {
    if (this.circuitIsOpen(slug)) {
      throw new AgentClientError(
        `Circuit breaker open for ${slug} — too many consecutive failures`,
        503,
      )
    }

    const method = init.method ?? 'GET'
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      const startMs = Date.now()
      this.observer.onRequest?.({ slug, attempt, method, url })

      try {
        const res = await this.fetchImpl(url, init)
        const durationMs = Date.now() - startMs
        const requestId = res.headers.get('X-Request-Id') ?? undefined
        this.observer.onResponse?.({ slug, attempt, status: res.status, durationMs, requestId })

        if (res.ok) {
          this.recordSuccess(slug)
          return res
        }

        // Retry on transient failures
        if (this.retry.retryStatuses.includes(res.status) && attempt < this.retry.maxRetries) {
          const retryAfterHeader = res.headers.get('Retry-After')
          const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined
          const delayMs = this.computeDelay(attempt, retryAfterSeconds)
          this.observer.onRetry?.({ slug, attempt, nextAttempt: attempt + 1, delayMs, reason: `http_${res.status}`, status: res.status })
          await sleep(delayMs)
          continue
        }

        // Non-retryable error — return the response for the caller to handle
        // 4xx (except the retryable ones above) count toward circuit breaker only if 5xx;
        // we don't want client-input errors to trip the breaker.
        if (res.status >= 500) this.recordFailure(slug)
        return res
      } catch (err) {
        // Network error — always retriable
        const error = err instanceof Error ? err : new Error(String(err))
        lastError = error
        this.observer.onError?.({ slug, attempt, error })
        if (attempt < this.retry.maxRetries) {
          const delayMs = this.computeDelay(attempt)
          this.observer.onRetry?.({ slug, attempt, nextAttempt: attempt + 1, delayMs, reason: 'network_error' })
          await sleep(delayMs)
          continue
        }
        // Final attempt failed
        this.recordFailure(slug)
        throw new AgentClientError(`Network error: ${error.message}`, 0)
      }
    }

    // Should be unreachable — the loop always either returns or throws
    throw new AgentClientError(lastError?.message ?? 'Request failed after retries', 0)
  }

  /** Discover agent metadata (no auth required) */
  async discover(slug: string): Promise<AgentInfo> {
    this.validateSlug(slug)
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(slug)}/chat/completions`
    const res = await this.fetchWithRetry(slug, url, { method: 'GET' })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new AgentClientError(`Discovery failed: ${res.status}`, res.status, body)
    }
    return res.json()
  }

  /** Send a chat message and get the complete response */
  async chat(slug: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const chunks: string[] = []
    for await (const chunk of this.chatStream(slug, messages, opts)) {
      if (chunk.content) chunks.push(chunk.content)
    }
    return chunks.join('')
  }

  /** Stream chat response as async iterator of chunks */
  async *chatStream(slug: string, messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatChunk> {
    this.validateSlug(slug)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // Auth
    if (opts.apiKey) {
      headers['Authorization'] = `Bearer ${opts.apiKey}`
    } else if (opts.x402Signature) {
      headers['X-Payment-Signature'] = opts.x402Signature
    } else if (opts.mppCredential) {
      headers['Authorization'] = `Payment ${opts.mppMethod ?? 'blueprintevm'} ${opts.mppCredential}`
    }

    const url = `${this.baseUrl}/v1/agents/${slug}/chat/completions`
    const res = await this.fetchWithRetry(slug, url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: slug,
        messages,
        stream: true,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new AgentClientError(
        res.status === 402 ? 'Payment required' : `Chat failed: ${res.status}`,
        res.status,
        body,
      )
    }

    const reader = res.body?.getReader()
    if (!reader) throw new AgentClientError('No response body', 0)

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue

        const data = trimmed.slice(6)
        if (data === '[DONE]') return

        try {
          const parsed = JSON.parse(data)
          if (parsed.error) {
            throw new AgentClientError(parsed.error.message ?? 'Agent error', 500)
          }

          const choice = parsed.choices?.[0]
          if (choice) {
            yield {
              id: parsed.id,
              content: choice.delta?.content ?? null,
              finishReason: choice.finish_reason ?? null,
            }
          }
        } catch (e) {
          if (e instanceof AgentClientError) throw e
          // skip malformed SSE lines
        }
      }
    }
  }
}

export class AgentClientError extends Error {
  status: number
  body?: string

  constructor(message: string, status: number, body?: string) {
    super(message)
    this.name = 'AgentClientError'
    this.status = status
    this.body = body
  }

  /** Parse 402 response body for payment instructions */
  get paymentInfo(): Record<string, unknown> | null {
    if (this.status !== 402 || !this.body) return null
    try {
      const parsed = JSON.parse(this.body)
      return parsed.error ?? null
    } catch {
      return null
    }
  }
}

// --- Internal helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
