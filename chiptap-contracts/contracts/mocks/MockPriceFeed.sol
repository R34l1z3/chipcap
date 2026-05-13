// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockPriceFeed
 * @notice Simulates Chainlink AggregatorV3Interface for MATIC/USD.
 *
 * @dev By default, `latestRoundData()` reports `updatedAt = block.timestamp`,
 *      so the price never appears stale even when tests advance time via
 *      `time.increase`. To exercise the stale-price code path, call
 *      `setStale(true)` — then `updatedAt` is frozen at the time of the last
 *      `setPrice` / construction call.
 */
contract MockPriceFeed {
    int256 public price;
    uint8 public constant decimals = 8;
    uint256 public lastUpdatedAt;
    bool public stale;

    constructor(int256 _initialPrice) {
        price = _initialPrice;
        lastUpdatedAt = block.timestamp;
    }

    function setPrice(int256 _price) external {
        price = _price;
        lastUpdatedAt = block.timestamp;
    }

    /// @notice Toggle "stale" mode for testing the StalePriceFeed revert path.
    function setStale(bool _stale) external {
        stale = _stale;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        // When `stale` is false (default), report current block.timestamp so
        // tests using `time.increase` don't accidentally trip the freshness check.
        uint256 ts = stale ? lastUpdatedAt : block.timestamp;
        return (1, price, ts, ts, 1);
    }
}
