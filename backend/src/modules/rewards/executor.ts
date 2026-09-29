import { encodeFunctionData, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";
import { config } from "../../config.js";
import { chain } from "../../chain/client.js";
import { erc20Abi, nomaStakingAbi, ponsFeeEscrowAbi, ponsSweepAbi } from "../../chain/abis/index.js";
import { proposeSafeTx, safeTxStatus, type SafeCall } from "../../chain/safe.js";
import { db } from "../../db/pool.js";
import { alert } from "../../lib/alerts.js";
import { logger } from "../../lib/logger.js";
import { usdPrice, type PayAsset } from "../payments/assets.js";
import { checkpointCycle, recordGenesis } from "../staking/service.js";

/**
 * Reward cycle execution with a Safe multisig (Pons creator fee recipient + NomaStaking EXECUTOR).
 * The backend never moves reward funds: each step is proposed to the Safe queue and waits until
 * the owners have signed and executed it.
 *
 *   cycle ends → checkpoint + GENESIS (backend only)
 *   A. claim   : sweep pending Pons fees + claim from the Pons Fee Escrow into the Safe
 *   B. swap    : 50/50 into ZEC + Stock of the Week — for now executed by the owners in Safe{Wallet}
 *                and recorded via POST /admin/cycles/:id/acquisitions (automated routing: TODO)
 *   C. fund    : approve + notifyReward(ZEC), approve + notifyReward(Stock) on NomaStaking
 *   → cycle 'distributed' (rewards streaming to stakers)
 */

type Kind = "claim" | "swap" | "fund_staking";

const safe = () => config.SAFE_ADDRESS as Address;
const isEthQuote = () => config.NOMA_QUOTE_ASSET === "ETH";
const quoteToken = (): Address => (isEthQuote() ? zeroAddress : (config.NOMA_QUOTE_ASSET as Address));

/** USD value of a raw quote-asset amount (18 decimals), or null without a price. */
async function quoteUsd(raw: bigint): Promise<string | null> {
  try {
    return ((Number(raw) / 1e18) * (await usdPrice(config.NOMA_QUOTE_ASSET as PayAsset))).toFixed(6);
  } catch {
    return null;
  }
}

interface Proposal {
  id: number;
  safe_tx_hash: Hex;
  status: "proposed" | "executed" | "failed";
  execution_tx_hash: Hex | null;
  created_at: Date;
}

/** A proposal still unsigned after this long gets a reminder (every REMIND_HOURS). */
const REMIND_HOURS = 12;

async function liveProposal(cycleId: number, kind: Kind): Promise<Proposal | undefined> {
  const { rows } = await db.query<Proposal>(
    "SELECT id, safe_tx_hash, status, execution_tx_hash, created_at FROM safe_proposals WHERE cycle_id = $1 AND kind = $2 AND status <> 'failed'",
    [cycleId, kind],
  );
  return rows[0];
}

async function propose(cycleId: number, kind: Kind, calls: (SafeCall & { label: string })[]) {
  const { safeTxHash, nonce } = await proposeSafeTx(calls, `NOMA reward cycle ${cycleId}: ${kind}`);
  await db.query("INSERT INTO safe_proposals (cycle_id, kind, safe_tx_hash, nonce, calls) VALUES ($1, $2, $3, $4, $5)", [
    cycleId,
    kind,
    safeTxHash,
    nonce.toString(),
    JSON.stringify(calls.map((c) => ({ label: c.label, to: c.to, value: (c.value ?? 0n).toString() }))),
  ]);
  await alert(
    "Safe owners: sign and execute the queued reward transaction",
    { cycleId, kind, safeTxHash, nonce: nonce.toString() },
    { kind: "action", key: `safe-proposed:${safeTxHash}`, cooldownSeconds: 30 * 86400 },
  );
}

/** Poll the Safe Transaction Service; returns the execution receipt once executed successfully. */
async function executed(p: Proposal, cycleId: number, kind: Kind) {
  if (p.status === "executed") return chain().getTransactionReceipt({ hash: p.execution_tx_hash! });
  const s = await safeTxStatus(p.safe_tx_hash);
  if (!s.isExecuted || !s.transactionHash) {
    const hours = (Date.now() - new Date(p.created_at).getTime()) / 3_600_000;
    if (hours >= REMIND_HOURS) {
      await alert(
        "Safe reward transaction still waiting for signatures",
        { cycleId, kind, safeTxHash: p.safe_tx_hash, waiting_hours: hours.toFixed(1) },
        { kind: "action", key: `safe-waiting:${p.safe_tx_hash}`, cooldownSeconds: REMIND_HOURS * 3600 },
      );
    }
    return null;
  }
  if (!s.isSuccessful) {
    await db.query("UPDATE safe_proposals SET status = 'failed', execution_tx_hash = $2, updated_at = now() WHERE id = $1", [
      p.id,
      s.transactionHash,
    ]);
    await alert("Safe reward transaction reverted; it will be re-proposed", { cycleId, kind, tx: s.transactionHash }, { key: `safe-reverted:${s.transactionHash}` });
    return null;
  }
  await db.query("UPDATE safe_proposals SET status = 'executed', execution_tx_hash = $2, updated_at = now() WHERE id = $1", [
    p.id,
    s.transactionHash,
  ]);
  return chain().getTransactionReceipt({ hash: s.transactionHash });
}

/** Include a Pons sweep only if the Safe is allowed to run it right now (simulated from the Safe). */
export async function sweepCalls(): Promise<(SafeCall & { label: string })[]> {
  const candidates: (SafeCall & { label: string })[] = [];
  if (config.NOMA_BONDING_CURVE) {
    candidates.push({
      label: "Pons curve sweepFees",
      to: config.NOMA_BONDING_CURVE as Address,
      data: encodeFunctionData({ abi: ponsSweepAbi, functionName: "sweepFees", args: [0n] }),
    });
  }
  if (config.PONS_V2_MEME_HOOK && config.NOMA_V4_POOL_ID) {
    candidates.push({
      label: "Pons V4 hook sweepPoolFees",
      to: config.PONS_V2_MEME_HOOK as Address,
      data: encodeFunctionData({ abi: ponsSweepAbi, functionName: "sweepPoolFees", args: [config.NOMA_V4_POOL_ID as Hex, 0n, 0n] }),
    });
  }
  const ok: (SafeCall & { label: string })[] = [];
  for (const c of candidates) {
    try {
      await chain().call({ account: safe(), to: c.to, data: c.data });
      ok.push(c);
    } catch (err) {
      logger.warn({ call: c.label, err: String(err).slice(0, 200) }, "sweep not callable by the Safe now; skipped");
    }
  }
  return ok;
}

/** Called every minute: start cycles that ended, then advance every executing cycle one step. */
export async function executeDueCycle(): Promise<void> {
  if (!config.SAFE_ADDRESS) return;
  const { rows: started } = await db.query<{ id: number; week_no: number }>(
    `UPDATE reward_cycles SET status = 'executing' WHERE status = 'active' AND ends_at <= now() RETURNING id, week_no`,
  );
  for (const c of started) {
    logger.info({ cycle: c.week_no }, "reward cycle ended");
    // what each staker received from the stream that just ended, before new rewards are notified
    await checkpointCycle(c.id);
    const genesis = await recordGenesis(c.id);
    if (genesis) logger.info({ cycleId: c.id, genesis }, "GENESIS stakers recorded");
  }

  const { rows: executing } = await db.query<{ id: number }>("SELECT id FROM reward_cycles WHERE status = 'executing' ORDER BY week_no");
  for (const c of executing) {
    try {
      await advanceCycle(c.id);
    } catch (err) {
      logger.error({ cycleId: c.id, err: String(err) }, "reward cycle step failed");
    }
  }
}

export async function advanceCycle(cycleId: number): Promise<void> {
  const { rows } = await db.query<{ stock_symbol: string; stock_token_address: string | null }>(
    "SELECT stock_symbol, stock_token_address FROM reward_cycles WHERE id = $1 AND status = 'executing'",
    [cycleId],
  );
  const cycle = rows[0];
  if (!cycle) return;

  // A. sweep + claim into the Safe
  const claim = await liveProposal(cycleId, "claim");
  if (!claim) {
    const escrow = config.PONS_FEE_ESCROW as Address;
    return propose(cycleId, "claim", [
      ...(await sweepCalls()),
      isEthQuote()
        ? { label: "Pons Fee Escrow claim (ETH)", to: escrow, data: encodeFunctionData({ abi: ponsFeeEscrowAbi, functionName: "claim" }) }
        : {
            label: "Pons Fee Escrow claimToken",
            to: escrow,
            data: encodeFunctionData({ abi: ponsFeeEscrowAbi, functionName: "claimToken", args: [quoteToken()] }),
          },
    ]);
  }
  const claimReceipt = await executed(claim, cycleId, "claim");
  if (!claimReceipt) return;
  const claimed = await db.query("SELECT 1 FROM escrow_claims WHERE cycle_id = $1", [cycleId]);
  if (!claimed.rowCount) {
    // the escrow implementation is not published, so measure what reached the Safe
    let amount = 0n;
    if (isEthQuote()) {
      const n = claimReceipt.blockNumber;
      amount =
        (await chain().getBalance({ address: safe(), blockNumber: n })) - (await chain().getBalance({ address: safe(), blockNumber: n - 1n }));
    } else {
      for (const log of parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: claimReceipt.logs })) {
        if (log.address.toLowerCase() === quoteToken().toLowerCase() && log.args.to.toLowerCase() === safe().toLowerCase()) {
          amount += log.args.value;
        }
      }
    }
    await db.query(
      "INSERT INTO escrow_claims (cycle_id, quote_asset, amount, amount_usd, tx_hash, ts) VALUES ($1, $2, $3, $4, $5, now())",
      [cycleId, config.NOMA_QUOTE_ASSET, amount.toString(), await quoteUsd(amount), claimReceipt.transactionHash],
    );
    await alert(
      "Safe owners: swap 50/50 into ZEC + Stock, then record via /admin",
      { cycleId, claimed: amount.toString() },
      { kind: "action", key: `cycle-swap:${cycleId}`, cooldownSeconds: 30 * 86400 },
    );
  }

  // B. swaps: recorded by an admin after the owners executed them (automated routing: TODO)
  const { rows: acquired } = await db.query<{ asset: "ZEC" | "STOCK"; amount_in: string; amount_out: string }>(
    "SELECT asset, amount_in, amount_out FROM reward_acquisitions WHERE cycle_id = $1",
    [cycleId],
  );
  if (acquired.length < 2) return;

  // C. approve + notifyReward for both assets, as one Safe batch
  const fund = await liveProposal(cycleId, "fund_staking");
  if (!fund) {
    if (!cycle.stock_token_address) throw new Error(`cycle ${cycleId} has no stock token address`);
    const staking = config.NOMA_STAKING_ADDRESS as Address;
    const calls: (SafeCall & { label: string })[] = [];
    for (const a of acquired) {
      const token = (a.asset === "ZEC" ? config.ZEC_TOKEN_ADDRESS! : cycle.stock_token_address) as Address;
      const amount = BigInt(a.amount_out);
      if (amount === 0n) continue;
      const [listed, active] = await chain().readContract({ address: staking, abi: nomaStakingAbi, functionName: "rewardState", args: [token] });
      if (!listed || !active) throw new Error(`${a.asset} ${token} is not an active NomaStaking reward asset: ADMIN must addRewardAsset`);
      const symbol = a.asset === "ZEC" ? "ZEC" : cycle.stock_symbol;
      calls.push(
        { label: `approve ${symbol} → NomaStaking`, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [staking, amount] }) },
        {
          label: `NomaStaking.notifyReward(${symbol}, ${amount})`,
          to: staking,
          data: encodeFunctionData({ abi: nomaStakingAbi, functionName: "notifyReward", args: [token, amount] }),
        },
      );
    }
    return propose(cycleId, "fund_staking", calls);
  }
  const fundReceipt = await executed(fund, cycleId, "fund_staking");
  if (!fundReceipt) return;

  // RewardAdded rows are written by the staking indexer; attach cycle and USD value (quote spent)
  for (const a of acquired) {
    const token = (a.asset === "ZEC" ? config.ZEC_TOKEN_ADDRESS! : cycle.stock_token_address!).toLowerCase();
    await db.query(
      `INSERT INTO reward_notifications (cycle_id, asset, asset_address, amount, amount_usd, stream_end, tx_hash)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7)
       ON CONFLICT (tx_hash, asset_address) DO UPDATE SET cycle_id = EXCLUDED.cycle_id, amount_usd = EXCLUDED.amount_usd`,
      [
        cycleId,
        a.asset === "ZEC" ? "ZEC" : cycle.stock_symbol,
        token,
        a.amount_out,
        await quoteUsd(BigInt(a.amount_in)),
        config.REWARD_STREAM_DURATION,
        fundReceipt.transactionHash,
      ],
    );
  }
  await db.query("UPDATE reward_cycles SET status = 'distributed' WHERE id = $1", [cycleId]);
  logger.info({ cycleId }, "cycle rewards streaming to stakers");
}

/** Admin: record the swaps the Safe owners executed. Each side must be half of the claim (±0.5%). */
export async function recordAcquisitions(
  cycleId: number,
  swaps: Record<"ZEC" | "STOCK", { amount_in: string; amount_out: string; tx_hash: Hex }>,
): Promise<void> {
  const { rows } = await db.query<{ total: string }>("SELECT COALESCE(sum(amount), 0) AS total FROM escrow_claims WHERE cycle_id = $1", [cycleId]);
  const claimed = BigInt(rows[0]!.total);
  if (claimed === 0n) throw new Error("claim not executed yet for this cycle");
  const half = claimed / 2n;
  for (const [asset, s] of Object.entries(swaps)) {
    const amountIn = BigInt(s.amount_in);
    const diff = amountIn > half ? amountIn - half : half - amountIn;
    if (diff * 1000n > half * 5n) throw new Error(`${asset} amount_in ${amountIn} is not 50% of the claim (${half})`);
    const receipt = await chain().getTransactionReceipt({ hash: s.tx_hash });
    if (receipt.status !== "success" || receipt.to?.toLowerCase() !== safe().toLowerCase()) {
      throw new Error(`${asset} swap tx ${s.tx_hash} is not a successful Safe transaction`);
    }
  }
  for (const [asset, s] of Object.entries(swaps)) {
    await db.query(
      `INSERT INTO reward_acquisitions (cycle_id, asset, amount_in, amount_out, usd_value, tx_hash, ts)
       VALUES ($1, $2, $3, $4, $5, $6, now()) ON CONFLICT (cycle_id, asset) DO NOTHING`,
      [cycleId, asset, s.amount_in, s.amount_out, await quoteUsd(BigInt(s.amount_in)), s.tx_hash],
    );
  }
}
