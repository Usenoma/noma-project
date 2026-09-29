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
 * Pons V2 bonding curve (PonsV2BondingCurve.sol, pons-labs contractsV2 @ 4bea1cf).
 * `fee` is the base trade fee (split protocol / buyback / creator on sweep); `tax` is the creator
 * tax, paid to the creator in full. Both are quote-denominated and accrue in the curve until swept.
 */
export const ponsCurveAbi = parseAbi([
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
  "function protocolFeeShareBps() view returns (uint16)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function graduated() view returns (bool)",
]);

/**
 * Pons V2 V4 singleton hook (hooks/PonsV2MemeHook.sol). HookFeeCollected is emitted per swap in the
 * swap's unspecified currency, which may be the memecoin; memecoin fees are converted to the quote
 * asset only when the Pons fee sweep operator sweeps the pool.
 */
export const ponsHookAbi = parseAbi([
  "event HookFeeCollected(bytes32 indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount)",
  "function launches(bytes32 poolId) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)",
  "function pendingFees(bytes32 poolId, address currency) view returns (uint256)",
  "function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)",
]);

/** Pons V2 launch factory: its owner can redirect a launch's creator fees after a 3-day timelock. */
export const ponsFactoryAbi = parseAbi([
  "event CreatorFeeRecipientChangeProposed(address indexed token, address indexed currentRecipient, address indexed proposedRecipient, uint256 effectiveAt, uint256 expiresAt)",
  "event CreatorFeeRecipientChangeCancelled(address indexed token, address indexed proposedRecipient)",
  "event CreatorFeeRecipientUpdated(address indexed token, address indexed previousRecipient, address indexed newRecipient)",
]);
