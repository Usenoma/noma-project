import { encodeFunctionData, parseEventLogs, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { chain, walletFor } from "../chain/client.js";
import { erc20Abi } from "../chain/abis/index.js";
import { depositAddress, depositPrivateKey, xprvMatchesXpub } from "../chain/depositAddress.js";
import { sendOnce, type TxRequest } from "../chain/sendOnce.js";
import { db } from "../db/pool.js";
import { alert } from "../lib/alerts.js";
import { logger } from "../lib/logger.js";
import { assetInfo, usdPrice, type PayAsset } from "../modules/payments/assets.js";

/**
 * Invoices the payment watcher no longer reads (it decides by deposit-address balance, so an
 * address must never be swept while its invoice is still watched):
 * - confirmed / late_paid, once the payer is recorded (the ETH payer lookup needs the balance)
 *   or an hour has passed;
 * - expired and past the watcher's 7-day late-payment window (a payment this late was never
 *   refunded: swept to the treasury and alerted for a manual refund). Checked up to 30 days.
 * An address already swept is not re-checked; later deposits need a manual sweep.
 */
const CANDIDATES_SQL = `
  SELECT i.id, i.asset, i.pay_to, i.address_index, i.status, i.order_id,
         (SELECT max(round) FROM sweeps s WHERE s.invoice_id = i.id) AS last_round,
         (SELECT status FROM sweeps s WHERE s.invoice_id = i.id ORDER BY round DESC LIMIT 1) AS last_status
  FROM invoices i
  WHERE ((i.status IN ('confirmed', 'late_paid') AND (i.payer_address IS NOT NULL OR i.expires_at < now() - interval '1 hour'))
      OR (i.status = 'expired' AND i.expires_at < now() - interval '7 days' AND i.expires_at > now() - interval '30 days'))
    AND NOT EXISTS (SELECT 1 FROM sweeps s WHERE s.invoice_id = i.id AND s.status = 'swept')
  ORDER BY i.created_at
  LIMIT 200`;

interface Candidate {
  id: string;
  asset: PayAsset;
  pay_to: Address;
  address_index: string;
  status: "confirmed" | "late_paid" | "expired";
  order_id: string;
  last_round: number | null;
  last_status: "pending" | "swept" | null;
}

/** maxFeePerGas headroom: fees are fixed when signed, so a sweep must still land if the base fee rises. */
const FEE_HEADROOM = 2n;

export function assertSweeperConfig(): void {
  if (!config.PAYMENT_XPRV || !config.PAYMENT_XPUB) throw new Error("PAYMENT_XPRV and PAYMENT_XPUB are required");
  if (!config.TREASURY_ADDRESS) throw new Error("TREASURY_ADDRESS is required");
  if (!xprvMatchesXpub(config.PAYMENT_XPRV, config.PAYMENT_XPUB)) {
    throw new Error("PAYMENT_XPRV does not match PAYMENT_XPUB; refusing to sweep");
  }
}

async function fees() {
  const f = await chain().estimateFeesPerGas();
  return { maxFeePerGas: f.maxFeePerGas * FEE_HEADROOM, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
}

async function balanceOf(asset: PayAsset, holder: Address): Promise<bigint> {
  const token = assetInfo(asset).token;
  return token
    ? chain().readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] })
    : chain().getBalance({ address: holder });
}

async function worthSweeping(asset: PayAsset, amount: bigint): Promise<boolean> {
  if (amount <= 0n) return false;
  const usd = (Number(amount) / 10 ** assetInfo(asset).decimals) * (await usdPrice(asset).catch(() => 0));
  return usd >= config.SWEEP_MIN_USD;
}

const signed = async (purpose: string) => (await db.query("SELECT 1 FROM chain_txs WHERE purpose = $1", [purpose])).rows.length > 0;

/** Sweeps one deposit address; true when swept. Idempotent per (invoice, round) through sendOnce purposes. */
async function sweepOne(c: Candidate): Promise<boolean> {
  const index = BigInt(c.address_index);
  const key = depositPrivateKey(index, config.PAYMENT_XPRV!);
  const from = privateKeyToAccount(key).address;
  if (from.toLowerCase() !== c.pay_to.toLowerCase() || depositAddress(index).toLowerCase() !== from.toLowerCase()) {
    throw new Error(`invoice ${c.id}: derived key does not control ${c.pay_to}`);
  }
  const treasury = config.TREASURY_ADDRESS as Address;
  const info = assetInfo(c.asset);

  // a pending round is resumed; once its transfer is signed, sendOnce re-broadcasts that exact tx
  const round = c.last_status === "pending" ? c.last_round! : (c.last_round ?? 0) + 1;
  const purpose = `sweep:${c.id}:${round}`;
  const deposit = walletFor(key, "deposit");
  // Once the transfer is signed, sendOnce ignores the request and re-uses that exact tx (the gas
  // top-up, if any, landed before it was signed); nothing needs re-estimating.
  let request: TxRequest = { to: treasury };

  if (!(await signed(purpose))) {
    const balance = await balanceOf(c.asset, from);
    if (!(await worthSweeping(c.asset, balance))) return false;
    const f = await fees();
    let topup = 0n;
    if (!info.token) {
      const gas = await chain().estimateGas({ account: from, to: treasury, value: 1n });
      const value = balance - gas * f.maxFeePerGas;
      if (value <= 0n) return false;
      request = { to: treasury, value, gas, ...f };
    } else {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [treasury, balance] });
      const gas = ((await chain().estimateGas({ account: from, to: info.token, data })) * 12n) / 10n;
      const have = await chain().getBalance({ address: from });
      topup = gas * f.maxFeePerGas > have ? gas * f.maxFeePerGas - have : 0n;
      request = { to: info.token, data, gas, ...f };
    }

    await db.query(
      `INSERT INTO sweeps (invoice_id, round, asset, from_address, to_address) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (invoice_id, round) DO NOTHING`,
      [c.id, round, c.asset, from.toLowerCase(), treasury.toLowerCase()],
    );
    if (c.status === "expired") {
      await alert(
        "payment arrived after the late-payment window; swept to the treasury, refund manually",
        { invoiceId: c.id, orderId: c.order_id, asset: c.asset, amount: balance.toString(), deposit: from },
        { key: `sweep-unrefunded:${c.id}`, cooldownSeconds: 30 * 86400 },
      );
    }

    const gasPurpose = `sweep-gas:${c.id}:${round}`;
    if (info.token && (topup > 0n || (await signed(gasPurpose)))) {
      const r = await sendOnce(gasPurpose, walletFor(config.SWEEPER_GAS_PRIVATE_KEY, "sweeper gas"), { to: from, value: topup });
      const sent = (await chain().getTransaction({ hash: r.transactionHash })).value;
      await db.query("UPDATE sweeps SET gas_topup = $3 WHERE invoice_id = $1 AND round = $2", [c.id, round, sent.toString()]);
    }
  }

  const receipt = await sendOnce(purpose, deposit, request);
  const amount = info.token
    ? parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
        .filter((l) => l.address.toLowerCase() === info.token!.toLowerCase())
        .reduce((s, l) => s + l.args.value, 0n)
    : (await chain().getTransaction({ hash: receipt.transactionHash })).value;
  await db.query(
    "UPDATE sweeps SET status = 'swept', amount = $3, tx_hash = $4, updated_at = now() WHERE invoice_id = $1 AND round = $2",
    [c.id, round, amount.toString(), receipt.transactionHash],
  );
  logger.info({ invoiceId: c.id, asset: c.asset, amount: amount.toString(), tx: receipt.transactionHash }, "deposit swept to treasury");
  return true;
}

/** One pass over sweepable deposit addresses; returns how many were swept. */
export async function sweepDeposits(): Promise<number> {
  assertSweeperConfig();
  const { rows } = await db.query<Candidate>(CANDIDATES_SQL);
  let swept = 0;
  for (const c of rows) {
    try {
      if (await sweepOne(c)) swept++;
    } catch (err) {
      await alert("deposit sweep failed", { invoiceId: c.id, asset: c.asset, err: String(err).slice(0, 300) }, { key: `sweep-failed:${c.id}`, cooldownSeconds: 6 * 3600 });
    }
  }
  return swept;
}

