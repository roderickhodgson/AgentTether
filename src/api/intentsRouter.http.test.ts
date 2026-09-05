/**
 * HTTP-layer tests for the /stream route — the full 3.2/3.3 branch table that was
 * first validated by hand with curl, now deterministic: db.js and facilitator.js are
 * mocked, the header codecs are the real @x402/core ones, and no chain, DB or network
 * is touched. Express listens on an ephemeral port; plain fetch drives it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { intentsRouter } from "./intentsRouter.js";
import * as db from "../db.js";
import * as facilitator from "../payments/facilitator.js";

const AGENT = "0xf2fda1c0176801d009fa64aaee a2bca54a8d31c2".replace(" ", "");
const FACILITATOR_ADDRESS = "0xd407e409e34e0b9afb99ecceb609bdbcd5e7f1bf";

// Mutable module state the mock factories close over (vi.hoisted keeps it above the
// hoisted vi.mock calls). Tests vary PAY_TO_ADDRESS via the live-binding getter.
const state = vi.hoisted(() => ({
  payTo: "0x91accc3a4fdaf197972b081a5c20a0037e0db342",
}));

vi.mock("../db.js", () => ({
  createIntent: vi.fn(),
  getIntent: vi.fn(),
  getIntentByPaymentNonce: vi.fn(),
  storeVerifiedPayment: vi.fn(),
}));

vi.mock("../payments/facilitator.js", () => ({
  FACILITATOR_URL: "https://facilitator.test",
  NETWORK: "eip155:84532",
  USDC_ADDRESS: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  get PAY_TO_ADDRESS() {
    return state.payTo;
  },
  facilitator: { verify: vi.fn(), settle: vi.fn() },
  discoverUpto: vi.fn(async () => ({ facilitatorAddress: FACILITATOR_ADDRESS })),
  txExplorerUrl: (txHash: string) => `https://sepolia.basescan.org/tx/${txHash}`,
  voucherPermittedAmount: (payload: unknown) =>
    (payload as { accepted?: { amount?: string } } | null)?.accepted?.amount ?? null,
}));

const mockedDb = vi.mocked(db);
const mockedFacilitator = vi.mocked(facilitator.facilitator, true);

const validBody = {
  query_intent: "test: watch USDC",
  target_contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  event_condition: { minAmount: "1000000000" },
  ttl_seconds: 600,
};

let app: express.Express;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
  state.payTo = "0x91accc3a4fdaf197972b081a5c20a0037e0db342";
  app = express();
  app.use(express.json());
  app.use(intentsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Hand-built voucher through the REAL codec: the server only decodes and correlates
// (crypto is the facilitator's job, which is mocked), so no signing is needed here.
function signedHeader(opts: { intentId?: string; nonce?: string; deadline?: number } = {}): string {
  const intentId = opts.intentId ?? "intent-1";
  const requirements: PaymentRequirements = {
    scheme: "upto",
    network: "eip155:84532",
    asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    amount: "92900",
    payTo: state.payTo,
    maxTimeoutSeconds: 720,
    extra: { name: "USDC", version: "2", facilitatorAddress: FACILITATOR_ADDRESS },
  };
  const payload = {
    x402Version: 2,
    resource: {
      url: `http://localhost:8080/api/v1/intents/stream?intent=${intentId}`,
      description: "conditional monitoring intent",
      mimeType: "application/json",
    },
    accepted: requirements,
    payload: {
      permit2Authorization: {
        nonce: opts.nonce ?? "1234567890",
        deadline: String(opts.deadline ?? Math.floor(Date.now() / 1000) + 3600),
        from: AGENT,
      },
    },
  } as unknown as PaymentPayload;
  return encodePaymentSignatureHeader(payload);
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/v1/intents/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("3.2 — 402 issuance", () => {
  it("400s with per-field problems on an invalid body", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    const problems = ((await res.json()) as { problems: string[] }).problems;
    expect(problems).toHaveLength(4); // query_intent, target_contract, event_condition, ttl_seconds
  });

  it("rejects client-set pricing — the rate is the server's decision, never a request field", async () => {
    const res = await post({ ...validBody, rate_per_event_atomic: "1" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { problems: string[] }).problems.join(" ")).toMatch(/pricing is server-owned/);
  });

  it("rejects a non-https, non-loopback webhook_url (SSRF)", async () => {
    const res = await post({ ...validBody, webhook_url: "http://evil.example.com/hook" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { problems: string[] }).problems.join(" ")).toMatch(/webhook_url/);
  });

  it("503s when PAY_TO_ADDRESS is unset — settlement has nowhere to land", async () => {
    state.payTo = "";
    const res = await post(validBody);
    expect(res.status).toBe(503);
  });

  it("creates a PENDING_PAYMENT intent and answers 402 with decodable upto requirements", async () => {
    mockedDb.createIntent.mockResolvedValue({ id: "intent-1", status: "PENDING_PAYMENT" } as never);
    const res = await post(validBody);
    expect(res.status).toBe(402);

    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const paymentRequired = decodePaymentRequiredHeader(header!);
    const req = paymentRequired.accepts[0];
    expect(req.scheme).toBe("upto");
    expect(req.network).toBe("eip155:84532");
    expect(req.amount).toBe("5000"); // 50 blocks (600s ÷ 12s) × 100 atomic — the quoted per-block ceiling
    expect(req.payTo).toBe(state.payTo);
    expect(req.maxTimeoutSeconds).toBe(720); // ttl + 120s deadline buffer
    expect(req.extra).toMatchObject({ facilitatorAddress: FACILITATOR_ADDRESS });
    expect(paymentRequired.resource.url).toContain("intent=intent-1");

    expect(mockedDb.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        targetContract: validBody.target_contract,
        webhookUrl: undefined,
        agentWallet: "unknown",
        maxLimitAtomic: "5000",
        perBlockRateAtomic: "100",
        budgetBlocks: 50,
      }),
    );
  });
});

describe("3.3 — voucher verification branches", () => {
  it("400s on an undecodable PAYMENT-SIGNATURE header", async () => {
    const res = await post(validBody, { "PAYMENT-SIGNATURE": "!!!not-a-payload!!!" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not a decodable/);
  });

  it("400s when the payload lacks the nonce", async () => {
    const res = await post(validBody, {
      "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
        x402Version: 2,
        resource: { url: `http://localhost:8080/api/v1/intents/stream?intent=intent-1`, description: "", mimeType: "application/json" },
        accepted: {},
        payload: {},
      } as unknown as PaymentPayload),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/nonce/);
  });

  it("404s an unknown intent id", async () => {
    mockedDb.getIntentByPaymentNonce.mockResolvedValue(null);
    mockedDb.getIntent.mockResolvedValue(null);
    const res = await post(validBody, { "PAYMENT-SIGNATURE": signedHeader({ intentId: "ghost" }) });
    expect(res.status).toBe(404);
  });

  it("404s an intent that already left PENDING_PAYMENT (single-use vouchers)", async () => {
    mockedDb.getIntentByPaymentNonce.mockResolvedValue(null);
    mockedDb.getIntent.mockResolvedValue({ id: "intent-1", status: "MONITORING" } as never);
    const res = await post(validBody, { "PAYMENT-SIGNATURE": signedHeader() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/already-processed/);
  });

  it("409s when the voucher nonce is bound to a different intent", async () => {
    mockedDb.getIntentByPaymentNonce.mockResolvedValue({ id: "other-intent", status: "MONITORING" } as never);
    const res = await post(validBody, { "PAYMENT-SIGNATURE": signedHeader({ intentId: "intent-1" }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/another intent/);
  });

  it("answers an idempotent 202 for a replayed voucher on the same intent — without re-verifying", async () => {
    mockedDb.getIntentByPaymentNonce.mockResolvedValue({ id: "intent-1", status: "MONITORING" } as never);
    const res = await post(validBody, { "PAYMENT-SIGNATURE": signedHeader({ intentId: "intent-1" }) });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { idempotent: boolean; job_id: string };
    expect(body).toMatchObject({ idempotent: true, job_id: "intent-1" });
    expect(mockedFacilitator.verify).not.toHaveBeenCalled();
    expect(mockedDb.storeVerifiedPayment).not.toHaveBeenCalled();
  });

  it("402s with the facilitator's invalidReason when verification fails", async () => {
    mockedDb.getIntentByPaymentNonce.mockResolvedValue(null);
    mockedDb.getIntent.mockResolvedValue({
      id: "intent-1",
      status: "PENDING_PAYMENT",
      createdAt: new Date(),
      ttlTimestamp: new Date(Date.now() + 600_000),
      maxLimitAtomic: "92900",
    } as never);
    mockedFacilitator.verify.mockResolvedValue({ isValid: false, invalidReason: "insufficient_funds" } as never);
    const res = await post(validBody, { "PAYMENT-SIGNATURE": signedHeader() });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_funds");
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(mockedDb.storeVerifiedPayment).not.toHaveBeenCalled();
  });

  it("rejects a voucher whose deadline does not cover ttl + buffer", async () => {
    const ttlAt = new Date(Date.now() + 600_000);
    mockedDb.getIntentByPaymentNonce.mockResolvedValue(null);
    mockedDb.getIntent.mockResolvedValue({
      id: "intent-1", status: "PENDING_PAYMENT", createdAt: new Date(), ttlTimestamp: ttlAt, maxLimitAtomic: "92900",
    } as never);
    mockedFacilitator.verify.mockResolvedValue({ isValid: true, payer: AGENT } as never);
    const tooShort = Math.floor(ttlAt.getTime() / 1000) + 120 - 1;
    const res = await post(validBody, { "PAYMENT-SIGNATURE": signedHeader({ deadline: tooShort }) });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/deadline must be ≥ ttl \+ 120s/);
  });

  it("202s on success — stores the verified voucher with the payer and settles nothing", async () => {
    const ttlAt = new Date(Date.now() + 600_000);
    mockedDb.getIntentByPaymentNonce.mockResolvedValue(null);
    mockedDb.getIntent.mockResolvedValue({
      id: "intent-1", status: "PENDING_PAYMENT", createdAt: new Date(), ttlTimestamp: ttlAt, maxLimitAtomic: "92900",
    } as never);
    mockedFacilitator.verify.mockResolvedValue({ isValid: true, payer: AGENT } as never);
    mockedDb.storeVerifiedPayment.mockResolvedValue({
      id: "intent-1", status: "MONITORING", eventsMatched: 0, ttlTimestamp: ttlAt,
    } as never);

    const res = await post(validBody, { "PAYMENT-SIGNATURE": signedHeader({ deadline: Math.floor(ttlAt.getTime() / 1000) + 120 }) });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ job_id: "intent-1", status: "MONITORING", agent_wallet: AGENT, events_matched: 0 });

    expect(mockedFacilitator.settle).not.toHaveBeenCalled(); // deferred by design (3.1)
    expect(mockedDb.storeVerifiedPayment).toHaveBeenCalledWith(
      "intent-1", "1234567890", expect.anything(), AGENT,
    );
  });
});
