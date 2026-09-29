# NomaStaking — internal security review

Date: 2026-09-29. Scope: `src/NomaStaking.sol`. This is an internal review (static analysis +
manual review + tests), **not** a substitute for an independent audit before mainnet.

## Method

- Slither (Trail of Bits), all 102 detectors, dependencies filtered.
- Manual review: access control, reward accounting, precision, reentrancy, token behaviour, gas.
- Foundry tests (24): unit, fuzz (`neverPaysMoreThanNotified`), stateful fuzz
  (`solvencyUnderRandomActions`: 512 runs × 40 random stake/unstake/withdraw/claim/notify steps,
  asserting the contract always holds ≥ staked + pending and ≥ all accrued rewards), gas growth.

## Findings and fixes

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | Medium | A reward token that refuses a transfer (e.g. a Stock Token with KYC/allowlist restrictions) made `claimAll` revert, so the user could not claim any other asset either. | Fixed: payout uses a non-reverting transfer; a refused asset is skipped, stays claimable, `ClaimFailed` is emitted. Test: `test_restrictedRewardTokenDoesNotBlockOtherClaims`. |
| 2 | Low | Unchecked narrowing casts to `uint128` / `uint64`. | Fixed: `SafeCast`. |
| 3 | Low | Tokens sent to the contract by mistake were locked forever. | Fixed: `recoverERC20` (ADMIN), which can never touch the staking token or any listed reward asset. Test: `test_recoverStrayTokensButNeverStakeOrRewards`. |
| 4 | Info | Slither reentrancy-benign / reentrancy-no-eth: state written after the token transfer in `_payout` / `claim`. Not exploitable (all fund-moving entry points are `nonReentrant`; admin functions need roles). | Fixed anyway: checks-effects-interactions ordering. |
| 5 | Info | Precision: with 1e9 $NOMA staked and an 8-decimal asset, per-second increments rounded to 0; sub-unit remainders were lost on every interaction. | Fixed during development: rate × 1e18, rewardPerToken × 1e36, scaled `accrued` carries remainders. Test: `test_precisionWithHugeTotalStakeAndEightDecimals`. |

Remaining Slither results (intended): `divide-before-multiply` in `_payout` (floor + keep
remainder), `calls-loop` in `claimAll`, `timestamp` comparisons (cooldown/stream), `low-level-calls`
in `_tryTransfer`.

## Known limitations / trust assumptions

- **Gas grows with listed assets.** Every stake/unstake/withdraw/claimAll updates all listed assets.
  Measured stake gas: ~0.66M at 53 assets, ~1.15M at 105; a wallet inactive for 1–2 years pays
  ~4–5M once to catch up. `MAX_REWARD_ASSETS = 256` (~4.9 years of weekly stocks); beyond that a
  new version is required. `claim(address[])` is the gas-bounded alternative to `claimAll`.
- **Not upgradeable.** A bug fix means a new deployment and stakers moving themselves.
- **ADMIN is trusted** to list only well-behaved ERC-20 reward assets (no rebasing, no gas griefing).
  ADMIN and EXECUTOR can never withdraw staked $NOMA or listed reward assets.
- **EXECUTOR (the Reward Engine Safe) is trusted** for the size and timing of `notifyReward`.
- A new `requestUnstake` restarts the cooldown for the user's whole pending amount (by design).
- Rewards streamed while nobody is staked are queued and added to the asset's next stream; they are
  only released by a later `notifyReward` for that asset.
