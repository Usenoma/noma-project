# NOMA contracts

Foundry project. OpenZeppelin and forge-std come from npm (`npm install`).

| Contract | Purpose |
|----------|---------|
| `NomaStaking` | Stake $NOMA to earn the Reward Engine assets (ZEC + weekly Stock Token). Multi-asset reward streams (7 days), 7-day unstake cooldown, `claimAll`. ADMIN ≠ EXECUTOR (the Reward Engine Safe). |

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

Deployment order: NomaStaking(noma, admin, rewardEngineSafe, 604800, 604800) → ADMIN `addRewardAsset(ZEC)` and,
each week before the cycle ends, `addRewardAsset(<stock token>)`.

`test/mocks/MockPonsFeeEscrow.sol` is a test double used by the backend Safe integration test.

## Deploy

```bash
STAKING_EXECUTOR=<reward engine Safe> [STAKING_ADMIN=<admin>] [NOMA_TOKEN=<$NOMA>] [ZEC_TOKEN=<zec>] \
forge script script/DeployNomaStaking.s.sol --tc DeployNomaStaking --rpc-url <rpc> --private-key <key> --broadcast
```

Without `NOMA_TOKEN` (testnet) a mintable tNOMA is deployed; `DEPLOY_TEST_ZEC=true` adds a mintable tZEC.

**EVM version.** Robinhood Chain mainnet supports Cancun opcodes used by solc (`PUSH0`, `MCOPY`,
`TSTORE`/`TLOAD`; probed with `eth_call` on 2026-09-29); only `BLOBBASEFEE` is unsupported (unused).
The default `evm_version = "cancun"` is therefore fine for mainnet.

## Mainnet-fork rehearsal (no faucet, no cost)

Anvil cannot fork Robinhood Chain with Cancun enabled (Arbitrum block headers carry no blob gas),
so fork runs use Shanghai and a Shanghai build:

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --hardfork shanghai --port 58645
FOUNDRY_EVM_VERSION=shanghai FOUNDRY_OUT=out-shanghai forge script ... --rpc-url http://127.0.0.1:58645 --broadcast
# then, from ../backend:
FORK_RPC=http://127.0.0.1:58645 SAFE=.. STAKING=.. NOMA=.. ZEC=.. npx tsx --env-file=.env scripts/fork-rehearsal.ts
```

Result on 2026-09-29 (fork of block ~75.5M): Safe 2-of-2 created through the canonical mainnet
factory; the backend's safeTxHash matched the mainnet Safe contract; MultiSend approve +
notifyReward executed (169k gas); stake 113k gas, claimAll 168k, requestUnstake 83k, withdraw 66k;
withdraw before cooldown reverted; staker received the full 7-day stream.

### Pons V2 launch rehearsal

The deployed Pons V2 contracts need Cancun (a Shanghai fork fails with `NotActivated`). Anvil can
fork with `--hardfork cancun` as long as one local block is mined before the first call (the forked
Arbitrum head has no blob gas; the script does this):

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --hardfork cancun --port 58645
# from ../backend, against a fresh migrated database:
DATABASE_URL=postgres://…/noma_fork FORK_RPC=http://127.0.0.1:58645 npx tsx --env-file=.env scripts/pons-fork-rehearsal.ts
```

Result on 2026-09-29 (fork of block ~75.66M): public launches open; launch config 0 = 1% base
fee, 4.2 ETH graduation, 0.0005 ETH launch fee. Launched through the real factory with the Safe as
creator fee recipient, 1% creator tax, buyback off (3.51M gas). Two buys + one sell were indexed
from `CurveBuy` / `CurveSell` with block timestamps; indexed fees and taxes equal the curve's
pending balances; the live pool counted the pending creator payout; a factory-owner recipient
change raised the ALERT. The Safe swept the curve itself and claimed from the Fee Escrow in one
MultiSend (158k gas): `FeesSwept.creatorAmount` and the ETH received by the Safe both equalled the
predicted payout (0.7% base-fee share + 1% tax of volume).

Post-graduation (same run): a buy past the 4.2 ETH threshold auto-graduated the curve (its pending
fees went to the escrow for the Safe); `createGraduatedPool` (806k gas) registered the V4 pool on
the hook with the Safe as creator, under the pool id the backend derives. Swaps went through a
test-only router (`test/mocks/V4SwapRouter.sol`, never for mainnet):
- V4 sell, exact input → fee in ETH: indexed `HookFeeCollected` equals the hook's pending ETH; the
  Safe swept the pool itself and claimed in one MultiSend (148k gas); `PoolFeesSwept.creatorAmount`
  equalled the prediction.
- V4 buy with exact ETH input → fee in the memecoin: indexed as memecoin (no USD); live pool shows
  it as `pending_memecoin`; the Safe's sweep reverts (`InternalSwapRequiresOperator`) and is
  skipped. Only the Pons fee sweep operator (impersonated here) can convert and sweep it; the
  converted ETH was credited to the Safe in the escrow.
