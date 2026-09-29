import { erc20Abi, parseAbi } from "viem";

export { erc20Abi };

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
 * Pons V2 fee escrow (IPonsV2FeeEscrow, pons-labs contractsV2/src/v2/interfaces/ILaunchpadV2.sol).
 * Creator fees are credited here on sweep and claimed by the recipient itself (msg.sender):
 * native ETH via claim(), pair tokens via claimToken(token).
 */
export const ponsFeeEscrowAbi = parseAbi([
  "function claim() returns (uint256 amount)",
  "function claimToken(address token) returns (uint256 amount)",
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
]);

/**
 * Pons V2 fee sweeps move pending fees into the escrow. Callable by the fee sweep operator or,
 * without internal buyback, by the curve deployer (pre-graduation) / creator fee recipient
 * (post-graduation). Keep buyback disabled so the Safe can sweep itself.
 */
export const ponsSweepAbi = parseAbi([
  "function sweepFees(uint256 minBuybackTokensOut)",
  "function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)",
  "function graduated() view returns (bool)",
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
