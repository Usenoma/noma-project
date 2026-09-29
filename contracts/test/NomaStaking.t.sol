// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {NomaStaking} from "../src/NomaStaking.sol";

contract MockToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name, uint8 dec) ERC20(name, name) {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Stock-token-like asset with transfer restrictions: blocked recipients cannot receive.
contract RestrictedToken is MockToken {
    mapping(address => bool) public blocked;

    constructor() MockToken("RSTK", 18) {}

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "recipient not allowed");
        super._update(from, to, value);
    }
}

contract NomaStakingTest is Test {
    uint256 constant WEEK = 7 days;

    MockToken noma;
    MockToken zec; // 8 decimals, like ZEC
    MockToken nvda; // stock token of week 1
    NomaStaking staking;

    address admin = makeAddr("admin");
    address executor = makeAddr("executor"); // RewardVault in production
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_000_000);
        noma = new MockToken("NOMA", 18);
        zec = new MockToken("ZEC", 8);
        nvda = new MockToken("NVDA", 18);
        staking = new NomaStaking(noma, admin, executor, WEEK, WEEK);

        vm.startPrank(admin);
        staking.addRewardAsset(address(zec));
        staking.addRewardAsset(address(nvda));
        vm.stopPrank();

        for (uint256 i; i < 2; ++i) {
            address u = i == 0 ? alice : bob;
            noma.mint(u, 1_000_000e18);
            vm.prank(u);
            noma.approve(address(staking), type(uint256).max);
        }
        zec.mint(executor, 1_000_000e8);
        nvda.mint(executor, 1_000_000e18);
        vm.startPrank(executor);
        zec.approve(address(staking), type(uint256).max);
        nvda.approve(address(staking), type(uint256).max);
        vm.stopPrank();
    }

    function _stake(address u, uint256 amount) internal {
        vm.prank(u);
        staking.stake(amount);
    }

    function _notify(MockToken asset, uint256 amount) internal {
        vm.prank(executor);
        staking.notifyReward(address(asset), amount);
    }

    // --- roles -----------------------------------------------------------

    function test_onlyExecutorCanNotify() public {
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, staking.EXECUTOR_ROLE()));
        vm.prank(admin);
        staking.notifyReward(address(zec), 1e8);
    }

    function test_onlyAdminCanAddAsset() public {
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, executor, staking.ADMIN_ROLE()));
        vm.prank(executor);
        staking.addRewardAsset(address(0xBEEF));
    }

    function test_adminAndExecutorMustDiffer() public {
        bytes32 executorRole = staking.EXECUTOR_ROLE();
        bytes32 adminRole = staking.ADMIN_ROLE();
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(NomaStaking.RoleConflict.selector, admin));
        staking.grantRole(executorRole, admin);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(NomaStaking.RoleConflict.selector, executor));
        vm.prank(admin);
        staking.grantRole(adminRole, executor);

        vm.expectRevert(abi.encodeWithSelector(NomaStaking.RoleConflict.selector, alice));
        new NomaStaking(noma, alice, alice, WEEK, WEEK);
    }

    function test_adminCanRotateExecutor() public {
        address vault2 = makeAddr("vault2");
        bytes32 role = staking.EXECUTOR_ROLE();
        vm.startPrank(admin);
        staking.grantRole(role, vault2);
        staking.revokeRole(role, executor);
        vm.stopPrank();
        assertTrue(staking.hasRole(role, vault2));
        assertFalse(staking.hasRole(role, executor));
    }

    function test_stakingTokenCannotBeRewardAsset() public {
        vm.expectRevert(abi.encodeWithSelector(NomaStaking.InvalidRewardAsset.selector, address(noma)));
        vm.prank(admin);
        staking.addRewardAsset(address(noma));
    }

    // --- streaming ---------------------------------------------------------

    function test_rewardStreamsOverSevenDays() public {
        _stake(alice, 100e18);
        _notify(zec, 7e8);

        skip(1 days);
        assertApproxEqAbs(staking.earned(alice, address(zec)), 1e8, 1);
        skip(6 days);
        assertApproxEqAbs(staking.earned(alice, address(zec)), 7e8, 1);
        skip(3 days); // nothing after the stream ends
        assertApproxEqAbs(staking.earned(alice, address(zec)), 7e8, 1);
    }

    function test_proRataBetweenStakers() public {
        _stake(alice, 300e18);
        _stake(bob, 100e18);
        _notify(zec, 4e8);
        skip(WEEK);
        assertApproxEqAbs(staking.earned(alice, address(zec)), 3e8, 2);
        assertApproxEqAbs(staking.earned(bob, address(zec)), 1e8, 2);
    }

    function test_sniperOnlyGetsTimeWeightedShare() public {
        _stake(alice, 100e18);
        _notify(zec, 7e8);
        skip(WEEK - 1 hours);
        _stake(bob, 10_000e18); // huge stake one hour before the stream ends
        skip(1 hours);
        // bob earns at most the last hour's stream (1/168 of the reward)
        assertLt(staking.earned(bob, address(zec)), uint256(7e8) / 168 + 1);
        assertGt(staking.earned(alice, address(zec)), uint256(7e8) * 167 / 168 - 10);
    }

    function test_multiAssetClaimAllInOneTx() public {
        _stake(alice, 100e18);
        _notify(zec, 2e8);
        _notify(nvda, 5e18);
        skip(WEEK);

        vm.expectEmit(true, true, false, false);
        emit NomaStaking.Claimed(alice, address(zec), 0);
        vm.prank(alice);
        staking.claimAll();

        assertApproxEqAbs(zec.balanceOf(alice), 2e8, 1);
        assertApproxEqAbs(nvda.balanceOf(alice), 5e18, 1e6);
        assertEq(staking.earned(alice, address(zec)), 0);
        assertApproxEqAbs(staking.totalClaimed(address(zec), alice), 2e8, 1);
    }

    function test_newAssetWithoutRedeploy() public {
        MockToken tsla = new MockToken("TSLA", 18);
        vm.prank(admin);
        staking.addRewardAsset(address(tsla));
        tsla.mint(executor, 10e18);
        vm.prank(executor);
        tsla.approve(address(staking), type(uint256).max);

        _stake(alice, 1e18);
        _notify(tsla, 10e18);
        skip(WEEK);
        assertApproxEqAbs(staking.earned(alice, address(tsla)), 10e18, 1e6);
        assertEq(staking.rewardAssetsLength(), 3);
    }

    function test_rewardsDoNotExpire() public {
        _stake(alice, 100e18);
        _notify(zec, 7e8);
        skip(365 days);
        vm.prank(alice);
        staking.claimAll();
        assertApproxEqAbs(zec.balanceOf(alice), 7e8, 1);
    }

    function test_rewardWhileNobodyStakedIsQueuedNotLost() public {
        _notify(zec, 7e8); // nobody staked for the whole first stream
        skip(WEEK);
        _stake(alice, 100e18);
        _notify(zec, 7e8); // queued 7 + new 7
        skip(WEEK);
        assertApproxEqAbs(staking.earned(alice, address(zec)), 14e8, 2);
    }

    function test_leftoverOfRunningStreamRollsIntoNext() public {
        _stake(alice, 100e18);
        _notify(zec, 7e8);
        skip(3.5 days); // half streamed
        _notify(zec, 7e8); // 3.5 left + 7 new over a fresh week
        skip(WEEK);
        assertApproxEqAbs(staking.earned(alice, address(zec)), 14e8, 2);
    }

    function test_inactiveAssetStillClaimable() public {
        _stake(alice, 100e18);
        _notify(nvda, 7e18);
        vm.prank(admin);
        staking.setRewardAssetActive(address(nvda), false);
        vm.expectRevert(abi.encodeWithSelector(NomaStaking.AssetInactive.selector, address(nvda)));
        _notify(nvda, 1e18);
        skip(WEEK);
        vm.prank(alice);
        staking.claimAll();
        assertApproxEqAbs(nvda.balanceOf(alice), 7e18, 1e6);
    }

    function test_precisionWithHugeTotalStakeAndEightDecimals() public {
        noma.mint(bob, 1_000_000_000e18);
        vm.prank(bob);
        noma.approve(address(staking), type(uint256).max);
        _stake(bob, 1_000_000_000e18); // 1B NOMA
        _stake(alice, 1_000e18); // tiny share: 1e-6
        _notify(zec, 100e8); // 100 ZEC
        for (uint256 i; i < 7 * 24; ++i) {
            skip(1 hours);
            vm.prank(alice);
            staking.claimAll(); // frequent updates must not round her share away
        }
        // expected ~ 100 ZEC * 1e-6 = 1e-4 ZEC = 10_000 units
        assertApproxEqRel(zec.balanceOf(alice), 9_999, 0.001e18);
    }

    // --- unstake -----------------------------------------------------------

    function test_unstakeCooldown() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        staking.requestUnstake(40e18);
        assertEq(staking.stakedOf(alice), 60e18);
        assertEq(staking.totalPendingUnstake(), 40e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NomaStaking.CooldownActive.selector, block.timestamp + WEEK));
        staking.withdraw();

        skip(WEEK);
        uint256 before = noma.balanceOf(alice);
        vm.prank(alice);
        staking.withdraw();
        assertEq(noma.balanceOf(alice) - before, 40e18);
        assertEq(staking.totalPendingUnstake(), 0);
    }

    function test_pendingUnstakeStopsEarning() public {
        _stake(alice, 100e18);
        _stake(bob, 100e18);
        vm.prank(alice);
        staking.requestUnstake(100e18);
        _notify(zec, 7e8);
        skip(WEEK);
        assertEq(staking.earned(alice, address(zec)), 0);
        assertApproxEqAbs(staking.earned(bob, address(zec)), 7e8, 1);
    }

    function test_rewardsEarnedBeforeUnstakeRemainClaimable() public {
        _stake(alice, 100e18);
        _notify(zec, 7e8);
        skip(WEEK);
        vm.prank(alice);
        staking.requestUnstake(100e18);
        skip(WEEK);
        vm.startPrank(alice);
        staking.withdraw();
        staking.claimAll();
        vm.stopPrank();
        assertApproxEqAbs(zec.balanceOf(alice), 7e8, 1);
    }

    function test_cannotUnstakeMoreThanStaked() public {
        _stake(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(NomaStaking.InsufficientStake.selector);
        staking.requestUnstake(2e18);
    }

    // --- invariants (fuzz) ---------------------------------------------------

    /// Sum of everything claimable/claimed never exceeds what was notified.
    function testFuzz_neverPaysMoreThanNotified(uint96 a, uint96 b, uint32 t1, uint32 t2, uint64 reward) public {
        uint256 sa = bound(a, 1, 1_000_000e18);
        uint256 sb = bound(b, 1, 1_000_000e18);
        uint256 r = bound(reward, 1, 100_000e8);
        _stake(alice, sa);
        _notify(zec, r);
        skip(bound(t1, 0, 14 days));
        _stake(bob, sb);
        skip(bound(t2, 0, 14 days));
        vm.prank(alice);
        staking.claimAll();
        uint256 owed = zec.balanceOf(alice) + staking.earned(bob, address(zec));
        assertLe(owed, r);
        assertLe(zec.balanceOf(alice), zec.balanceOf(address(staking)) + zec.balanceOf(alice));
    }

    /// Gas of user actions after N weekly stock assets have been listed (every action updates all assets).
    function test_gasGrowthWithManyAssets() public {
        _stake(alice, 100e18);
        for (uint256 n = 2; n < 105; ++n) {
            MockToken a = new MockToken("STOCK", 18);
            vm.prank(admin);
            staking.addRewardAsset(address(a));
            a.mint(executor, 1e18);
            vm.startPrank(executor);
            a.approve(address(staking), 1e18);
            staking.notifyReward(address(a), 1e18);
            vm.stopPrank();
            skip(1 days);
            if (n == 52 || n == 104) {
                uint256 g = gasleft();
                _stake(alice, 1e18);
                emit log_named_uint(string.concat("stake gas, assets=", vm.toString(n + 1)), g - gasleft());
                g = gasleft();
                vm.prank(alice);
                staking.claimAll();
                emit log_named_uint(string.concat("claimAll gas, assets=", vm.toString(n + 1)), g - gasleft());
                skip(1 hours);
                g = gasleft();
                _stake(alice, 1e18);
                emit log_named_uint(string.concat("steady-state stake gas, assets=", vm.toString(n + 1)), g - gasleft());
            }
        }
    }

    // --- review fixes ------------------------------------------------------

    function test_restrictedRewardTokenDoesNotBlockOtherClaims() public {
        RestrictedToken rstk = new RestrictedToken();
        vm.prank(admin);
        staking.addRewardAsset(address(rstk));
        rstk.mint(executor, 10e18);
        vm.startPrank(executor);
        rstk.approve(address(staking), type(uint256).max);
        staking.notifyReward(address(rstk), 7e18);
        staking.notifyReward(address(zec), 7e8);
        vm.stopPrank();
        _stake(alice, 100e18);
        skip(WEEK);

        rstk.setBlocked(alice, true);
        uint256 owed = staking.earned(alice, address(rstk));
        vm.expectEmit(true, true, false, true);
        emit NomaStaking.ClaimFailed(alice, address(rstk), owed);
        vm.prank(alice);
        staking.claimAll();
        assertGt(zec.balanceOf(alice), 0); // ZEC still paid
        assertEq(rstk.balanceOf(alice), 0);
        assertEq(staking.earned(alice, address(rstk)), owed); // kept, not lost

        rstk.setBlocked(alice, false);
        vm.prank(alice);
        staking.claimAll();
        assertEq(rstk.balanceOf(alice), owed);
        assertEq(staking.totalClaimed(address(rstk), alice), owed);
    }

    function test_recoverStrayTokensButNeverStakeOrRewards() public {
        MockToken stray = new MockToken("STRAY", 18);
        stray.mint(address(staking), 5e18);
        vm.prank(admin);
        staking.recoverERC20(address(stray), admin, 5e18);
        assertEq(stray.balanceOf(admin), 5e18);

        _stake(alice, 1e18);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(NomaStaking.CannotRecover.selector, address(noma)));
        staking.recoverERC20(address(noma), admin, 1e18);
        vm.expectRevert(abi.encodeWithSelector(NomaStaking.CannotRecover.selector, address(zec)));
        staking.recoverERC20(address(zec), admin, 1);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, executor, staking.ADMIN_ROLE()));
        vm.prank(executor);
        staking.recoverERC20(address(stray), executor, 0);
    }

    /// Invariant under random actions: the contract always holds at least every staked and
    /// pending token, and at least every accrued-but-unclaimed reward.
    function testFuzz_solvencyUnderRandomActions(uint256 seed) public {
        address[3] memory users = [alice, bob, makeAddr("carol")];
        noma.mint(users[2], 1_000_000e18);
        vm.prank(users[2]);
        noma.approve(address(staking), type(uint256).max);

        for (uint256 i; i < 40; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address u = users[seed % 3];
            uint256 action = (seed >> 8) % 6;
            uint256 amt = bound(seed >> 16, 1, 1_000e18);
            vm.startPrank(u);
            if (action == 0) staking.stake(amt);
            else if (action == 1 && staking.stakedOf(u) > 0) staking.requestUnstake(bound(amt, 1, staking.stakedOf(u)));
            else if (action == 2) {
                (uint128 p, uint64 unlockAt) = staking.pendingUnstake(u);
                if (p > 0 && block.timestamp >= unlockAt) staking.withdraw();
            } else if (action == 3) staking.claimAll();
            vm.stopPrank();
            if (action == 4) _notify(zec, bound(seed >> 32, 1, 1_000e8));
            if (action == 5) _notify(nvda, bound(seed >> 32, 1, 1_000e18));
            skip(bound(seed >> 64, 0, 3 days));

            assertGe(noma.balanceOf(address(staking)), staking.totalStaked() + staking.totalPendingUnstake());
            uint256 owedZec;
            for (uint256 k; k < 3; ++k) owedZec += staking.earned(users[k], address(zec));
            assertGe(zec.balanceOf(address(staking)), owedZec);
        }
    }
}
