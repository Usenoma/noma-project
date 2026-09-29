// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test double for the Pons V2 fee escrow (IPonsV2FeeEscrow, native ETH side only):
/// fees are credited to a recipient and claimed by the recipient itself.
contract MockPonsFeeEscrow {
    mapping(address => uint256) public balanceOf;

    function credit(address recipient) external payable {
        balanceOf[recipient] += msg.value;
    }

    function claim() external returns (uint256 amount) {
        amount = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }
}
