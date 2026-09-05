/**
 * End-to-end client for the Phase 3 stream route: drives the full x402 `upto` flow
 * against a locally running AgentTether backend — POST (402) → sign Permit2 voucher →
 * retry with PAYMENT-SIGNATURE → expect 202 MONITORING. Also proves the nonce
 * idempotency path by replaying the same voucher.
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner } from "@x402/evm";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createPublicClient, createWalletClient, http, erc20Abi, maxUint256 } from "viem";
import { baseSepolia } from "viem/chains";

const BASE_URL = process.env.SERVER_URL ?? "http://localhost:8080";
const RPC_URL = process.env.RPC_URL ?? "https://sepolia.base.org";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

const pk = process.env.EVM_PRIVATE_KEY;
if (!pk) throw new Error("EVM_PRIVATE_KEY is required");

const account = privateKeyToAccount(pk.startsWith("0x") ? (pk as `0x${string}`) : (`0x${pk}` as `0x${string}`));
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(RPC_URL) });
const signer = toClientEvmSigner(account, publicClient);
const scheme = new UptoEvmScheme(signer, { rpcUrl: RPC_URL });

// Permit2 approval bootstrap (Phase 5.2a pattern): cheap allowance pre-check first,
// one-time self-approve only when short. Without it the facilitator /verify answers
// permit2_allowance_required and the whole flow stalls before signing pays off.
async function ensurePermit2Allowance(ceiling: bigint) {
  const allowance = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, PERMIT2],
  });
  if (allowance >= ceiling) {
    console.log(`permit2 allowance ok (${allowance === maxUint256 ? "max" : allowance.toString()})`);
    return;
  }
  const eth = await publicClient.getBalance({ address: account.address });
  if (eth === 0n) {
    throw new Error(
      `wallet ${account.address} needs Permit2 allowance but has no ETH for the approve tx — fund a little Base Sepolia ETH (or use the facilitator's eip2612GasSponsoring path), then re-run`,
    );
  }
  console.log("allowance short — broadcasting one-time USDC.approve(PERMIT2, max) …");
  const hash = await walletClient.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "approve",
    args: [PERMIT2, maxUint256],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`approve tx: https://sepolia.basescan.org/tx/${hash} (status ${receipt.status})`);
}

async function createIntent(): Promise<{ paymentRequired: PaymentRequired; cookie: string }> {
  const res = await fetch(`${BASE_URL}/api/v1/intents/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query_intent: "e2e: watch large USDC transfers",
      target_contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      event_condition: { minAmount: "1000000000" },
      ttl_seconds: 1800,
      webhook_url: "https://agent.example.com/hook",
    }),
  });
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (res.status !== 402 || !header) {
    throw new Error(`expected 402 + PAYMENT-REQUIRED, got ${res.status}: ${await res.text()}`);
  }
  const paymentRequired = decodePaymentRequiredHeader(header);
  const body = (await res.json()) as PaymentRequired;
  return { paymentRequired, cookie: body.accepts?.[0]?.amount ?? "" };
}

async function pay(signature: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/api/v1/intents/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": signature },
  });
  return { status: res.status, body: await res.json() };
}

const { paymentRequired } = await createIntent();
console.log("402 received:", JSON.stringify({
  scheme: paymentRequired.accepts[0].scheme,
  amount: paymentRequired.accepts[0].amount,
  resource: paymentRequired.resource.url.slice(0, 72) + "…",
}));

await ensurePermit2Allowance(BigInt(paymentRequired.accepts[0].amount));

// Sign ONCE and replay the exact same header bytes: the Permit2 nonce is minted per
// createPaymentPayload call, so re-signing would produce a new voucher — which the
// router rightly rejects as a fresh payment for an already-active intent. True
// idempotency = identical signed bytes.
const paymentResult = await scheme.createPaymentPayload(2, paymentRequired.accepts[0]);
const paymentSignature = encodePaymentSignatureHeader({
  x402Version: 2,
  resource: paymentRequired.resource,
  accepted: paymentRequired.accepts[0],
  payload: paymentResult.payload as Record<string, unknown>,
  extensions: paymentResult.extensions,
} satisfies PaymentPayload);

const first = await pay(paymentSignature);
console.log("verify response:", first.status, JSON.stringify(first.body));
if (first.status !== 202) {
  console.error("EXPECTED 202 — aborting");
  process.exit(1);
}

const replay = await pay(paymentSignature);
console.log("idempotent replay:", replay.status, JSON.stringify(replay.body));
const pass = first.status === 202 && replay.status === 202;
console.log(`\nE2E ${pass ? "PASS (+ idempotent replay)" : "FAIL (replay not idempotent)"}`);
process.exit(pass ? 0 : 1);
