import { type Address, type Hex } from "viem";
import { config } from "../../config.js";
import { chain } from "../../chain/client.js";
import { ponsCurveAbi, ponsFactoryAbi, ponsFeeEscrowAbi, ponsHookAbi } from "../../chain/abis/index.js";
import { db, getCursor, setCursor, tx } from "../../db/pool.js";
import { alert } from "../../lib/alerts.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../redis.js";
import { usdPrice, type PayAsset } from "../payments/assets.js";
import { creatorFeeShare, cyclePool, pendingCreatorPayout } from "./poolMath.js";
import { activeCycle, livePoolKey } from "./service.js";

const CURSOR = "reward-indexer";
const MAX_RANGE = 2_000n;
const QUOTE_DECIMALS = 18; // TODO: read from pair token if NOMA_QUOTE_ASSET is not ETH

const isEthQuote = () => config.NOMA_QUOTE_ASSET === "ETH";

async function quoteUsd(raw: bigint): Promise<string | null> {
  try {
    const price = await usdPrice(config.NOMA_QUOTE_ASSET as PayAsset);
    return ((Number(raw) / 10 ** QUOTE_DECIMALS) * price).toFixed(6);
  } catch {
    return null;
  }
}

interface Accrual {
  source: "pons_curve" | "pons_v4_hook";
  txHash: Hex;
  logIndex: number;
  block: bigint;
  trader: Address | null;
  side: "buy" | "sell" | null;
  tradeQuoteAmount: bigint | null;
  feeCurrency: "quote" | "memecoin";
  baseFee: bigint;
  tax: bigint;
}

/** Fee policy frozen per launch: read once per process. */
let curveShareBps: bigint | undefined;
let hookLaunch: { quoteToken: Address; memecoin: Address; protocolFeeShareBps: bigint } | undefined;

async function curveProtocolShare(): Promise<bigint> {
  curveShareBps ??= BigInt(
    await chain().readContract({ address: config.NOMA_BONDING_CURVE as Address, abi: ponsCurveAbi, functionName: "protocolFeeShareBps" }),
  );
  return curveShareBps;
}

/** The pool is registered on the hook only at graduation; undefined before that. */
async function hookLaunchInfo() {
  if (hookLaunch) return hookLaunch;
  const r = await chain().readContract({
    address: config.PONS_V2_MEME_HOOK as Address,
    abi: ponsHookAbi,
    functionName: "launches",
    args: [config.NOMA_V4_POOL_ID as Hex],
  });
  const [registered, , memecoin, quoteToken, creator, , , , protocolFeeShareBps, , , , buybackEnabled] = r;
  if (!registered) return undefined;
  if (config.SAFE_ADDRESS && creator.toLowerCase() !== config.SAFE_ADDRESS.toLowerCase()) {
    await alert("Pons pool creator fee recipient is not the Reward Engine Safe", { creator, safe: config.SAFE_ADDRESS }, { key: "pons-pool-creator", cooldownSeconds: 6 * 3600 });
  }
  if (buybackEnabled) {
    await alert("Pons buyback is enabled for $NOMA; the Safe can no longer sweep pool fees itself", {}, { key: "pons-buyback", cooldownSeconds: 6 * 3600 });
  }
  hookLaunch = { quoteToken, memecoin, protocolFeeShareBps: BigInt(protocolFeeShareBps) };
  return hookLaunch;
}

async function blockTimes(client: ReturnType<typeof chain>, blocks: bigint[]): Promise<Map<bigint, Date>> {
  const unique = [...new Set(blocks)];
  const headers = await Promise.all(unique.map((b) => client.getBlock({ blockNumber: b })));
  return new Map(headers.map((h) => [h.number!, new Date(Number(h.timestamp) * 1000)]));
}

/**
 * $NOMA's creator fees go wherever the factory says; its owner can redirect them after a 3-day
 * timelock. Any proposal, cancellation or update for our token is an alert.
 */
async function watchFeeRecipient(client: ReturnType<typeof chain>, fromBlock: bigint, toBlock: bigint): Promise<void> {
  if (!config.PONS_V2_FACTORY || !config.NOMA_TOKEN_ADDRESS) return;
  const token = config.NOMA_TOKEN_ADDRESS.toLowerCase();
  // the factory serves every launch; these events are rare, so filter by token here
  const logs = await client.getContractEvents({ address: config.PONS_V2_FACTORY as Address, abi: ponsFactoryAbi, fromBlock, toBlock });
  for (const l of logs) {
    if (l.args.token?.toLowerCase() !== token) continue;
    const args = Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
    await alert("$NOMA creator fee recipient change on the Pons factory", { event: l.eventName, tx: l.transactionHash, ...args }, { key: `pons-recipient:${l.transactionHash}:${l.logIndex}`, cooldownSeconds: 30 * 86400 });
  }
}

/**
 * Indexes one block range of Pons fee accruals, then refreshes the live pool for the public Reward
 * Engine page. Staking positions are indexed by staking/indexer.ts.
 *
 * Per trade the creator receives creator_fee_share_amount (base fee minus the protocol share) plus
 * creator_tax_amount; amount_usd is their sum when quote-denominated. Whether the base-fee share
 * funds rewards is an open decision; the Safe claims both from the escrow either way.
 */
export async function indexRewards(): Promise<void> {
  const hasHook = Boolean(config.PONS_V2_MEME_HOOK && config.NOMA_V4_POOL_ID);
  if (!config.NOMA_BONDING_CURVE && !hasHook) return;
  const client = chain();
  const head = await client.getBlockNumber();
  const cursor = (await getCursor(CURSOR)) ?? (config.REWARD_INDEXER_START_BLOCK ?? head) - 1n;
  const fromBlock = cursor + 1n;
  if (fromBlock > head) return refreshLivePool();
  const toBlock = fromBlock + MAX_RANGE - 1n < head ? fromBlock + MAX_RANGE - 1n : head;

  const [curveLogs, hookLogs] = await Promise.all([
    config.NOMA_BONDING_CURVE
      ? client.getContractEvents({ address: config.NOMA_BONDING_CURVE as Address, abi: ponsCurveAbi, fromBlock, toBlock })
      : Promise.resolve([]),
    hasHook
      ? client.getContractEvents({
          address: config.PONS_V2_MEME_HOOK as Address,
          abi: ponsHookAbi,
          eventName: "HookFeeCollected",
          args: { poolId: config.NOMA_V4_POOL_ID as Hex },
          fromBlock,
          toBlock,
        })
      : Promise.resolve([]),
    watchFeeRecipient(client, fromBlock, toBlock),
  ]);

  const accruals: Accrual[] = [];
  for (const l of curveLogs) {
    const base = { source: "pons_curve" as const, txHash: l.transactionHash, logIndex: l.logIndex, block: l.blockNumber };
    if (l.eventName === "CurveBuy") {
      const a = l.args;
      accruals.push({ ...base, trader: a.buyer!, side: "buy", tradeQuoteAmount: a.quoteIn!, feeCurrency: "quote", baseFee: a.fee!, tax: a.tax! });
    } else if (l.eventName === "CurveSell") {
      const a = l.args;
      // gross quote traded = paid out + fee + tax
      const gross = a.quoteOut! + a.fee! + a.tax!;
      accruals.push({ ...base, trader: a.seller!, side: "sell", tradeQuoteAmount: gross, feeCurrency: "quote", baseFee: a.fee!, tax: a.tax! });
    }
  }
  if (hookLogs.length) {
    const launch = (await hookLaunchInfo())!; // HookFeeCollected implies a registered pool
    for (const l of hookLogs) {
      const isQuote = l.args.currency!.toLowerCase() === launch.quoteToken.toLowerCase();
      accruals.push({
        source: "pons_v4_hook",
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        block: l.blockNumber,
        trader: null, // HookFeeCollected carries no trader or side
        side: null,
        tradeQuoteAmount: null,
        feeCurrency: isQuote ? "quote" : "memecoin",
        baseFee: l.args.feeAmount!,
        tax: l.args.taxAmount!,
      });
    }
  }

  const cycle = await activeCycle();
  const times = await blockTimes(client, accruals.map((a) => a.block));
  const curveShare = curveLogs.length ? await curveProtocolShare() : 0n;

  await tx(async (q) => {
    for (const a of accruals) {
      const shareBps = a.source === "pons_curve" ? curveShare : hookLaunch!.protocolFeeShareBps;
      const creatorShare = creatorFeeShare(a.baseFee, shareBps);
      await q.query(
        `INSERT INTO fee_accruals (cycle_id, source, tx_hash, log_index, block, trader, side, quote_asset, fee_currency,
           trade_quote_amount, base_fee_amount, creator_fee_share_amount, creator_tax_amount, amount_usd, ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        [
          cycle?.id ?? null,
          a.source,
          a.txHash,
          a.logIndex,
          a.block.toString(),
          a.trader?.toLowerCase() ?? null,
          a.side,
          config.NOMA_QUOTE_ASSET,
          a.feeCurrency,
          a.tradeQuoteAmount?.toString() ?? null,
          a.baseFee.toString(),
          creatorShare.toString(),
          a.tax.toString(),
          a.feeCurrency === "quote" ? await quoteUsd(creatorShare + a.tax) : null,
          times.get(a.block)!,
        ],
      );
    }
    await setCursor(CURSOR, toBlock, q);
  });

  if (accruals.length) logger.info({ fromBlock, toBlock, accruals: accruals.length }, "reward-indexer range indexed");
  await refreshLivePool();
}

/**
 * Creator payout still sitting in Pons (not yet swept into the escrow), in the quote asset.
 * Memecoin-denominated hook fees are returned separately: their quote value is only known once the
 * Pons operator converts them.
 */
async function pendingInPons(): Promise<{ quote: bigint; memecoin: bigint }> {
  const client = chain();
  let quote = 0n;
  let memecoin = 0n;
  if (config.NOMA_BONDING_CURVE) {
    const curve = config.NOMA_BONDING_CURVE as Address;
    const [fee, tax, share] = await Promise.all([
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: "quoteFeeBalance" }),
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: "creatorTaxBalance" }),
      curveProtocolShare(),
    ]);
    quote += pendingCreatorPayout(fee, tax, share);
  }
  const launch = config.PONS_V2_MEME_HOOK && config.NOMA_V4_POOL_ID ? await hookLaunchInfo() : undefined;
  if (launch) {
    const hook = config.PONS_V2_MEME_HOOK as Address;
    const poolId = config.NOMA_V4_POOL_ID as Hex;
    const read = (fn: "pendingFees" | "pendingCreatorTax", currency: Address) =>
      client.readContract({ address: hook, abi: ponsHookAbi, functionName: fn, args: [poolId, currency] });
    const [qFee, qTax, mFee, mTax] = await Promise.all([
      read("pendingFees", launch.quoteToken),
      read("pendingCreatorTax", launch.quoteToken),
      read("pendingFees", launch.memecoin),
      read("pendingCreatorTax", launch.memecoin),
    ]);
    quote += pendingCreatorPayout(qFee, qTax, launch.protocolFeeShareBps);
    memecoin += pendingCreatorPayout(mFee, mTax, launch.protocolFeeShareBps);
  }
  return { quote, memecoin };
}

/** pool = claimed into the Safe this cycle + the Safe's balance in the Pons Fee Escrow + pending in Pons. */
export async function refreshLivePool(): Promise<void> {
  const cycle = await activeCycle();
  if (!cycle || !config.PONS_FEE_ESCROW || !config.SAFE_ADDRESS) return;
  const safe = config.SAFE_ADDRESS as Address;
  const escrow = config.PONS_FEE_ESCROW as Address;

  // The escrow keys native ETH separately (credit/claim/balanceOf) from pair tokens (…Token variants).
  const [{ rows }, claimable, pending] = await Promise.all([
    db.query<{ claimed: string }>("SELECT COALESCE(sum(amount), 0) AS claimed FROM escrow_claims WHERE cycle_id = $1", [cycle.id]),
    isEthQuote()
      ? chain().readContract({ address: escrow, abi: ponsFeeEscrowAbi, functionName: "balanceOf", args: [safe] })
      : chain().readContract({
          address: escrow,
          abi: ponsFeeEscrowAbi,
          functionName: "balanceOfToken",
          args: [safe, config.NOMA_QUOTE_ASSET as Address],
        }),
    pendingInPons(),
  ]);
  const pool = cyclePool(BigInt(rows[0]!.claimed), claimable, pending.quote);

  await redis.hset(livePoolKey(cycle.id), {
    quote_asset: config.NOMA_QUOTE_ASSET,
    claimed: rows[0]!.claimed,
    claimable: claimable.toString(),
    pending: pending.quote.toString(),
    pending_memecoin: pending.memecoin.toString(),
    total: pool.total.toString(),
    zec: pool.zec.toString(),
    stock: pool.stock.toString(),
    total_usd: (await quoteUsd(pool.total)) ?? "",
    zec_usd: (await quoteUsd(pool.zec)) ?? "",
    stock_usd: (await quoteUsd(pool.stock)) ?? "",
    updated_at: new Date().toISOString(),
  });
  await watchMemecoinPending(pending.memecoin);
}

const MEMECOIN_PENDING_SINCE = "rewards:memecoin-pending-since";

/**
 * Memecoin-denominated hook fees block the Safe's own pool sweep (quote fees included) until the
 * Pons fee sweep operator converts them. Alert when that has not happened for too long.
 */
async function watchMemecoinPending(amount: bigint): Promise<void> {
  if (amount === 0n) {
    await redis.del(MEMECOIN_PENDING_SINCE);
    return;
  }
  await redis.set(MEMECOIN_PENDING_SINCE, String(Date.now()), "NX");
  const hours = (Date.now() - Number(await redis.get(MEMECOIN_PENDING_SINCE))) / 3_600_000;
  if (hours >= config.MEMECOIN_FEES_PENDING_ALERT_HOURS) {
    await alert(
      "Pons has not converted $NOMA memecoin fees; the Safe cannot sweep the pool",
      { pending_memecoin: amount.toString(), pending_hours: hours.toFixed(1) },
      { key: "memecoin-pending", cooldownSeconds: 12 * 3600 },
    );
  }
}
