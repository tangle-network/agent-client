# @tangle-network/agent-client

Consumer SDK for calling agent endpoints published through [`@tangle-network/agent-gateway`](https://github.com/tangle-network/agent-gateway). OpenAI-compatible chat shape, supports API key, x402 SpendAuth, and MPP credential authentication.

## Install

```bash
npm install @tangle-network/agent-client
```

## Usage

```ts
import { AgentClient } from '@tangle-network/agent-client'

const client = new AgentClient('https://gtm.tangle.tools')

// Discover agent metadata (no auth)
const info = await client.discover('my-agent')

// Chat (API key)
const response = await client.chat('my-agent',
  [{ role: 'user', content: 'Hello' }],
  { apiKey: 'ak_...' }
)

// Chat (streaming)
for await (const chunk of client.chatStream('my-agent', messages, { apiKey: 'ak_...' })) {
  process.stdout.write(chunk.content ?? '')
}

// Chat (x402 SpendAuth — no account needed)
const response = await client.chat('my-agent', messages, {
  x402Signature: signedSpendAuthJson,
})
```

## When to use this vs `@tangle-network/tcloud`

- Use **`tcloud`** to call Tangle platform services (router.tangle.tools — 671+ models, sandbox, browser, evals).
- Use **`agent-client`** to call a specific published agent app at its own URL (gtm.tangle.tools, taxes.tangle.tools, etc.).

## Related

- [`@tangle-network/agent-gateway`](https://github.com/tangle-network/agent-gateway) — server middleware this SDK talks to
- [`@tangle-network/tcloud`](https://github.com/tangle-network/tcloud) — consumer SDK for Tangle platform services

## License

MIT
