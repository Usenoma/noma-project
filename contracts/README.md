# NOMA contracts

Foundry project. OpenZeppelin and forge-std come from npm (`npm install`).

| Contract | Purpose |
|----------|---------|
| `NomaStaking` | Stake $NOMA to earn the Reward Engine assets (ZEC + weekly Stock Token). Multi-asset reward streams (7 days), 7-day unstake cooldown, `claimAll`. ADMIN ≠ EXECUTOR (RewardVault). |

```bash
npm install
forge build
forge test -vv            # 21 tests incl. fuzz and a gas-growth measurement
```

On the build server forge runs in Docker:

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$HOME/.svm-cache:/tmp/.svm" -v "$PWD:/w" -w /w \
  ghcr.io/foundry-rs/foundry:latest "forge test -vv"
```

Deployment order: NomaStaking(noma, admin, rewardVault, 604800, 604800) → ADMIN `addRewardAsset(ZEC)` and,
each week before the cycle ends, `addRewardAsset(<stock token>)`.
