/**
 * Per-block pricing model.
 *
 * The client buys a monitoring window (ttl_seconds); the backend meters the blocks it
 * actually processes and settles exactly those, pro-rata, capped by the quoted ceiling
 * (upto semantics). The window terminates at WHICHEVER runs out first — the block
 * budget or the TTL — so the backend never processes blocks the client hasn't paid
 * for, and the client never pays for blocks that never existed. An intent that never
 * fires settles its full budget at TTL (it subsidised the watch); one that fires at
 * block 263 of a 10,000-block budget settles 263 blocks.
 *
 * The ceiling is a time-derived QUOTE (ttl ÷ blockTime × rate); settlement is the
 * blocks actually processed, capped by the quote. Chain block-time drift therefore
 * lands on the backend (we absorb overage within the quote; the client's undercharge
 * on slow chains is honest metering), while the client's worst case is always the
 * quote — the upto guarantee.
 */
import "dotenv/config";

export function perBlockRateAtomic(): bigint {
  return BigInt(process.env.PER_BLOCK_RATE_ATOMIC ?? "100");
}

export function blockTimeSeconds(chain = process.env.DATA_CHAIN ?? "ethereum-mainnet"): number {
  const map: Record<string, number> = {
    "ethereum-mainnet": 12,
    base: 2,
    "base-sepolia": 2,
  };
  const configured = Number(process.env.BLOCK_TIME_S ?? map[chain] ?? 12);
  return configured > 0 ? configured : 12;
}

export type WindowQuote = { ttl: number; budgetBlocks: number; ceilingAtomic: string };

// Pure quote: clamps TTL into the router's [MIN_TTL_S, MAX_TTL_S] (NaN-safe — the pure
// source of truth even though API validation rejects bad input first), converts time to
// a block budget via the chain's block time, and multiplies by the per-block rate.
export function quoteWindow(
  ttlSeconds: number | undefined,
  rate: bigint = perBlockRateAtomic(),
  blockTimeS: number = blockTimeSeconds(),
  minTtlS = 60,
  maxTtlS = 86_400,
): WindowQuote {
  const requested = Number(ttlSeconds ?? 0);
  const ttl = Number.isFinite(requested) ? Math.min(maxTtlS, Math.max(minTtlS, Math.floor(requested))) : minTtlS;
  const budgetBlocks = Math.max(1, Math.ceil(ttl / blockTimeS));
  return { ttl, budgetBlocks, ceilingAtomic: (BigInt(budgetBlocks) * rate).toString() };
}
