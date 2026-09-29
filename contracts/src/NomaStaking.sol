// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title NomaStaking
 * @notice Stake $NOMA to earn the Reward Engine's assets (ZEC + the weekly Stock Token).
 * Only staked $NOMA is eligible; the $NOMA token itself is unchanged.
 *
 * - Multi-asset rewards: one reward stream per asset, assets can be added without redeploy.
 * - Rewards are streamed linearly over `rewardDuration` after each `notifyReward`, so staking
 *   just before a notification (sniping) earns only the share of the stream while staked.
 * - Unstaking has a cooldown: `requestUnstake` stops earning immediately, `withdraw` after
 *   `unstakeCooldown`.
 * - Rewards never expire: accrued rewards stay claimable, and rewards streamed while nobody
 *   is staked are queued and added to that asset's next stream.
 * - ADMIN (asset config, executor management) and EXECUTOR (notifyReward) are held by
 *   different accounts; one account can never hold both.
 */
contract NomaStaking is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @dev rewardRate carries 18 extra decimals so low-decimal assets (e.g. 8-decimal ZEC) keep
    /// precision over a 7-day stream; rewardPerToken carries another 18 so a large total stake
    /// (e.g. 1e9 * 1e18 $NOMA) does not round per-second increments down to zero.
    uint256 private constant PRECISION = 1e18;
    uint256 private constant RPT_SCALE = 1e36;
    /// @dev Upper bound on listed assets keeps per-user reward updates within block gas limits.
    uint256 public constant MAX_REWARD_ASSETS = 256;

    IERC20 public immutable stakingToken;
    uint256 public immutable unstakeCooldown;
    uint256 public immutable rewardDuration;

    struct RewardState {
        bool listed;
        bool active; // accepts new notifications; accrual and claims continue regardless
        uint64 periodFinish;
        uint64 lastUpdateTime;
        uint256 rewardRate; // asset units * PRECISION per second
        uint256 rewardPerTokenStored; // asset units * RPT_SCALE per staked token unit
        uint256 queued; // asset units * PRECISION streamed while totalStaked == 0
    }

    struct PendingUnstake {
        uint128 amount;
        uint64 unlockAt;
    }

    address[] public rewardAssets;
    mapping(address asset => RewardState) public rewardState;
    mapping(address asset => mapping(address user => uint256)) public userRewardPerTokenPaid;
    /// @dev Accrued but unclaimed rewards in asset units * RPT_SCALE. Kept scaled so the sub-unit
    /// remainder carries over between updates and claims instead of being rounded away.
    mapping(address asset => mapping(address user => uint256)) private accrued;
    mapping(address asset => mapping(address user => uint256)) public totalClaimed;

    uint256 public totalStaked;
    uint256 public totalPendingUnstake;
    mapping(address user => uint256) public stakedOf;
    mapping(address user => PendingUnstake) public pendingUnstake;

    event Staked(address indexed user, uint256 amount);
    event UnstakeRequested(address indexed user, uint256 amount, uint256 unlockAt);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardAdded(address indexed asset, uint256 amount, uint256 periodFinish);
    event Claimed(address indexed user, address indexed asset, uint256 amount);
    event RewardAssetAdded(address indexed asset);
    event RewardAssetActiveSet(address indexed asset, bool active);

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientStake();
    error NothingToWithdraw();
    error CooldownActive(uint256 unlockAt);
    error AssetNotListed(address asset);
    error AssetInactive(address asset);
    error AssetAlreadyListed(address asset);
    error InvalidRewardAsset(address asset);
    error TooManyRewardAssets();
    error RoleConflict(address account);
    error InvalidDuration();

    constructor(IERC20 stakingToken_, address admin, address executor, uint256 unstakeCooldown_, uint256 rewardDuration_) {
        if (address(stakingToken_) == address(0) || admin == address(0) || executor == address(0)) revert ZeroAddress();
        if (rewardDuration_ == 0) revert InvalidDuration();
        stakingToken = stakingToken_;
        unstakeCooldown = unstakeCooldown_;
        rewardDuration = rewardDuration_;

        _setRoleAdmin(ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(EXECUTOR_ROLE, ADMIN_ROLE);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(EXECUTOR_ROLE, executor);
    }

    // ---------------------------------------------------------------------
    // Staking
    // ---------------------------------------------------------------------

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateAll(msg.sender);
        uint256 before = stakingToken.balanceOf(address(this));
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = stakingToken.balanceOf(address(this)) - before;
        stakedOf[msg.sender] += received;
        totalStaked += received;
        emit Staked(msg.sender, received);
    }

    /// @notice Stops `amount` from earning now; it can be withdrawn after the cooldown.
    /// A new request adds to any pending amount and restarts the cooldown for the total.
    function requestUnstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > stakedOf[msg.sender]) revert InsufficientStake();
        _updateAll(msg.sender);
        stakedOf[msg.sender] -= amount;
        totalStaked -= amount;

        PendingUnstake storage p = pendingUnstake[msg.sender];
        p.amount += uint128(amount);
        p.unlockAt = uint64(block.timestamp + unstakeCooldown);
        totalPendingUnstake += amount;
        emit UnstakeRequested(msg.sender, amount, p.unlockAt);
    }

    function withdraw() external nonReentrant {
        _updateAll(msg.sender);
        PendingUnstake memory p = pendingUnstake[msg.sender];
        if (p.amount == 0) revert NothingToWithdraw();
        if (block.timestamp < p.unlockAt) revert CooldownActive(p.unlockAt);
        delete pendingUnstake[msg.sender];
        totalPendingUnstake -= p.amount;
        stakingToken.safeTransfer(msg.sender, p.amount);
        emit Withdrawn(msg.sender, p.amount);
    }

    // ---------------------------------------------------------------------
    // Rewards
    // ---------------------------------------------------------------------

    /// @notice Sends every accrued reward (ZEC + all Stock Tokens) in one transaction.
    function claimAll() external nonReentrant {
        _updateAll(msg.sender);
        uint256 n = rewardAssets.length;
        for (uint256 i; i < n; ++i) {
            _payout(rewardAssets[i], msg.sender);
        }
    }

    /// @notice Claims a subset of assets (gas-bounded alternative to claimAll).
    function claim(address[] calldata assets) external nonReentrant {
        for (uint256 i; i < assets.length; ++i) {
            address asset = assets[i];
            if (!rewardState[asset].listed) revert AssetNotListed(asset);
            _updateAsset(asset, msg.sender);
            _payout(asset, msg.sender);
        }
    }

    /**
     * @notice Streams `amount` of `asset` to stakers over `rewardDuration`. Any unstreamed
     * remainder of the current stream and any amount queued while nobody was staked are
     * folded into the new stream. Caller must have approved `amount`.
     */
    function notifyReward(address asset, uint256 amount) external nonReentrant onlyRole(EXECUTOR_ROLE) {
        RewardState storage s = rewardState[asset];
        if (!s.listed) revert AssetNotListed(asset);
        if (!s.active) revert AssetInactive(asset);
        if (amount == 0) revert ZeroAmount();
        _updateAsset(asset, address(0));

        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - before;

        uint256 total = received * PRECISION + s.queued;
        if (block.timestamp < s.periodFinish) {
            total += (s.periodFinish - block.timestamp) * s.rewardRate;
        }
        s.queued = 0;
        s.rewardRate = total / rewardDuration;
        s.lastUpdateTime = uint64(block.timestamp);
        s.periodFinish = uint64(block.timestamp + rewardDuration);
        emit RewardAdded(asset, received, s.periodFinish);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function addRewardAsset(address asset) external onlyRole(ADMIN_ROLE) {
        if (asset == address(0)) revert ZeroAddress();
        if (asset == address(stakingToken)) revert InvalidRewardAsset(asset);
        if (rewardState[asset].listed) revert AssetAlreadyListed(asset);
        if (rewardAssets.length >= MAX_REWARD_ASSETS) revert TooManyRewardAssets();
        rewardAssets.push(asset);
        rewardState[asset].listed = true;
        rewardState[asset].active = true;
        rewardState[asset].lastUpdateTime = uint64(block.timestamp);
        emit RewardAssetAdded(asset);
    }

    /// @notice Stops (or resumes) new notifications for an asset. Accrued rewards stay claimable.
    function setRewardAssetActive(address asset, bool active) external onlyRole(ADMIN_ROLE) {
        if (!rewardState[asset].listed) revert AssetNotListed(asset);
        rewardState[asset].active = active;
        emit RewardAssetActiveSet(asset, active);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function rewardAssetsLength() external view returns (uint256) {
        return rewardAssets.length;
    }

    function lastTimeRewardApplicable(address asset) public view returns (uint256) {
        uint256 finish = rewardState[asset].periodFinish;
        return block.timestamp < finish ? block.timestamp : finish;
    }

    function rewardPerToken(address asset) public view returns (uint256) {
        RewardState storage s = rewardState[asset];
        uint256 last = lastTimeRewardApplicable(asset);
        if (totalStaked == 0 || last <= s.lastUpdateTime) return s.rewardPerTokenStored;
        return s.rewardPerTokenStored + ((last - s.lastUpdateTime) * s.rewardRate * PRECISION) / totalStaked;
    }

    /// @notice Claimable amount of `asset` for `user` right now (used by Wallet Lookup).
    function earned(address user, address asset) public view returns (uint256) {
        return _accruedScaled(user, asset) / RPT_SCALE;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _accruedScaled(address user, address asset) private view returns (uint256) {
        return accrued[asset][user] + stakedOf[user] * (rewardPerToken(asset) - userRewardPerTokenPaid[asset][user]);
    }

    function _updateAll(address user) private {
        uint256 n = rewardAssets.length;
        for (uint256 i; i < n; ++i) {
            _updateAsset(rewardAssets[i], user);
        }
    }

    function _updateAsset(address asset, address user) private {
        RewardState storage s = rewardState[asset];
        uint256 last = lastTimeRewardApplicable(asset);
        if (last > s.lastUpdateTime) {
            uint256 streamed = (last - s.lastUpdateTime) * s.rewardRate;
            if (totalStaked == 0) {
                s.queued += streamed; // nobody to pay: keep it for the next stream
            } else {
                s.rewardPerTokenStored += (streamed * PRECISION) / totalStaked;
            }
            s.lastUpdateTime = uint64(last);
        }
        if (user != address(0)) {
            uint256 rpt = s.rewardPerTokenStored;
            uint256 paid = userRewardPerTokenPaid[asset][user];
            // Every action updates every listed asset; skipping no-op writes keeps finished
            // streams (most of the list after a few months) at read cost only.
            if (paid != rpt) {
                uint256 staked = stakedOf[user];
                if (staked != 0) accrued[asset][user] += staked * (rpt - paid);
                userRewardPerTokenPaid[asset][user] = rpt;
            }
        }
    }

    function _payout(address asset, address user) private {
        uint256 amount = accrued[asset][user] / RPT_SCALE;
        if (amount == 0) return;
        accrued[asset][user] -= amount * RPT_SCALE;
        totalClaimed[asset][user] += amount;
        IERC20(asset).safeTransfer(user, amount);
        emit Claimed(user, asset, amount);
    }

    /// @dev ADMIN (incl. DEFAULT_ADMIN) and EXECUTOR must be different accounts.
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (role == EXECUTOR_ROLE && (hasRole(ADMIN_ROLE, account) || hasRole(DEFAULT_ADMIN_ROLE, account))) {
            revert RoleConflict(account);
        }
        if ((role == ADMIN_ROLE || role == DEFAULT_ADMIN_ROLE) && hasRole(EXECUTOR_ROLE, account)) {
            revert RoleConflict(account);
        }
        return super._grantRole(role, account);
    }
}
