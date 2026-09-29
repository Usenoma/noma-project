// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Minimal Uniswap V4 surface (ABI-compatible with v4-core IPoolManager) for fork rehearsals.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerMinimal {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/**
 * @notice Test-only swap router for the Pons V2 fork rehearsal: one swap per call through the
 * PoolManager's unlock callback. Negative amountSpecified = exact input. Native ETH is currency
 * address(0) and paid from msg.value; unused ETH is refunded. Never deploy to mainnet.
 */
contract V4SwapRouter {
    uint160 private constant MIN_SQRT_PRICE_LIMIT = 4295128739 + 1;
    uint160 private constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;

    IPoolManagerMinimal public immutable poolManager;

    constructor(IPoolManagerMinimal poolManager_) {
        poolManager = poolManager_;
    }

    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified) external payable returns (int256 delta) {
        delta = abi.decode(poolManager.unlock(abi.encode(msg.sender, key, zeroForOne, amountSpecified)), (int256));
        if (address(this).balance != 0) {
            (bool ok,) = msg.sender.call{value: address(this).balance}("");
            require(ok, "refund failed");
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "only pool manager");
        (address payer, PoolKey memory key, bool zeroForOne, int256 amountSpecified) =
            abi.decode(data, (address, PoolKey, bool, int256));
        int256 delta = poolManager.swap(
            key,
            SwapParams(zeroForOne, amountSpecified, zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT),
            ""
        );
        _resolve(key.currency0, int128(delta >> 128), payer);
        _resolve(key.currency1, int128(delta), payer);
        return abi.encode(delta);
    }

    function _resolve(address currency, int128 amount, address payer) private {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            if (currency == address(0)) {
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(currency);
                require(IERC20(currency).transferFrom(payer, address(poolManager), owed), "pay failed");
                poolManager.settle();
            }
        } else if (amount > 0) {
            poolManager.take(currency, payer, uint256(uint128(amount)));
        }
    }

    receive() external payable {}
}
