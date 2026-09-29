export interface Holder {
  address: string;
  balance: bigint;
}

export interface Allocation {
  address: string;
  amount: bigint;
}

/**
 * Pro-rata by balance, floored per holder. Dust (total - sum) stays in the vault for the next cycle,
 * so the sum of allocations never exceeds `total`.
 */
export function allocateProRata(total: bigint, holders: Holder[]): { allocations: Allocation[]; dust: bigint } {
  const supply = holders.reduce((s, h) => s + h.balance, 0n);
  if (supply === 0n || total === 0n) return { allocations: [], dust: total };

  const allocations: Allocation[] = [];
  let sum = 0n;
  for (const h of holders) {
    const amount = (total * h.balance) / supply;
    if (amount > 0n) {
      allocations.push({ address: h.address, amount });
      sum += amount;
    }
  }
  return { allocations, dust: total - sum };
}
