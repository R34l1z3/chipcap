// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

interface IChipNFT is IERC721 {
    function recordBattle(uint256 tokenId, bool won) external;
}

interface AggregatorV3Interface {
    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    );
    function decimals() external view returns (uint8);
}

/**
 * @title BattleArena v2
 * @notice 1v1 PvP with NFT chips. Chainlink VRF for randomness.
 *
 *   Security fixes vs v1:
 *   [FIX-1] VRF timeout — if VRF doesn't respond in 1h, forceResolve() refunds both chips
 *   [FIX-2] Pull-payment — winner claims MATIC via withdrawWinnings(), not push in payRansom
 *   [FIX-3] Minimal VRF callback — only stores result, no NFT transfers inside callback
 */
contract BattleArena is VRFConsumerBaseV2Plus, ReentrancyGuard {

    // ============================================================
    //                        TYPES
    // ============================================================

    enum PoolTier { POOL_5, POOL_10, POOL_25, POOL_50, POOL_100, POOL_500 }
    enum BattleStatus { WAITING, ROLLING, DECIDED, SETTLED, CANCELLED }
    enum Resolution { NONE, PAID, FORFEITED, EXPIRED }

    struct Battle {
        address playerA;
        address playerB;
        uint256 chipA;
        uint256 chipB;
        PoolTier poolTier;
        BattleStatus status;
        address winner;
        address loser;
        uint256 randomSeed;
        Resolution resolution;
        uint256 paymentAmount;
        uint256 feeAmount;
        uint256 createdAt;
        uint256 decidedAt;
        uint256 settledAt;
        uint256 vrfRequestId;
        uint256 rollingAt;       // [FIX-1] timestamp when VRF was requested
    }

    // ============================================================
    //                        STATE
    // ============================================================

    IChipNFT public chipNFT;
    AggregatorV3Interface public priceFeed;
    address public treasury;

    uint256 public nextBattleId;
    mapping(uint256 => Battle) public battles;
    mapping(uint256 => uint256) public vrfRequestToBattle;

    /// @notice [FIX-2] Pull-payment balances — winners claim their MATIC
    mapping(address => uint256) public pendingWithdrawals;

    /// Pool tier USD amounts (8 decimals)
    mapping(PoolTier => uint256) public poolAmountUsd;

    uint256 public feeBps = 500;                    // 5%
    uint256 public decisionTimeout = 24 hours;
    uint256 public joinTimeout = 30 minutes;
    uint256 public vrfTimeout = 1 hours;             // [FIX-1]

    /// Chainlink VRF config
    bytes32 public vrfKeyHash;
    uint256 public vrfSubscriptionId;
    uint16 public vrfConfirmations = 3;
    uint32 public vrfCallbackGasLimit = 100_000;     // [FIX-3] minimal — only store result

    bool public paused;

    // ============================================================
    //                        EVENTS
    // ============================================================

    event BattleCreated(uint256 indexed battleId, address indexed playerA, uint256 chipA, PoolTier poolTier);
    event BattleJoined(uint256 indexed battleId, address indexed playerB, uint256 chipB, uint256 vrfRequestId);
    event BattleDecided(uint256 indexed battleId, address indexed winner, address indexed loser, uint256 randomSeed);
    event BattleSettledPaid(uint256 indexed battleId, address indexed loser, uint256 payment, uint256 fee);
    event BattleSettledForfeited(uint256 indexed battleId, address indexed loser, uint256 chipForfeited);
    event BattleCancelled(uint256 indexed battleId, address indexed playerA);
    event BattleExpired(uint256 indexed battleId, address indexed loser);
    event VRFTimedOut(uint256 indexed battleId);      // [FIX-1]
    event WinningsWithdrawn(address indexed player, uint256 amount); // [FIX-2]

    // ============================================================
    //                        ERRORS
    // ============================================================

    error Paused();
    error InvalidBattle();
    error NotYourBattle();
    error WrongStatus(BattleStatus expected, BattleStatus actual);
    error CannotJoinOwnBattle();
    error InsufficientPayment(uint256 required, uint256 sent);
    error DecisionPeriodActive();
    error DecisionPeriodExpired();
    error NotLoser();
    error StalePriceFeed();
    error JoinPeriodNotExpired();
    error VRFNotTimedOut();       // [FIX-1]
    error NothingToWithdraw();    // [FIX-2]

    // ============================================================
    //                      CONSTRUCTOR
    // ============================================================

    constructor(
        address _chipNFT,
        address _priceFeed,
        address _treasury,
        address _vrfCoordinator,
        bytes32 _vrfKeyHash,
        uint256 _vrfSubscriptionId
    ) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        chipNFT = IChipNFT(_chipNFT);
        priceFeed = AggregatorV3Interface(_priceFeed);
        treasury = _treasury;
        vrfKeyHash = _vrfKeyHash;
        vrfSubscriptionId = _vrfSubscriptionId;
        nextBattleId = 1;

        poolAmountUsd[PoolTier.POOL_5]   =     5_00000000;
        poolAmountUsd[PoolTier.POOL_10]  =    10_00000000;
        poolAmountUsd[PoolTier.POOL_25]  =    25_00000000;
        poolAmountUsd[PoolTier.POOL_50]  =    50_00000000;
        poolAmountUsd[PoolTier.POOL_100] =   100_00000000;
        poolAmountUsd[PoolTier.POOL_500] =   500_00000000;
    }

    // ============================================================
    //                  PLAYER ACTIONS
    // ============================================================

    function createBattle(uint256 chipTokenId, PoolTier poolTier) external {
        if (paused) revert Paused();
        chipNFT.transferFrom(msg.sender, address(this), chipTokenId);

        uint256 battleId = nextBattleId++;
        Battle storage b = battles[battleId];
        b.playerA = msg.sender;
        b.chipA = chipTokenId;
        b.poolTier = poolTier;
        b.status = BattleStatus.WAITING;
        b.createdAt = block.timestamp;

        emit BattleCreated(battleId, msg.sender, chipTokenId, poolTier);
    }

    function joinBattle(uint256 battleId, uint256 chipTokenId) external {
        Battle storage b = battles[battleId];
        if (b.status != BattleStatus.WAITING)
            revert WrongStatus(BattleStatus.WAITING, b.status);
        if (msg.sender == b.playerA) revert CannotJoinOwnBattle();

        chipNFT.transferFrom(msg.sender, address(this), chipTokenId);

        b.playerB = msg.sender;
        b.chipB = chipTokenId;
        b.status = BattleStatus.ROLLING;
        b.rollingAt = block.timestamp;   // [FIX-1] track when VRF was requested

        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: vrfKeyHash,
                subId: vrfSubscriptionId,
                requestConfirmations: vrfConfirmations,
                callbackGasLimit: vrfCallbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: false})
                )
            })
        );

        b.vrfRequestId = requestId;
        vrfRequestToBattle[requestId] = battleId;

        emit BattleJoined(battleId, msg.sender, chipTokenId, requestId);
    }

    function cancelBattle(uint256 battleId) external {
        Battle storage b = battles[battleId];
        if (b.playerA != msg.sender) revert NotYourBattle();
        if (b.status != BattleStatus.WAITING)
            revert WrongStatus(BattleStatus.WAITING, b.status);

        b.status = BattleStatus.CANCELLED;
        chipNFT.transferFrom(address(this), msg.sender, b.chipA);
        emit BattleCancelled(battleId, msg.sender);
    }

    // ============================================================
    //     [FIX-3] VRF CALLBACK — minimal, no NFT transfers
    // ============================================================

    /**
     * @notice VRF callback. Only stores the result.
     *         NFT transfers happen in claimChips() to stay under gas limit.
     */
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) internal override {
        uint256 battleId = vrfRequestToBattle[requestId];
        Battle storage b = battles[battleId];
        require(b.status == BattleStatus.ROLLING, "Not rolling");

        uint256 seed = randomWords[0];
        b.randomSeed = seed;
        b.status = BattleStatus.DECIDED;
        b.decidedAt = block.timestamp;

        if (seed % 2 == 0) {
            b.winner = b.playerA;
            b.loser = b.playerB;
        } else {
            b.winner = b.playerB;
            b.loser = b.playerA;
        }

        // [FIX-3] NO NFT transfers here — winner calls claimChips()
        emit BattleDecided(battleId, b.winner, b.loser, seed);
    }

    /**
     * @notice Winner claims their chip back after VRF decides.
     *         Separated from VRF callback to avoid gas limit issues. [FIX-3]
     */
    function claimWinnerChip(uint256 battleId) external {
        Battle storage b = battles[battleId];
        require(b.status == BattleStatus.DECIDED || b.status == BattleStatus.SETTLED, "Not decided");
        require(msg.sender == b.winner, "Not winner");

        uint256 winnerChip = (b.winner == b.playerA) ? b.chipA : b.chipB;

        // Only transfer if contract still holds it
        if (chipNFT.ownerOf(winnerChip) == address(this)) {
            chipNFT.transferFrom(address(this), b.winner, winnerChip);
        }
    }

    // ============================================================
    //              LOSER'S CHOICE (after VRF decides)
    // ============================================================

    /**
     * @notice Loser pays pool amount to keep their chip.
     *         [FIX-2] Uses pull-payment: MATIC credited to winner's balance,
     *         winner calls withdrawWinnings() to collect.
     */
    function payRansom(uint256 battleId) external payable nonReentrant {
        Battle storage b = battles[battleId];
        if (b.status != BattleStatus.DECIDED)
            revert WrongStatus(BattleStatus.DECIDED, b.status);
        if (msg.sender != b.loser) revert NotLoser();
        if (block.timestamp > b.decidedAt + decisionTimeout) revert DecisionPeriodExpired();

        uint256 requiredMatic = getPoolAmountInMatic(b.poolTier);
        if (msg.value < requiredMatic)
            revert InsufficientPayment(requiredMatic, msg.value);

        uint256 fee = (requiredMatic * feeBps) / 10000;
        uint256 winnerPayout = requiredMatic - fee;

        b.status = BattleStatus.SETTLED;
        b.resolution = Resolution.PAID;
        b.paymentAmount = requiredMatic;
        b.feeAmount = fee;
        b.settledAt = block.timestamp;

        // Return loser's chip
        uint256 loserChip = (b.loser == b.playerA) ? b.chipA : b.chipB;
        chipNFT.transferFrom(address(this), b.loser, loserChip);

        // Return winner's chip if still held
        uint256 winnerChip = (b.winner == b.playerA) ? b.chipA : b.chipB;
        if (chipNFT.ownerOf(winnerChip) == address(this)) {
            chipNFT.transferFrom(address(this), b.winner, winnerChip);
        }

        // [FIX-2] Credit winner via pull-payment (not push)
        pendingWithdrawals[b.winner] += winnerPayout;

        // Pay treasury (safe — we control the treasury contract)
        (bool sentTreasury, ) = treasury.call{value: fee}("");
        require(sentTreasury, "Treasury payment failed");

        // Refund excess
        uint256 excess = msg.value - requiredMatic;
        if (excess > 0) {
            (bool refunded, ) = msg.sender.call{value: excess}("");
            require(refunded, "Refund failed");
        }

        _recordStats(b);
        emit BattleSettledPaid(battleId, b.loser, requiredMatic, fee);
    }

    /**
     * @notice Loser forfeits their chip to the winner.
     */
    function forfeitChip(uint256 battleId) external nonReentrant {
        Battle storage b = battles[battleId];
        if (b.status != BattleStatus.DECIDED)
            revert WrongStatus(BattleStatus.DECIDED, b.status);
        if (msg.sender != b.loser) revert NotLoser();

        _executeForfeit(battleId, b);
    }

    /**
     * @notice Auto-forfeit after decision timeout.
     */
    function expireDecision(uint256 battleId) external nonReentrant {
        Battle storage b = battles[battleId];
        if (b.status != BattleStatus.DECIDED)
            revert WrongStatus(BattleStatus.DECIDED, b.status);
        if (block.timestamp <= b.decidedAt + decisionTimeout)
            revert DecisionPeriodActive();

        _executeForfeit(battleId, b);
        emit BattleExpired(battleId, b.loser);
    }

    /**
     * @notice Cancel unjoined battle after join timeout.
     */
    function expireJoin(uint256 battleId) external {
        Battle storage b = battles[battleId];
        if (b.status != BattleStatus.WAITING)
            revert WrongStatus(BattleStatus.WAITING, b.status);
        if (block.timestamp <= b.createdAt + joinTimeout)
            revert JoinPeriodNotExpired();

        b.status = BattleStatus.CANCELLED;
        chipNFT.transferFrom(address(this), b.playerA, b.chipA);
        emit BattleCancelled(battleId, b.playerA);
    }

    // ============================================================
    //     [FIX-1] VRF TIMEOUT — rescue stuck ROLLING battles
    // ============================================================

    /**
     * @notice If VRF hasn't responded within vrfTimeout, anyone can call this
     *         to refund both chips and cancel the battle.
     */
    function forceResolve(uint256 battleId) external nonReentrant {
        Battle storage b = battles[battleId];
        if (b.status != BattleStatus.ROLLING)
            revert WrongStatus(BattleStatus.ROLLING, b.status);
        if (block.timestamp <= b.rollingAt + vrfTimeout)
            revert VRFNotTimedOut();

        b.status = BattleStatus.CANCELLED;

        // Return both chips
        chipNFT.transferFrom(address(this), b.playerA, b.chipA);
        chipNFT.transferFrom(address(this), b.playerB, b.chipB);

        emit VRFTimedOut(battleId);
        emit BattleCancelled(battleId, b.playerA);
    }

    // ============================================================
    //     [FIX-2] PULL-PAYMENT — winner withdraws winnings
    // ============================================================

    /**
     * @notice Winner withdraws accumulated MATIC winnings.
     *         Pull-payment pattern prevents griefing by malicious winner contracts.
     */
    function withdrawWinnings() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        pendingWithdrawals[msg.sender] = 0;

        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Withdraw failed");

        emit WinningsWithdrawn(msg.sender, amount);
    }

    // ============================================================
    //                    PRICE HELPERS
    // ============================================================

    function getPoolAmountInMatic(PoolTier tier) public view returns (uint256) {
        uint256 usdAmount = poolAmountUsd[tier];
        (, int256 maticUsdPrice, , uint256 updatedAt, ) = priceFeed.latestRoundData();
        require(maticUsdPrice > 0, "Invalid price");
        if (block.timestamp - updatedAt > 1 hours) revert StalePriceFeed();
        return (usdAmount * 1e18) / uint256(maticUsdPrice);
    }

    function getAllPoolAmounts() external view returns (uint256[6] memory) {
        return [
            getPoolAmountInMatic(PoolTier.POOL_5),
            getPoolAmountInMatic(PoolTier.POOL_10),
            getPoolAmountInMatic(PoolTier.POOL_25),
            getPoolAmountInMatic(PoolTier.POOL_50),
            getPoolAmountInMatic(PoolTier.POOL_100),
            getPoolAmountInMatic(PoolTier.POOL_500)
        ];
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    function getBattle(uint256 battleId) external view returns (Battle memory) {
        return battles[battleId];
    }

    function getDecisionDeadline(uint256 battleId) external view returns (uint256) {
        Battle storage b = battles[battleId];
        if (b.status != BattleStatus.DECIDED) return 0;
        return b.decidedAt + decisionTimeout;
    }

    function getRansomAmount(uint256 battleId) external view returns (uint256) {
        return getPoolAmountInMatic(battles[battleId].poolTier);
    }

    function getVrfDeadline(uint256 battleId) external view returns (uint256) {
        Battle storage b = battles[battleId];
        if (b.status != BattleStatus.ROLLING) return 0;
        return b.rollingAt + vrfTimeout;
    }

    // ============================================================
    //                     INTERNAL
    // ============================================================

    function _executeForfeit(uint256 battleId, Battle storage b) internal {
        uint256 loserChip = (b.loser == b.playerA) ? b.chipA : b.chipB;

        b.status = BattleStatus.SETTLED;
        b.resolution = Resolution.FORFEITED;
        b.settledAt = block.timestamp;

        // Loser's chip goes to winner
        chipNFT.transferFrom(address(this), b.winner, loserChip);

        // Return winner's chip if still held
        uint256 winnerChip = (b.winner == b.playerA) ? b.chipA : b.chipB;
        if (chipNFT.ownerOf(winnerChip) == address(this)) {
            chipNFT.transferFrom(address(this), b.winner, winnerChip);
        }

        _recordStats(b);
        emit BattleSettledForfeited(battleId, b.loser, loserChip);
    }

    function _recordStats(Battle storage b) internal {
        chipNFT.recordBattle(b.chipA, b.winner == b.playerA);
        chipNFT.recordBattle(b.chipB, b.winner == b.playerB);
    }

    // ============================================================
    //                     OWNER FUNCTIONS
    // ============================================================

    function setPaused(bool _paused) external onlyOwner { paused = _paused; }
    function setTreasury(address _treasury) external onlyOwner { treasury = _treasury; }

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 1000, "Max 10%");
        feeBps = _feeBps;
    }

    function setDecisionTimeout(uint256 _timeout) external onlyOwner {
        require(_timeout >= 1 hours && _timeout <= 72 hours, "1-72h");
        decisionTimeout = _timeout;
    }

    function setJoinTimeout(uint256 _timeout) external onlyOwner {
        require(_timeout >= 5 minutes && _timeout <= 24 hours, "5m-24h");
        joinTimeout = _timeout;
    }

    function setVrfTimeout(uint256 _timeout) external onlyOwner {
        require(_timeout >= 30 minutes && _timeout <= 24 hours, "30m-24h");
        vrfTimeout = _timeout;
    }

    function setVrfConfig(
        bytes32 _keyHash, uint256 _subId, uint16 _confirmations, uint32 _callbackGasLimit
    ) external onlyOwner {
        vrfKeyHash = _keyHash;
        vrfSubscriptionId = _subId;
        vrfConfirmations = _confirmations;
        vrfCallbackGasLimit = _callbackGasLimit;
    }

    function setPoolAmountUsd(PoolTier tier, uint256 amount) external onlyOwner {
        poolAmountUsd[tier] = amount;
    }

    function setPriceFeed(address _feed) external onlyOwner {
        priceFeed = AggregatorV3Interface(_feed);
    }

    function emergencyRecoverChip(uint256 tokenId, address to) external onlyOwner {
        chipNFT.transferFrom(address(this), to, tokenId);
    }

    receive() external payable {}
}
