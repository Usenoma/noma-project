import { keccak256, type Address, type Hex, type TransactionReceipt } from "viem";
import { db } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { chain, robinhoodChain, type NomaWallet } from "./client.js";

export interface TxRequest {
  to: Address;
  data?: Hex;
  value?: bigint;
  /** Fixed gas terms, e.g. when value = balance - gas cost (a sweep of the whole balance). */
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/**
 * Exactly-once send for fund-moving transactions. The signed tx and its hash are stored under
 * `purpose` before broadcast; a retry with the same purpose re-broadcasts the same signed tx
 * (a no-op if it already landed) and waits for its receipt, never signing a second one.
 */
export async function sendOnce(purpose: string, wallet: NomaWallet, req: TxRequest): Promise<TransactionReceipt> {
  const { rows } = await db.query<{ tx_hash: Hex; raw_tx: Hex }>("SELECT tx_hash, raw_tx FROM chain_txs WHERE purpose = $1", [
    purpose,
  ]);
  let hash: Hex;
  let raw: Hex;

  if (rows[0]) {
    ({ tx_hash: hash, raw_tx: raw } = rows[0]);
  } else {
    // simulate first so a revert surfaces before anything is signed or recorded
    await chain().call({ account: wallet.account, to: req.to, data: req.data, value: req.value });
    const prepared = await wallet.prepareTransactionRequest({
      account: wallet.account,
      chain: robinhoodChain,
      to: req.to,
      data: req.data,
      value: req.value,
      gas: req.gas,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas,
    });
    raw = await wallet.signTransaction(prepared);
    hash = keccak256(raw);
    await db.query("INSERT INTO chain_txs (purpose, tx_hash, raw_tx) VALUES ($1, $2, $3)", [purpose, hash, raw]);
  }

  const known = await chain().getTransaction({ hash }).catch(() => null);
  if (!known) {
    await chain()
      .sendRawTransaction({ serializedTransaction: raw })
      .catch((err) => logger.warn({ err, purpose, hash }, "re-broadcast rejected; waiting on recorded hash"));
  }

  const receipt = await chain().waitForTransactionReceipt({ hash, timeout: 180_000 });
  await db.query("UPDATE chain_txs SET status = $2 WHERE purpose = $1", [purpose, receipt.status]);
  if (receipt.status !== "success") throw new Error(`${purpose} reverted: ${hash}`);
  return receipt;
}
