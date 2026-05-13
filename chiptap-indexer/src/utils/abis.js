// Minimal ABIs — only events needed for indexing

export const CHIP_NFT_ABI = [
  "event ChipMinted(address indexed to, uint256 indexed tokenId, uint8 rarity, uint256 price)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

export const BATTLE_ARENA_ABI = [
  "event BattleCreated(uint256 indexed battleId, address indexed playerA, uint256 chipA, uint8 poolTier)",
  "event BattleJoined(uint256 indexed battleId, address indexed playerB, uint256 chipB, uint256 vrfRequestId)",
  "event BattleDecided(uint256 indexed battleId, address indexed winner, address indexed loser, uint256 randomSeed)",
  "event BattleSettledPaid(uint256 indexed battleId, address indexed loser, uint256 payment, uint256 fee)",
  "event BattleSettledForfeited(uint256 indexed battleId, address indexed loser, uint256 chipForfeited)",
  "event BattleCancelled(uint256 indexed battleId, address indexed playerA)",
  "event BattleExpired(uint256 indexed battleId, address indexed loser)",
  // v2: VRF timeout rescue — anyone can forceResolve() after vrfTimeout
  "event VRFTimedOut(uint256 indexed battleId)",
  // v2: pull-payment — winner withdraws accumulated winnings
  "event WinningsWithdrawn(address indexed player, uint256 amount)",
];

export const POOL_USD = [5, 10, 25, 50, 100, 500];
