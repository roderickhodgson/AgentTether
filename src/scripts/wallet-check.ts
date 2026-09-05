/**
 * wallet-check: point-in-time report for the payment-plane demo wallets.
 *
 * Prints Base Sepolia ETH and USDC balances for both ends of the flow — the
 * client wallet (AGENT_WALLET, the agent paying for intents) and the receiver
 * wallet (PAY_TO_ADDRESS, where settlement lands) — plus the client's Permit2
 * USDC allowance, which gates the whole `upto` flow: without it the facilitator
 * /verify answers `permit2_allowance_required` (bootstrap: run the stream
 * client once, it self-approves max allowance).
 *
 * Read-only: balances and allowances only, no transactions, no keys printed.
 * Addresses come from env per repo policy (never hardcoded); ERC-20 reads use
 * hand-rolled calldata over plain JSON-RPC, so no web3 dependency is needed.
 */
import "dotenv/config";
import { NETWORK, PAY_TO_ADDRESS, USDC_ADDRESS } from "../payments/facilitator.js";

const RPC_URL = process.env.RPC_URL ?? "https://sepolia.base.org";
// Permit2 universal approval contract — same constant the stream client approves.
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const usdc = USDC_ADDRESS.toLowerCase();

const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}

// ERC-20 selectors, ABI-encoded by hand: balanceOf(address) and allowance(address,address).
const pad = (address: string) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const balanceOfData = (address: string) => `0x70a08231${pad(address)}`;
const allowanceData = (owner: string, spender: string) => `0xdd62ed3e${pad(owner)}${pad(spender)}`;

const ethBalance = (address: string) => rpc<string>("eth_getBalance", [address, "latest"]).then(BigInt);
const tokenBalance = (address: string) => rpc<string>("eth_call", [{ to: usdc, data: balanceOfData(address) }, "latest"]).then(BigInt);
const permit2Allowance = (owner: string) => rpc<string>("eth_call", [{ to: usdc, data: allowanceData(owner, PERMIT2) }, "latest"]).then(BigInt);

function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const MAX_UINT256 = 2n ** 256n - 1n;

async function report(label: string, source: string, address: string, withAllowance: boolean) {
  const [eth, usdcBalance, allowance] = await Promise.all([
    ethBalance(address),
    tokenBalance(address),
    withAllowance ? permit2Allowance(address) : Promise.resolve(null),
  ]);

  console.log(`\n${label} (${source})`);
  console.log(`  address   ${address}`);
  console.log(`  ETH       ${formatUnits(eth, 18)} (${eth} wei)`);
  console.log(`  USDC      ${formatUnits(usdcBalance, 6)} (${usdcBalance} atomic)`);

  if (allowance === null) return;
  if (allowance === MAX_UINT256) {
    console.log("  permit2   max — client can pay");
  } else if (allowance === 0n) {
    console.log("  permit2   0 — client cannot pay yet (run `npx tsx spikes/stream-client.ts` once to self-approve; needs a little ETH)");
  } else {
    console.log(`  permit2   ${formatUnits(allowance, 6)} USDC — may fall short of a large ceiling`);
  }
}

console.log(`AgentTether wallet check — ${NETWORK} · RPC ${RPC_URL} · USDC ${usdc}`);

const agentWallet = process.env.AGENT_WALLET;
if (agentWallet && isAddress(agentWallet)) {
  await report("client wallet", "AGENT_WALLET", agentWallet, true);
} else {
  console.log("\nclient wallet (AGENT_WALLET): not configured — skipping");
}

if (PAY_TO_ADDRESS && isAddress(PAY_TO_ADDRESS)) {
  await report("receiver wallet", "PAY_TO_ADDRESS", PAY_TO_ADDRESS, false);
} else {
  console.log("\nreceiver wallet (PAY_TO_ADDRESS): not configured — settlement has nowhere to land");
}
