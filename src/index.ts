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

// --- Client ---

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/

export class AgentClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    if (!this.baseUrl.startsWith('https://') && !this.baseUrl.startsWith('http://localhost')) {
      console.warn('[agent-client] WARNING: baseUrl is not HTTPS. API keys and payment credentials will be sent in cleartext.')
    }
  }

  private validateSlug(slug: string): void {
    if (!SLUG_RE.test(slug)) throw new AgentClientError(`Invalid agent slug: ${slug}`, 400)
  }

  /** Discover agent metadata (no auth required) */
  async discover(slug: string): Promise<AgentInfo> {
    this.validateSlug(slug)
    const res = await fetch(`${this.baseUrl}/v1/agents/${encodeURIComponent(slug)}/chat/completions`)
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

    const res = await fetch(`${this.baseUrl}/v1/agents/${slug}/chat/completions`, {
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
