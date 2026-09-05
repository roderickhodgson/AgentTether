/**
 * Phase 3.4 live e2e: the oneshot pull endpoint over the STANDARD x402 client flow.
 *
 * Three beats against a live backend (`npm start`):
 *   1. UNPAID  — plain POST must 402 with the flat-fee accepts (sanity: rails advertise).
 *   2. PAID    — @x402/fetch auto-settles the 402 → 200 + transfers + a settle receipt
 *                (payment-response header carries the on-chain tx).
 *   3. PAID#2  — a second lookup pays again (fresh nonce per voucher) and returns data.
 *
 * Moves real testnet USDC (the flat fee per lookup). Exits non-zero on any failure.
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner, ExactEvmScheme } from "@x402/evm";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const BASE_URL = process.env.SERVER_URL ?? "http://localhost:8080";
const RPC_URL = process.env.RPC_URL ?? "https://sepolia.base.org";
const NETWORK = (process.env.NETWORK ?? "eip155:84532") as `eip155:${string}`;
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const BODY = {
  target_contract: USDC_MAINNET,
  min_amount_atomic: "1000000", // ≥ 1 USDC — dense enough to fill a 300-block window
  lookback_blocks: 300,
  limit: 10,
};

const pk = process.env.EVM_PRIVATE_KEY;
if (!pk) throw new Error("EVM_PRIVATE_KEY is required");
const account = privateKeyToAccount(pk.startsWith("0x") ? (pk as `0x${string}`) : (`0x${pk}` as `0x${string}`));
console.log(`payer: ${account.address}`);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
const scheme = new ExactEvmScheme(toClientEvmSigner(account, publicClient), { rpcUrl: RPC_URL });
const client = new x402Client().register(NETWORK, scheme);
const fetchWithPay = wrapFetchWithPayment(globalThis.fetch, client);

// ---- beat 1: unpaid → 402 with the flat-fee quote ---------------------------
const unpaid = await fetch(`${BASE_URL}/api/v1/intents/oneshot`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(BODY),
});
console.log(`unpaid → ${unpaid.status}`);
if (unpaid.status !== 402) throw new Error(`expected 402, got ${unpaid.status}`);
const required = unpaid.headers.get("payment-required") ?? "";
const accepts = JSON.parse(Buffer.from(required, "base64").toString()) as {
  accepts?: { scheme: string; network: string; asset?: string; amount?: string; payTo?: string }[];
};
for (const a of accepts.accepts ?? []) {
  console.log(`  rail: ${a.scheme} · ${a.network} · ${a.asset ?? "?"} · ${a.amount ?? "?"} → ${a.payTo}`);
}
if (!accepts.accepts?.length) throw new Error("402 carried no accepts");

// ---- beat 2: paid → 200 + transfers + settle receipt ------------------------
const t0 = Date.now();
const paid = await fetchWithPay(`${BASE_URL}/api/v1/intents/oneshot`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(BODY),
});
console.log(`paid → ${paid.status} in ${Date.now() - t0}ms`);
if (paid.status !== 200) {
  console.log(await paid.text());
  throw new Error(`expected 200 on the paid call, got ${paid.status}`);
}
const paymentResponse = paid.headers.get("payment-response") ?? "";
if (paymentResponse) {
  const receipt = JSON.parse(Buffer.from(paymentResponse, "base64").toString()) as {
    success?: boolean;
    transaction?: string;
    network?: string;
    payer?: string;
    amount?: string;
  };
  console.log(`  settle: success=${receipt.success} · tx=${receipt.transaction} · amount=${receipt.amount} · network=${receipt.network}`);
  if (!receipt.success || !receipt.transaction) throw new Error("no settle receipt in payment-response header");
}
const data = (await paid.json()) as {
  window?: { fromBlock: number; toBlock: number };
  head_block?: number;
  transfers?: { block_num: number; tx_hash: string; amount_atomic: string; from: string; to: string }[];
};
console.log(`  window: ${data.window?.fromBlock}–${data.window?.toBlock} (head ${data.head_block}) · ${data.transfers?.length ?? 0} transfers`);
for (const t of data.transfers ?? []) {
  console.log(`  · block ${t.block_num} ${t.amount_atomic} atomic ${t.from.slice(0, 10)}→${t.to.slice(0, 10)} tx ${t.tx_hash.slice(0, 18)}…`);
}

// ---- beat 3: paid again → a second voucher settles independently ------------
const t1 = Date.now();
const paid2 = await fetchWithPay(`${BASE_URL}/api/v1/intents/oneshot`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(BODY),
});
console.log(`paid#2 → ${paid2.status} in ${Date.now() - t1}ms`);
if (paid2.status !== 200) {
  console.log(await paid2.text());
  throw new Error(`expected 200 on the second paid call, got ${paid2.status}`);
}
const receipt2 = JSON.parse(
  Buffer.from(paid2.headers.get("payment-response") ?? "", "base64").toString(),
) as { success?: boolean; transaction?: string; amount?: string };
console.log(`  settle#2: success=${receipt2.success} · tx=${receipt2.transaction} · amount=${receipt2.amount}`);
if (!receipt2.success || !receipt2.transaction) throw new Error("second settle did not confirm");
if (receipt2.transaction === (paid.headers.get("payment-response") ? JSON.parse(Buffer.from(paid.headers.get("payment-response")!, "base64").toString()).transaction : null)) {
  throw new Error("the second lookup reused the first settle tx — nonces are not rotating");
}

console.log("\noneshot e2e: PASS (402 quote → paid 200 + receipt → second paid 200 + fresh receipt)");
process.exit(0);
