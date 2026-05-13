// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Treasury
 * @notice Collects platform fees from BattleArena.
 *         Owner can withdraw accumulated fees.
 */
contract Treasury is Ownable, ReentrancyGuard {

    // ============================================================
    //                        STATE
    // ============================================================

    uint256 public totalCollected;
    uint256 public totalWithdrawn;

    /// @notice Addresses allowed to deposit (BattleArena and friends)
    mapping(address => bool) public depositors;

    // ============================================================
    //                        EVENTS
    // ============================================================

    event FeeDeposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event DepositorUpdated(address indexed addr, bool allowed);

    // ============================================================
    //                        ERRORS
    // ============================================================

    error NotDepositor();

    // ============================================================
    //                      CONSTRUCTOR
    // ============================================================

    constructor() Ownable(msg.sender) {
        // Owner is implicitly an allowed depositor (e.g. for top-ups / tests).
        depositors[msg.sender] = true;
        emit DepositorUpdated(msg.sender, true);
    }

    // ============================================================
    //                      RECEIVE FEES
    // ============================================================

    /**
     * @notice Receive MATIC fees. Only authorized depositors (BattleArena).
     * @dev Reverts if `msg.sender` is not registered via `setDepositor`.
     */
    receive() external payable {
        if (!depositors[msg.sender]) revert NotDepositor();
        totalCollected += msg.value;
        emit FeeDeposited(msg.sender, msg.value);
    }

    /**
     * @notice Explicit deposit function (alternative to receive).
     */
    function deposit() external payable {
        if (!depositors[msg.sender]) revert NotDepositor();
        totalCollected += msg.value;
        emit FeeDeposited(msg.sender, msg.value);
    }

    // ============================================================
    //                     VIEW FUNCTIONS
    // ============================================================

    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    function totalFees() external view returns (uint256) {
        return totalCollected;
    }

    // ============================================================
    //                     OWNER FUNCTIONS
    // ============================================================

    /**
     * @notice Withdraw accumulated fees to owner.
     */
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        require(amount <= address(this).balance, "Insufficient balance");
        totalWithdrawn += amount;
        (bool sent, ) = owner().call{value: amount}("");
        require(sent, "Withdraw failed");
        emit Withdrawn(owner(), amount);
    }

    /**
     * @notice Withdraw all fees.
     */
    function withdrawAll() external onlyOwner nonReentrant {
        uint256 bal = address(this).balance;
        require(bal > 0, "No balance");
        totalWithdrawn += bal;
        (bool sent, ) = owner().call{value: bal}("");
        require(sent, "Withdraw failed");
        emit Withdrawn(owner(), bal);
    }

    function setDepositor(address addr, bool allowed) external onlyOwner {
        depositors[addr] = allowed;
        emit DepositorUpdated(addr, allowed);
    }
}
