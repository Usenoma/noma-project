export interface CyclePool {
  total: bigint;
  zec: bigint;
  stock: bigint;
}

/**
 * cycle_total = claimed_into_vault + still_claimable_in_escrow; split exactly 50/50.
 * An odd unit goes to the stock side so zec + stock === total.
 */
export function cyclePool(claimedIntoVault: bigint, claimableInEscrow: bigint): CyclePool {
  const total = claimedIntoVault + claimableInEscrow;
  const zec = total / 2n;
  return { total, zec, stock: total - zec };
}
