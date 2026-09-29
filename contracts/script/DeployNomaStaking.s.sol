// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NomaStaking} from "../src/NomaStaking.sol";

/// Freely mintable token for testnet runs only (stands in for $NOMA / ZEC / Stock Tokens).
contract TestnetToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name, string memory symbol, uint8 dec) ERC20(name, symbol) {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * Deploys NomaStaking.
 *
 * Env:
 *   NOMA_TOKEN        staking token; if unset (testnet), a mintable "tNOMA" is deployed
 *   STAKING_ADMIN     ADMIN (+ DEFAULT_ADMIN); defaults to the broadcaster
 *   STAKING_EXECUTOR  EXECUTOR = Reward Engine Safe (required, must differ from ADMIN)
 *   ZEC_TOKEN         listed as first reward asset if set; on testnet with DEPLOY_TEST_ZEC=true a
 *                     mintable 8-decimal "tZEC" is deployed and listed
 *   UNSTAKE_COOLDOWN, REWARD_STREAM_DURATION   seconds, default 7 days
 *
 * forge script script/DeployNomaStaking.s.sol --rpc-url $RPC --private-key $KEY --broadcast
 */
contract DeployNomaStaking is Script {
    function run() external {
        address admin = vm.envOr("STAKING_ADMIN", msg.sender);
        address executor = vm.envAddress("STAKING_EXECUTOR");
        uint256 cooldown = vm.envOr("UNSTAKE_COOLDOWN", uint256(7 days));
        uint256 duration = vm.envOr("REWARD_STREAM_DURATION", uint256(7 days));
        address noma = vm.envOr("NOMA_TOKEN", address(0));
        address zec = vm.envOr("ZEC_TOKEN", address(0));
        bool testZec = vm.envOr("DEPLOY_TEST_ZEC", false);

        vm.startBroadcast();
        if (noma == address(0)) {
            noma = address(new TestnetToken("Testnet NOMA", "tNOMA", 18));
            console.log("tNOMA (testnet staking token):", noma);
        }
        if (zec == address(0) && testZec) {
            zec = address(new TestnetToken("Testnet ZEC", "tZEC", 8));
            console.log("tZEC (testnet reward asset):", zec);
        }
        NomaStaking staking = new NomaStaking(IERC20(noma), admin, executor, cooldown, duration);
        console.log("NomaStaking:", address(staking));
        if (zec != address(0) && admin == msg.sender) {
            staking.addRewardAsset(zec);
            console.log("listed reward asset:", zec);
        }
        vm.stopBroadcast();
    }
}
