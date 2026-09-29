export interface CyclePool {
  total: bigint;
  zec: bigint;
  stock: bigint;
}

const BPS = 10_000n;

/**
 * cycle_total = claimed_into_safe + still_claimable_in_escrow + pending_in_pons (not yet swept);
 * split exactly 50/50. An odd unit goes to the stock side so zec + stock === total.
 */
export function cyclePool(claimedIntoSafe: bigint, claimableInEscrow: bigint, pendingInPons = 0n): CyclePool {
  const total = claimedIntoSafe + claimableInEscrow + pendingInPons;
  const zec = total / 2n;
  return { total, zec, stock: total - zec };
}

/** Creator's part of a Pons base trade fee: what is left after the protocol share (buyback off). */
export function creatorFeeShare(baseFee: bigint, protocolFeeShareBps: bigint): bigint {
  return baseFee - (baseFee * protocolFeeShareBps) / BPS;
}

/**
 * What a Pons sweep would pay the creator from pending balances, with buyback disabled:
 * the base-fee bucket minus the protocol share (computed on the aggregate, as Pons does) plus the
 * creator tax in full.
 */
export function pendingCreatorPayout(pendingBaseFee: bigint, pendingTax: bigint, protocolFeeShareBps: bigint): bigint {
  return creatorFeeShare(pendingBaseFee, protocolFeeShareBps) + pendingTax;
}
