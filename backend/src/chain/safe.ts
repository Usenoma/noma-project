import {
  concat,
  encodeFunctionData,
  encodePacked,
  hashTypedData,
  parseAbi,
  size,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

/**
 * Safe multisig integration. The backend never executes reward transactions: it builds a batch,
 * signs it with a *delegate* (proposer) key and posts it to the Safe Transaction Service, where it
 * shows up in the Safe{Wallet} queue for the owners to review, sign and execute.
 * A delegate can only propose; its signature does not count towards the threshold.
 */

export interface SafeCall {
  to: Address;
  value?: bigint;
  data: Hex;
}

const multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);

/** MultiSendCallOnly payload: per call operation(0) | to | value | dataLength | data, packed. */
export function encodeMultiSend(calls: SafeCall[]): Hex {
  const packed = concat(
    calls.map((c) =>
      encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, c.value ?? 0n, BigInt(size(c.data)), c.data]),
    ),
  );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
}

export interface SafeTx {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1; // 0 = CALL, 1 = DELEGATECALL
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}

/** One call → plain CALL; several → DELEGATECALL into MultiSendCallOnly (atomic batch). */
export function buildSafeTx(calls: SafeCall[], nonce: bigint): SafeTx {
  if (!calls.length) throw new Error("empty Safe batch");
  const single = calls.length === 1 ? calls[0]! : null;
  return {
    to: single ? single.to : (config.SAFE_MULTISEND_CALL_ONLY as Address),
    value: single?.value ?? 0n,
    data: single ? single.data : encodeMultiSend(calls),
    operation: single ? 0 : 1,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce,
  };
}

export const safeTxTypedData = (safe: Address, chainId: number, tx: SafeTx) =>
  ({
    domain: { chainId, verifyingContract: safe },
    types: {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx",
    message: tx,
  }) as const;

export const safeTxHash = (safe: Address, chainId: number, tx: SafeTx) => hashTypedData(safeTxTypedData(safe, chainId, tx));

// ---------------------------------------------------------------------------
// Safe Transaction Service
// ---------------------------------------------------------------------------

async function service<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.SAFE_TX_SERVICE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(config.SAFE_API_KEY ? { Authorization: `Bearer ${config.SAFE_API_KEY}` } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`safe tx service ${init.method ?? "GET"} ${path} ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Next unused nonce: after the Safe's on-chain nonce and every already-queued proposal. */
export async function nextNonce(safe: Address): Promise<bigint> {
  const info = await service<{ nonce: number | string }>(`/api/v1/safes/${safe}/`);
  const queued = await service<{ results: { nonce: number | string }[] }>(
    `/api/v1/safes/${safe}/multisig-transactions/?executed=false&ordering=-nonce&limit=1`,
  );
  const onchain = BigInt(info.nonce);
  const lastQueued = queued.results[0] ? BigInt(queued.results[0].nonce) + 1n : 0n;
  return onchain > lastQueued ? onchain : lastQueued;
}

/** Propose a batch to the Safe queue. Returns the safeTxHash owners will see in Safe{Wallet}. */
export async function proposeSafeTx(calls: SafeCall[], origin: string): Promise<{ safeTxHash: Hex; nonce: bigint }> {
  if (!config.SAFE_ADDRESS || !config.SAFE_PROPOSER_PRIVATE_KEY || !config.CHAIN_ID) {
    throw new Error("SAFE_ADDRESS / SAFE_PROPOSER_PRIVATE_KEY / CHAIN_ID not configured");
  }
  const safe = config.SAFE_ADDRESS as Address;
  const proposer = privateKeyToAccount(config.SAFE_PROPOSER_PRIVATE_KEY as Hex);
  const nonce = await nextNonce(safe);
  const tx = buildSafeTx(calls, nonce);
  const typed = safeTxTypedData(safe, config.CHAIN_ID, tx);
  const hash = hashTypedData(typed);
  const signature = await proposer.signTypedData(typed);

  await service(`/api/v1/safes/${safe}/multisig-transactions/`, {
    method: "POST",
    body: JSON.stringify({
      to: tx.to,
      value: tx.value.toString(),
      data: tx.data,
      operation: tx.operation,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: Number(nonce),
      contractTransactionHash: hash,
      sender: proposer.address,
      signature,
      origin,
    }),
  });
  return { safeTxHash: hash, nonce };
}

export interface SafeTxStatus {
  isExecuted: boolean;
  isSuccessful: boolean | null;
  transactionHash: Hex | null;
}

export async function safeTxStatus(safeTxHash: Hex): Promise<SafeTxStatus> {
  return service<SafeTxStatus>(`/api/v1/multisig-transactions/${safeTxHash}/`);
}
