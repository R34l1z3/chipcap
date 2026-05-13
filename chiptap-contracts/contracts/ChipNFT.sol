// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title ChipNFT
 * @notice ERC-721 NFT representing game chips with rarity tiers.
 *         Players mint chips for MATIC and use them in PvP battles.
 */
contract ChipNFT is ERC721, ERC721Enumerable, Ownable {
    using Strings for uint256;

    // ============================================================
    //                        TYPES
    // ============================================================

    enum Rarity { Common, Uncommon, Rare, Epic, Legendary }

    struct ChipData {
        Rarity rarity;
        uint256 mintedAt;
        uint256 battleCount;
        uint256 winCount;
    }

    // ============================================================
    //                        STATE
    // ============================================================

    uint256 private _nextTokenId;
    string public baseURI;

    /// @notice Mint price per rarity tier (in wei)
    mapping(Rarity => uint256) public mintPrice;

    /// @notice Max supply per rarity (0 = unlimited)
    mapping(Rarity => uint256) public maxSupply;

    /// @notice Current minted count per rarity
    mapping(Rarity => uint256) public mintedCount;

    /// @notice On-chain chip metadata
    mapping(uint256 => ChipData) public chipData;

    /// @notice Addresses authorized to update battle stats (BattleArena)
    mapping(address => bool) public battleContracts;

    /// @notice Global mint enabled flag
    bool public mintEnabled;

    // ============================================================
    //                        EVENTS
    // ============================================================

    event ChipMinted(address indexed to, uint256 indexed tokenId, Rarity rarity, uint256 price);
    event BattleContractUpdated(address indexed addr, bool authorized);
    event MintPriceUpdated(Rarity rarity, uint256 newPrice);
    event BaseURIUpdated(string newBaseURI);

    // ============================================================
    //                        ERRORS
    // ============================================================

    error MintDisabled();
    error InsufficientPayment(uint256 required, uint256 sent);
    error MaxSupplyReached(Rarity rarity);
    error NotBattleContract();
    error InvalidRarity();

    // ============================================================
    //                      CONSTRUCTOR
    // ============================================================

    constructor(
        string memory _baseURI
    ) ERC721("ChipTap", "CHIP") Ownable(msg.sender) {
        baseURI = _baseURI;
        _nextTokenId = 1;

        // Default mint prices (in MATIC — ~$0.50 per MATIC)
        mintPrice[Rarity.Common]    = 2 ether;    // ~$1
        mintPrice[Rarity.Uncommon]  = 10 ether;   // ~$5
        mintPrice[Rarity.Rare]      = 40 ether;   // ~$20
        mintPrice[Rarity.Epic]      = 100 ether;  // ~$50
        mintPrice[Rarity.Legendary] = 400 ether;  // ~$200

        // Default max supply (0 = unlimited)
        maxSupply[Rarity.Common]    = 0;       // unlimited
        maxSupply[Rarity.Uncommon]  = 10000;
        maxSupply[Rarity.Rare]      = 3000;
        maxSupply[Rarity.Epic]      = 500;
        maxSupply[Rarity.Legendary] = 50;

        mintEnabled = false;
    }

    // ============================================================
    //                     PUBLIC: MINT
    // ============================================================

    /**
     * @notice Mint a new chip NFT.
     * @param rarity The rarity tier to mint.
     */
    function mint(Rarity rarity) external payable {
        if (!mintEnabled) revert MintDisabled();
        if (uint8(rarity) > uint8(Rarity.Legendary)) revert InvalidRarity();

        uint256 price = mintPrice[rarity];
        if (msg.value < price) revert InsufficientPayment(price, msg.value);

        uint256 max = maxSupply[rarity];
        if (max > 0 && mintedCount[rarity] >= max) revert MaxSupplyReached(rarity);

        uint256 tokenId = _nextTokenId++;
        mintedCount[rarity]++;

        chipData[tokenId] = ChipData({
            rarity: rarity,
            mintedAt: block.timestamp,
            battleCount: 0,
            winCount: 0
        });

        _safeMint(msg.sender, tokenId);

        // Refund excess payment
        if (msg.value > price) {
            (bool sent, ) = msg.sender.call{value: msg.value - price}("");
            require(sent, "Refund failed");
        }

        emit ChipMinted(msg.sender, tokenId, rarity, price);
    }

    /**
     * @notice Batch mint multiple chips of the same rarity.
     * @param rarity The rarity tier.
     * @param amount How many to mint (max 10).
     */
    function mintBatch(Rarity rarity, uint256 amount) external payable {
        if (!mintEnabled) revert MintDisabled();
        require(amount > 0 && amount <= 10, "1-10 per batch");

        uint256 totalPrice = mintPrice[rarity] * amount;
        if (msg.value < totalPrice) revert InsufficientPayment(totalPrice, msg.value);

        uint256 max = maxSupply[rarity];
        if (max > 0 && mintedCount[rarity] + amount > max) revert MaxSupplyReached(rarity);

        for (uint256 i = 0; i < amount; i++) {
            uint256 tokenId = _nextTokenId++;
            mintedCount[rarity]++;

            chipData[tokenId] = ChipData({
                rarity: rarity,
                mintedAt: block.timestamp,
                battleCount: 0,
                winCount: 0
            });

            _safeMint(msg.sender, tokenId);
            emit ChipMinted(msg.sender, tokenId, rarity, mintPrice[rarity]);
        }

        if (msg.value > totalPrice) {
            (bool sent, ) = msg.sender.call{value: msg.value - totalPrice}("");
            require(sent, "Refund failed");
        }
    }

    // ============================================================
    //                  BATTLE CONTRACT CALLS
    // ============================================================

    /**
     * @notice Record a battle result for a chip. Only callable by BattleArena.
     */
    function recordBattle(uint256 tokenId, bool won) external {
        if (!battleContracts[msg.sender]) revert NotBattleContract();
        chipData[tokenId].battleCount++;
        if (won) chipData[tokenId].winCount++;
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string(abi.encodePacked(baseURI, tokenId.toString(), ".json"));
    }

    /**
     * @notice Get all token IDs owned by an address.
     */
    function tokensOfOwner(address owner) external view returns (uint256[] memory) {
        uint256 balance = balanceOf(owner);
        uint256[] memory tokens = new uint256[](balance);
        for (uint256 i = 0; i < balance; i++) {
            tokens[i] = tokenOfOwnerByIndex(owner, i);
        }
        return tokens;
    }

    /**
     * @notice Get chip rarity for a token.
     */
    function chipRarity(uint256 tokenId) external view returns (Rarity) {
        _requireOwned(tokenId);
        return chipData[tokenId].rarity;
    }

    // ============================================================
    //                     OWNER FUNCTIONS
    // ============================================================

    function setMintEnabled(bool enabled) external onlyOwner {
        mintEnabled = enabled;
    }

    function setMintPrice(Rarity rarity, uint256 price) external onlyOwner {
        mintPrice[rarity] = price;
        emit MintPriceUpdated(rarity, price);
    }

    function setMaxSupply(Rarity rarity, uint256 max) external onlyOwner {
        maxSupply[rarity] = max;
    }

    function setBaseURI(string calldata _baseURI) external onlyOwner {
        baseURI = _baseURI;
        emit BaseURIUpdated(_baseURI);
    }

    function setBattleContract(address addr, bool authorized) external onlyOwner {
        battleContracts[addr] = authorized;
        emit BattleContractUpdated(addr, authorized);
    }

    function withdraw() external onlyOwner {
        (bool sent, ) = owner().call{value: address(this).balance}("");
        require(sent, "Withdraw failed");
    }

    // ============================================================
    //                     REQUIRED OVERRIDES
    // ============================================================

    function _update(address to, uint256 tokenId, address auth)
        internal override(ERC721, ERC721Enumerable) returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value)
        internal override(ERC721, ERC721Enumerable)
    {
        super._increaseBalance(account, value);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, ERC721Enumerable) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
