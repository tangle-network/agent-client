/**
 * x402 SpendAuth signing helper tests.
 *
 * Three contracts proved here:
 *
 *   1. Happy path produces a JSON envelope the gateway can parse
 *      (`commitment`, `signature`, `operator`, `amount`, `nonce`,
 *      `expiry` — bigints stringified). The gateway's `verifyX402`
 *      does `BigInt(raw.amount)` etc., so emitting hex would silently
 *      reject in production.
 *
 *   2. Validation rejects malformed inputs at signing time. A consumer
 *      with a typo'd operator address gets a clear local exception
 *      instead of a generic 402 with no actionable feedback.
 *
 *   3. Each call generates a fresh nonce — replay protection only
 *      works if the nonce changes per call. Two back-to-back signs
 *      against the same domain must produce different payloads.
 */

import { describe, it, expect } from 'vitest'
import { buildSpendAuth, type Eip712Signer } from '../src/x402'

const OPERATOR = '0x' + 'ab'.repeat(20)
const SIGNER_ADDR = '0x' + 'cd'.repeat(20)
const CONTRACT = '0x' + 'ef'.repeat(20)

function makeSigner(): { signer: Eip712Signer; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  const signer: Eip712Signer = {
    address: SIGNER_ADDR,
    async signTypedData(args) {
      calls.push(args)
      // Deterministic stub signature so test asserts the wire format,
      // not the cryptographic primitive.
      return '0x' + 'aa'.repeat(65)
    },
  }
  return { signer, calls }
}

describe('buildSpendAuth — happy path', () => {
  it('produces JSON with the wire format gateway verifyX402 expects', async () => {
    const { signer } = makeSigner()
    const json = await buildSpendAuth({
      operator: OPERATOR,
      chainId: 3799,
      amountWei: 20_000n,
      expirySeconds: 600,
      contractAddress: CONTRACT,
      signer,
    })
    const parsed = JSON.parse(json)
    expect(parsed.commitment).toBe(SIGNER_ADDR)
    expect(parsed.operator).toBe(OPERATOR)
    expect(parsed.amount).toBe('20000') // string, not number — gateway does BigInt() on it
    expect(parsed.signature).toMatch(/^0x[a-f0-9]+$/)
    // nonce + expiry both decimal strings parseable as BigInt.
    expect(BigInt(parsed.nonce)).toBeGreaterThan(0n)
    expect(BigInt(parsed.expiry)).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)))
  })

  it('passes the EIP-712 typed-data shape verifyX402 expects', async () => {
    const { signer, calls } = makeSigner()
    await buildSpendAuth({
      operator: OPERATOR, chainId: 3799, amountWei: 1n,
      contractAddress: CONTRACT, signer,
    })
    expect(calls).toHaveLength(1)
    const arg = calls[0]
    expect(arg.primaryType).toBe('SpendAuth')
    expect((arg.domain as Record<string, unknown>).chainId).toBe(3799)
    expect((arg.domain as Record<string, unknown>).verifyingContract).toBe(CONTRACT)
    expect(arg.types).toMatchObject({
      SpendAuth: [
        { name: 'operator' }, { name: 'amount' }, { name: 'nonce' }, { name: 'expiry' },
      ],
    })
  })

  it('omits verifyingContract from the domain when not provided', async () => {
    const { signer, calls } = makeSigner()
    await buildSpendAuth({
      operator: OPERATOR, chainId: 3799, amountWei: 1n, signer,
    })
    expect((calls[0]!.domain as Record<string, unknown>).verifyingContract).toBeUndefined()
  })

  it('honors a caller-provided nonce when supplied', async () => {
    const { signer } = makeSigner()
    const json = await buildSpendAuth({
      operator: OPERATOR, chainId: 3799, amountWei: 1n,
      nonce: 42n, signer,
    })
    expect(JSON.parse(json).nonce).toBe('42')
  })

  it('defaults expirySeconds to 600 when not provided', async () => {
    const { signer } = makeSigner()
    const before = Math.floor(Date.now() / 1000)
    const json = await buildSpendAuth({
      operator: OPERATOR, chainId: 3799, amountWei: 1n, signer,
    })
    const expiry = Number(JSON.parse(json).expiry)
    expect(expiry - before).toBeGreaterThanOrEqual(599)
    expect(expiry - before).toBeLessThanOrEqual(601)
  })
})

describe('buildSpendAuth — input validation', () => {
  it('throws when operator address is malformed', async () => {
    const { signer } = makeSigner()
    await expect(buildSpendAuth({
      operator: '0xnope', chainId: 3799, amountWei: 1n, signer,
    })).rejects.toThrow(/operator/)
  })

  it('throws when signer.address is malformed', async () => {
    const signer: Eip712Signer = {
      address: 'not-an-address',
      async signTypedData() { return '0x' + 'aa'.repeat(65) },
    }
    await expect(buildSpendAuth({
      operator: OPERATOR, chainId: 3799, amountWei: 1n, signer,
    })).rejects.toThrow(/signer\.address/)
  })

  it('throws when amount is zero', async () => {
    const { signer } = makeSigner()
    await expect(buildSpendAuth({
      operator: OPERATOR, chainId: 3799, amountWei: 0n, signer,
    })).rejects.toThrow(/positive/)
  })

  it('throws when amount is negative', async () => {
    const { signer } = makeSigner()
    await expect(buildSpendAuth({
      operator: OPERATOR, chainId: 3799, amountWei: -1n, signer,
    })).rejects.toThrow(/positive/)
  })
})

describe('buildSpendAuth — nonce freshness', () => {
  it('generates a different nonce on each call', async () => {
    const { signer } = makeSigner()
    const a = JSON.parse(await buildSpendAuth({
      operator: OPERATOR, chainId: 3799, amountWei: 1n, signer,
    }))
    const b = JSON.parse(await buildSpendAuth({
      operator: OPERATOR, chainId: 3799, amountWei: 1n, signer,
    }))
    expect(a.nonce).not.toBe(b.nonce)
  })
})
