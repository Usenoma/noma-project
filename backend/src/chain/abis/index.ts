import { erc20Abi, parseAbi } from "viem";

export { erc20Abi };

/**
 * RewardVault (NOMA-owned contract). Only the executor role may swap; every movement emits events.
 * `fundStaking` approves NomaStaking and calls notifyReward (the vault holds NomaStaking's
 * EXECUTOR role).
 * TODO: replace with the compiled ABI once the contract is written.
 */
export const rewardVaultAbi = parseAbi([
  "function claimFromEscrow(address quoteAsset) returns (uint256 claimed)",
  "function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes route) returns (uint256 amountOut)",
  "function fundStaking(address asset, uint256 amount)",
  "event EscrowClaimed(address indexed quoteAsset, uint256 amount)",
  "event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
]);

/** NomaStaking (contracts/src/NomaStaking.sol). */
export const nomaStakingAbi = parseAbi([
  "function stake(uint256 amount)",
  "function requestUnstake(uint256 amount)",
  "function withdraw()",
  "function claimAll()",
  "function notifyReward(address asset, uint256 amount)",
  "function addRewardAsset(address asset)",
  "function totalStaked() view returns (uint256)",
  "function totalPendingUnstake() view returns (uint256)",
  "function stakedOf(address user) view returns (uint256)",
  "function pendingUnstake(address user) view returns (uint128 amount, uint64 unlockAt)",
  "function earned(address user, address asset) view returns (uint256)",
  "function totalClaimed(address asset, address user) view returns (uint256)",
  "function rewardAssets(uint256 index) view returns (address)",
  "function rewardAssetsLength() view returns (uint256)",
  "function rewardState(address asset) view returns (bool listed, bool active, uint64 periodFinish, uint64 lastUpdateTime, uint256 rewardRate, uint256 rewardPerTokenStored, uint256 queued)",
  "event Staked(address indexed user, uint256 amount)",
  "event UnstakeRequested(address indexed user, uint256 amount, uint256 unlockAt)",
  "event Withdrawn(address indexed user, uint256 amount)",
  "event RewardAdded(address indexed asset, uint256 amount, uint256 periodFinish)",
  "event Claimed(address indexed user, address indexed asset, uint256 amount)",
]);

/**
 * Pons V2 fee escrow. Creator fees accrue here and are claim-based.
 * TODO: verify function signature against the deployed Pons V2 Fee Escrow.
 */
export const ponsFeeEscrowAbi = parseAbi([
  "function claimable(address creator, address token) view returns (uint256)",
]);

/**
 * Pons V2 trade events — bonding curve (pre-graduation) and V4 singleton hook (post-graduation).
 * TODO: verify event signatures against the deployed Pons V2 contracts before enabling the indexer.
 */
export const ponsCurveAbi = parseAbi([
  "event Trade(address indexed trader, bool indexed isBuy, uint256 quoteAmount, uint256 tokenAmount, uint256 creatorFee, uint256 protocolFee)",
]);

export const ponsHookAbi = parseAbi([
  "event FeesCollected(bytes32 indexed poolId, address indexed trader, bool isBuy, uint256 quoteAmount, uint256 creatorFee, uint256 protocolFee)",
]);
