/**
 * One-time Hedera bootstrap for the oneshot demo payer.
 *
 * The payer account (HEDERA_PAYER_ACCOUNT_ID) was created by an incoming HBAR transfer
 * to an EVM alias, so it sits as a "hollow" account (key: null on the mirror node).
 * Hedera's signature checks (Blocky402's verify fetches the payer's on-chain key) need
 * the key populated: ANY transaction signed by the account's ECDSA key upgrades the
 * hollow account. This script sends 1 tinybar payer → receiver, which does exactly
 * that, and is idempotent: it skips when the mirror already shows a key.
 */
import "dotenv/config";
import { AccountId, Client, PrivateKey, TransferTransaction } from "@hiero-ledger/sdk";

const MIRROR = "https://testnet.mirrornode.hedera.com";
const payer = process.env.HEDERA_PAYER_ACCOUNT_ID;
const receiver = process.env.HEDERA_PAY_TO;
const pkRaw = process.env.EVM_PRIVATE_KEY;
if (!payer || !receiver || !pkRaw) throw new Error("HEDERA_PAYER_ACCOUNT_ID, HEDERA_PAY_TO and EVM_PRIVATE_KEY are required");

const info = await fetch(`${MIRROR}/api/v1/accounts/${receiver}`).then((r) => r.json() as Promise<{ account?: string }>);
if (!info.account) throw new Error(`receiver ${receiver} does not exist yet — send it HBAR first`);
const receiverId = info.account;

const payerInfo = await fetch(`${MIRROR}/api/v1/accounts/${payer}`).then(
  (r) => r.json() as Promise<{ key?: unknown }>,
);
if (payerInfo.key) {
  console.log(`payer ${payer} already has a key — nothing to do`);
  process.exit(0);
}

const key = PrivateKey.fromBytesECDSA(Buffer.from(pkRaw.replace(/^0x/, ""), "hex"));
console.log(`activating hollow payer ${payer} (evm key ${key.publicKey.toEvmAddress()}) → 1 tinybar to ${receiverId}`);

const client = Client.forTestnet().setOperator(AccountId.fromString(payer), key);
const tx = await new TransferTransaction()
  .addHbarTransfer(payer, -1) // tinybars
  .addHbarTransfer(receiverId, 1)
  .freezeWith(client)
  .sign(key);
const res = await tx.execute(client);
const receipt = await res.getReceipt(client);
console.log(`activation tx: ${res.transactionId.toString()} → status ${receipt.status.toString()}`);
console.log(`hashscan: https://hashscan.io/testnet/transaction/${res.transactionId.toString().replace("@", "-").replace(/\.\d+$/, (m) => m.replace(".", "-"))}`);
client.close();
