import { erc20Abi, parseAbi } from "viem";

export { erc20Abi };

/**
 * RewardVault (NOMA-owned contract). Only the executor role may swap; every movement emits events.
 * TODO: replace with the compiled ABI once the contract is written.
 */
export const rewardVaultAbi = parseAbi([
  "function claimFromEscrow(address quoteAsset) returns (uint256 claimed)",
  "function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes route) returns (uint256 amountOut)",
  "function distribute(address token, address[] recipients, uint256[] amounts)",
  "event EscrowClaimed(address indexed quoteAsset, uint256 amount)",
  "event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
  "event Distributed(address indexed token, uint256 recipients, uint256 total)",
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
