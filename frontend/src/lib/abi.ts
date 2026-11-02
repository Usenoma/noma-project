// NomaStaking + ERC20 interfaces, derived from contracts/src/NomaStaking.sol.
// Human-readable ABI fragments, parsed once here so every use site gets a real viem Abi
// (passing the raw strings to viem throws "Cannot use 'in' operator to search for 'name'").

import { parseAbi } from "viem";

export const NOMA_STAKING_ABI = parseAbi([
  "function stake(uint256 amount)",
  "function requestUnstake(uint256 amount)",
  "function withdraw()",
  "function claimAll()",
  "function claim(address[] assets)",
  "function stakedOf(address user) view returns (uint256)",
  "function pendingUnstake(address user) view returns (uint128 amount, uint64 unlockAt)",
  "function earned(address user, address asset) view returns (uint256)",
  "function totalClaimed(address user, address asset) view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function totalPendingUnstake() view returns (uint256)",
  "function rewardAssets(uint256) view returns (address)",
  "function rewardAssetsLength() view returns (uint256)",
  "function unstakeCooldown() view returns (uint256)",
  "function rewardDuration() view returns (uint256)",
  "event Staked(address indexed user, uint256 amount)",
  "event UnstakeRequested(address indexed user, uint256 amount, uint256 unlockAt)",
  "event Withdrawn(address indexed user, uint256 amount)",
  "event Claimed(address indexed user, address indexed asset, uint256 amount)",
  "event RewardAdded(address indexed asset, uint256 amount, uint256 periodFinish)",
]);

export const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const NOMA_STAKING_ADDRESS = process.env.NEXT_PUBLIC_NOMA_STAKING_ADDRESS ?? "";
export const NOMA_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_NOMA_TOKEN_ADDRESS ?? "";

/** Canonical USDG on Robinhood Chain (6 decimals). Override with NEXT_PUBLIC_USDG_ADDRESS. */
export const USDG_ADDRESS = (process.env.NEXT_PUBLIC_USDG_ADDRESS ??
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168") as `0x${string}`;
