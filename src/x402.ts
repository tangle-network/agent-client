/**
 * x402 SpendAuth signing helper.
 *
 * Produces the JSON payload an agent-gateway expects in the
 * `X-Payment-Signature` header. The actual ECDSA / EIP-712 signature is
 * delegated to a caller-provided signer — this keeps agent-client free
 * of any wallet library dependency. Wire it up to viem, ethers, an
 * embedded MetaMask provider, or a hardware-wallet bridge; whatever
 * exposes EIP-712 typed-data signing works.
 *
 * Why this lives in agent-client:
 *
 *   The previous client accepted a pre-signed `x402Signature` string —
 *   correct, but it offloaded ALL of: domain construction, typed-data
 *   shape, nonce generation, expiry windowing, JSON envelope onto every
 *   consumer. Three different consumers writing this got it three
 *   different ways; each one had a subtle bug (reused nonce, wrong
 *   chainId, hex/dec mismatch on amount) that surfaced as a 402 with
 *   no actionable feedback. Centralizing the helper here gives every
 *   consumer one canonical implementation, leaves the wallet choice up
 *   to them, and makes the interaction with `verifyX402` a single hop.
 *
 * Usage:
 *
 *   import { buildSpendAuth } from '@tangle-network/agent-client/x402'
 *   import { walletClient } from './my-viem-setup'
 *
 *   const signature = await buildSpendAuth({
 *     operator: '0x…',
 *     chainId: 3799,
 *     amountWei: 20_000n,
 *     expirySeconds: 600,
 *     contractAddress: '0xShieldedCredits…',
 *     signer: {
 *       address: walletClient.account.address,
 *       async signTypedData(args) {
 *         return walletClient.signTypedData(args)
 *       },
 *     },
 *   })
 *
 *   const stream = client.chatStream('agent-slug', messages, {
 *     x402Signature: signature,
 *   })
 */

/**
 * Minimal signer interface that matches both viem's WalletClient.signTypedData
 * and ethers v6 Wallet.signTypedData (after thin adapter). Consumers wrap
 * their wallet library to fit this shape — typically one or two lines.
 */
export interface Eip712Signer {
  /** Hex-encoded address of the signer; copied into the SpendAuth's
   *  `commitment` field so the gateway can validate the signature. */
  address: string
  /** Sign EIP-712 typed data, returning a hex signature. */
  signTypedData(args: {
    domain: { name: string; version: string; chainId: number; verifyingContract?: string }
    types: Record<string, Array<{ name: string; type: string }>>
    primaryType: string
    message: Record<string, unknown>
  }): Promise<string>
}

export interface BuildSpendAuthArgs {
  /** Operator (gateway) address. Must match the gateway's
   *  `X402Config.operatorAddress`; mismatches reject with `invalid_spend_auth`. */
  operator: string
  /** Chain id the ShieldedCredits contract is deployed on. */
  chainId: number
  /** Payment amount in wei (or smallest token unit). */
  amountWei: bigint
  /** Seconds from now until the payment auth expires. Default 600 (10 min).
   *  The gateway rejects payments where `expiry` is in the past. Keep this
   *  small; SpendAuth payloads are short-lived by design — they authorize
   *  one chat call, not a session. */
  expirySeconds?: number
  /** Optional override for the EIP-712 nonce. By default, a 96-bit
   *  random nonce is generated; pass an override only when implementing
   *  deterministic replay tests or chained payments. */
  nonce?: bigint
  /** ShieldedCredits contract address — populates `verifyingContract`
   *  in the EIP-712 domain. Optional because some operator
   *  configurations omit verifyingContract; supply it when you have it
   *  to harden the signature against domain-collision replays. */
  contractAddress?: string
  /** EIP-712 domain name. Defaults to "ShieldedCredits" — match
   *  whatever the operator's contract uses. */
  domainName?: string
  /** EIP-712 domain version. Defaults to "1". */
  domainVersion?: string
  /** The signer that will produce the EIP-712 signature. */
  signer: Eip712Signer
}

const SPEND_AUTH_TYPES = {
  SpendAuth: [
    { name: 'operator', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
}

/**
 * Build a signed x402 SpendAuth payload.
 *
 * Returns the JSON-encoded payload ready to drop into the
 * `X-Payment-Signature` header (or `auth.x402Signature` of `chatStream`).
 *
 * Throws when:
 *   - `operator` is not a 0x-prefixed 40-hex address
 *   - `amountWei` is not strictly positive
 *   - `signer.address` doesn't match a 0x-prefixed 40-hex address
 *
 * Pure: no network I/O; the only side-effect is calling `signer.signTypedData`.
 * Loud failure on bad inputs surfaces consumer bugs at signing time
 * rather than letting them propagate as a generic 402 from the gateway.
 */
export async function buildSpendAuth(args: BuildSpendAuthArgs): Promise<string> {
  validateAddress('operator', args.operator)
  validateAddress('signer.address', args.signer.address)
  if (args.amountWei <= 0n) {
    throw new Error(`buildSpendAuth: amountWei must be positive, got ${args.amountWei}`)
  }

  const expiry = BigInt(Math.floor(Date.now() / 1000) + (args.expirySeconds ?? 600))
  const nonce = args.nonce ?? generateNonce()

  const domain = {
    name: args.domainName ?? 'ShieldedCredits',
    version: args.domainVersion ?? '1',
    chainId: args.chainId,
    ...(args.contractAddress ? { verifyingContract: args.contractAddress } : {}),
  }

  const message = {
    operator: args.operator,
    amount: args.amountWei,
    nonce,
    expiry,
  }

  const signature = await args.signer.signTypedData({
    domain,
    types: SPEND_AUTH_TYPES,
    primaryType: 'SpendAuth',
    message,
  })

  // The wire format is JSON with bigints stringified — the gateway's
  // verify.ts does BigInt(raw.amount) etc., so we MUST emit decimal
  // strings, not hex. JSON.stringify with a replacer handles bigints
  // explicitly because the default behavior throws.
  const payload = {
    commitment: args.signer.address,
    signature,
    operator: args.operator,
    amount: args.amountWei.toString(),
    nonce: nonce.toString(),
    expiry: expiry.toString(),
  }
  return JSON.stringify(payload)
}

/**
 * Generate a 96-bit random nonce. Wide enough that birthday collisions
 * on a single signer are negligible (would need ~2^48 ≈ 280T sigs).
 * Cryptographic randomness only — never `Math.random` because the
 * gateway uses the nonce as a replay-protection key.
 */
function generateNonce(): bigint {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

function validateAddress(field: string, value: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`buildSpendAuth: ${field} must be a 0x-prefixed 40-hex address, got ${value}`)
  }
}
