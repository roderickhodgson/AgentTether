/**
 * Payment-plane facilitator access: a single HTTPFacilitatorClient plus capability
 * discovery. The facilitator advertises its `facilitatorAddress` via GET /supported —
 * that address must be embedded in every `upto` PaymentRequirements `extra` so the
 * client's Permit2 witness binds the voucher to this facilitator (never hardcoded).
 * Hedera kinds (exact + feePayer) are discovered the same way for the oneshot route.
 */
import { HTTPFacilitatorClient } from "@x402/core/server";
import { logger } from "../logger.js";

export const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
export const HEDERA_FACILITATOR_URL = process.env.HEDERA_FACILITATOR_URL ?? "https://api.testnet.blocky402.com";
// CAIP-2 chain id (e.g. eip155:84532) — the x402 Network type is a `namespace:reference` template.
export const NETWORK = (process.env.NETWORK ?? "eip155:84532") as `${string}:${string}`;
export const USDC_ADDRESS = process.env.USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PAY_TO_ADDRESS = process.env.PAY_TO_ADDRESS ?? "";

export const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

export type UptoDiscovery = { facilitatorAddress: string };

// Explorer URI for a settlement tx, keyed by the CAIP-2 payment network. Covers the
// Base family the demo settles on; unknown networks log the bare hash ("" prefix).
const EXPLORER_TX_BASE: Record<string, string> = {
  "eip155:84532": "https://sepolia.basescan.org/tx/",
  "eip155:8453": "https://basescan.org/tx/",
  "eip155:1": "https://etherscan.io/tx/",
};

export function txExplorerUrl(txHash: string): string {
  return (EXPLORER_TX_BASE[NETWORK] ?? "") + txHash;
}

// The `upto` amount the client actually signed (the voucher's permitted ceiling) — the
// server-side story is: 402 advertised `maxLimitAtomic` ≥ voucher `permitted.amount` ≥
// settled `actual`. Logging all three makes the money legible end to end.
export function voucherPermittedAmount(payload: unknown): string | null {
  const accepted = (payload as { accepted?: { amount?: string } } | null)?.accepted;
  return accepted?.amount ?? null;
}

let uptoCache: UptoDiscovery | null = null;

export async function discoverUpto(): Promise<UptoDiscovery> {
  if (uptoCache) return uptoCache;
  const supported = await facilitator.getSupported();
  const kind = supported.kinds.find((k) => k.scheme === "upto" && k.network === NETWORK);
  const facilitatorAddress = (kind?.extra as Record<string, string> | undefined)?.facilitatorAddress;
  if (!facilitatorAddress) {
    throw new Error(`facilitator ${FACILITATOR_URL} does not advertise upto on ${NETWORK}`);
  }
  uptoCache = { facilitatorAddress };
  logger.info(
    { facilitator: FACILITATOR_URL, network: NETWORK, facilitatorAddress },
    "facilitator capability discovered",
  );
  return uptoCache;
}
