import { config } from "../../config.js";

/**
 * Published eligibility rules, versioned so every snapshot records which rules produced it.
 * Open decision: snapshot vs. time-weighted balance. v1 = single end-of-cycle snapshot.
 */
export interface Methodology {
  version: string;
  kind: "snapshot";
  minBalance: bigint;
  excluded: string[]; // lowercase addresses: Pons curve, V4 pool/locker, RewardVault, team, ...
}

export function currentMethodology(): Methodology {
  const excluded = new Set(config.ELIGIBILITY_EXCLUDED_ADDRESSES);
  for (const a of [config.NOMA_BONDING_CURVE, config.REWARD_VAULT_ADDRESS, config.PONS_FEE_ESCROW, config.PONS_V2_MEME_HOOK]) {
    if (a) excluded.add(a.toLowerCase());
  }
  return {
    version: "v1",
    kind: "snapshot",
    minBalance: config.ELIGIBILITY_MIN_BALANCE,
    excluded: [...excluded].sort(),
  };
}

export function isEligible(address: string, balance: bigint, m: Methodology): boolean {
  return balance > 0n && balance >= m.minBalance && !m.excluded.includes(address.toLowerCase());
}
