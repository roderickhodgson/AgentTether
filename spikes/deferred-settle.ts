import { createPublicClient, createWalletClient, erc20Abi, http, maxUint256 } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner } from "@x402/evm";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import fs from "node:fs";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const NETWORK = "eip155:84532" as const;

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const RPC_URL = process.env.RPC_URL ?? "https://sepolia.base.org";
const PAYLOAD_FILE = process.env.PAYLOAD_FILE ?? new URL("./payload.json", import.meta.url).pathname;
const CEILING = process.env.CEILING ?? "5000000";
const ACTUAL = process.env.ACTUAL ?? "1858";

const [, , mode = "discover"] = process.argv;
const waitSeconds = Number(envOrFlag("--wait", "WAIT_SECONDS") ?? 0);
const reuse = process.argv.includes("--reuse");

function envOrFlag(flag: string, envKey: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[envKey];
}

function sleep(seconds: number) {
  return new Promise<void>((r) => setTimeout(r, seconds * 1000));
}

function log(label: string, value: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function link(hash: string) {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

async function main() {
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

  if (mode === "discover") {
    const supported = await facilitator.getSupported();
    const upto = supported.kinds.filter(
      (k) => k.scheme === "upto" && String(k.network).startsWith("eip155"),
    );
    log("upto kinds", upto);
    log("extensions", supported.extensions);
    log("hedera kinds", supported.kinds.filter((k) => String(k.network).startsWith("hedera")));
    return;
  }

  const pk = process.env.EVM_PRIVATE_KEY;
  if (!pk) {
    console.error("EVM_PRIVATE_KEY is required for this mode");
    process.exit(1);
  }

  const account = privateKeyToAccount(pk.startsWith("0x") ? (pk as `0x${string}`) : (`0x${pk}` as `0x${string}`));
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(RPC_URL) });
  const signer = toClientEvmSigner(account, publicClient);

  console.log(`agent wallet:   ${account.address}`);
  console.log(`facilitator:    ${FACILITATOR_URL}`);
  console.log(`rpc:            ${RPC_URL} (chain ${NETWORK})`);
  console.log(`mode:           ${mode} · wait ${waitSeconds}s · reuse ${reuse}`);

  const [balance, allowance, ethBalance] = await Promise.all([
    publicClient.readContract({ address: USDC_BASE_SEPOLIA, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: USDC_BASE_SEPOLIA, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2] }),
    publicClient.getBalance({ address: account.address }),
  ]);
  console.log(`USDC balance:   ${balance}`);
  console.log(`Permit2 allow.: ${allowance}`);
  console.log(`ETH balance:    ${ethBalance}`);

  if (balance < BigInt(CEILING)) {
    console.error(`\nINSUFFICIENT USDC: wallet holds ${balance}, needs ${CEILING}.`);
    console.error("Mint test USDC at https://faucet.circle.com (Base Sepolia), then re-run.");
  }
  if (allowance < BigInt(CEILING)) {
    if (ethBalance === 0n) {
      console.error("\nPermit2 allowance is short and wallet has no ETH for the approve tx.");
      console.error("Either fund a little Base Sepolia ETH (any public faucet) or use the");
      console.error("facilitator's eip2612GasSponsoring extension (not wired in this spike).");
      process.exit(1);
    }
    console.log("\nPermit2 allowance short — broadcasting USDC.approve(PERMIT2, max) ...");
    const approveHash = await walletClient.writeContract({
      address: USDC_BASE_SEPOLIA,
      abi: erc20Abi,
      functionName: "approve",
      args: [PERMIT2, maxUint256],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(`approve tx:     ${link(approveHash)} (status ${receipt.status})`);
  }

  const receiver = privateKeyToAccount(generatePrivateKey());
  console.log(`receiver payTo: ${receiver.address} (fresh, unfunded)`);

  const supported = await facilitator.getSupported();
  const uptoKind = supported.kinds.find((k) => k.scheme === "upto" && k.network === NETWORK);
  const facilitatorAddress = (uptoKind?.extra as Record<string, string> | undefined)?.facilitatorAddress;
  if (!facilitatorAddress) throw new Error("facilitator does not advertise upto on eip155:84532");
  console.log(`facilitatorAddr ${facilitatorAddress}`);

  const requirements: PaymentRequirements = {
    scheme: "upto",
    network: NETWORK,
    asset: USDC_BASE_SEPOLIA,
    amount: CEILING,
    payTo: receiver.address,
    maxTimeoutSeconds: 3600,
    extra: { name: "USDC", version: "2", facilitatorAddress },
  };

  const resource = {
    url: "https://spike.agenttether.dev/api/v1/intents/stream",
    description: "AgentTether deferred-settle spike",
    mimeType: "application/json",
  };

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource,
    accepts: [requirements],
  };

  let payload: PaymentPayload;
  if (reuse && fs.existsSync(PAYLOAD_FILE)) {
    payload = JSON.parse(fs.readFileSync(PAYLOAD_FILE, "utf8"));
    console.log("\npayload reused from", PAYLOAD_FILE);
  } else {
    const scheme = new UptoEvmScheme(signer, { rpcUrl: RPC_URL });
    const result = await scheme.createPaymentPayload(2, requirements);
    payload = {
      x402Version: 2,
      resource,
      accepted: requirements,
      payload: result.payload as Record<string, unknown>,
      extensions: result.extensions,
    };
    fs.writeFileSync(PAYLOAD_FILE, JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2));
    console.log(`\npayload signed and persisted to ${PAYLOAD_FILE}`);
  }

  const auth = (payload.payload as { permit2Authorization?: { deadline: string; permitted?: { amount: string } } })
    .permit2Authorization;
  if (auth) {
    const deadline = Number(auth.deadline);
    const remaining = Math.floor(deadline - Date.now() / 1000);
    console.log(`permit deadline in ${remaining}s (ceiling ${auth.permitted?.amount ?? "?"})`);
    if (waitSeconds + 60 > remaining) {
      console.error(`WARNING: wait ${waitSeconds}s leaves < 60s deadline margin`);
    }
  }

  const verification: VerifyResponse = await facilitator.verify(payload, requirements);
  log("verify (amount = ceiling)", verification);
  if (!verification.isValid) {
    console.error("VERIFY FAILED — aborting before settle");
    process.exit(1);
  }

  if (waitSeconds > 0) {
    console.log(`\n... deferring settlement for ${waitSeconds}s (verify→settle gap) ...`);
    await sleep(waitSeconds);
    const stillValid = await facilitator.verify(payload, requirements);
    log("re-verify after wait", stillValid);
  }

  let settleAmount: string;
  switch (mode) {
    case "exceed":
      settleAmount = (BigInt(CEILING) + 1n).toString();
      break;
    case "zero":
      settleAmount = "0";
      break;
    default:
      settleAmount = ACTUAL;
  }

  const settleRequirements: PaymentRequirements = { ...requirements, amount: settleAmount };
  const settlement: SettleResponse = await facilitator.settle(payload, settleRequirements);
  log(`settle (amount = ${settleAmount})`, settlement);
  if (settlement.transaction) console.log(`settlement tx:  ${link(settlement.transaction)}`);

  const verdict: Record<string, string> = {};
  verdict["verify"] = verification.isValid ? "PASS" : "FAIL";
  if (mode === "exceed") {
    verdict["exceed-rejected"] = !settlement.success ? "PASS" : "FAIL (settlement should not succeed)";
    verdict["errorReason"] = settlement.errorReason ?? "(none)";
  } else if (mode === "zero") {
    verdict["zero-settle"] = settlement.success ? "PASS" : "FAIL";
    verdict["on-chain-tx"] = settlement.transaction ? "YES (unexpected?)" : "none (expected per spec)";
  } else {
    verdict["deferred-settle"] = settlement.success ? "PASS" : "FAIL";
    verdict["errorReason"] = settlement.errorReason ?? "(none)";
  }
  log("VERDICT", verdict);
}

main().catch((e) => {
  console.error("\nSPIKE ERROR:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.cause) console.error("cause:", e.cause);
  process.exit(1);
});
