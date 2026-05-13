// ============================================================
// src/abi/contracts.ts — ABIs updated for BattleArena v2
// ============================================================

export const CHIP_NFT_ABI = [
  { type: "function", name: "mint", inputs: [{ name: "rarity", type: "uint8" }], outputs: [], stateMutability: "payable" },
  { type: "function", name: "mintBatch", inputs: [{ name: "rarity", type: "uint8" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "payable" },
  { type: "function", name: "approve", inputs: [{ name: "to", type: "address" }, { name: "tokenId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "setApprovalForAll", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "isApprovedForAll", inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "tokensOfOwner", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "chipData", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "rarity", type: "uint8" }, { name: "mintedAt", type: "uint256" }, { name: "battleCount", type: "uint256" }, { name: "winCount", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "mintPrice", inputs: [{ name: "rarity", type: "uint8" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "mintedCount", inputs: [{ name: "rarity", type: "uint8" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "maxSupply", inputs: [{ name: "rarity", type: "uint8" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "mintEnabled", inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "ownerOf", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
] as const;

export const BATTLE_ARENA_ABI = [
  // Player actions
  { type: "function", name: "createBattle", inputs: [{ name: "chipTokenId", type: "uint256" }, { name: "poolTier", type: "uint8" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "joinBattle", inputs: [{ name: "battleId", type: "uint256" }, { name: "chipTokenId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "cancelBattle", inputs: [{ name: "battleId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  // Loser's choice
  { type: "function", name: "payRansom", inputs: [{ name: "battleId", type: "uint256" }], outputs: [], stateMutability: "payable" },
  { type: "function", name: "forfeitChip", inputs: [{ name: "battleId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "expireDecision", inputs: [{ name: "battleId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "expireJoin", inputs: [{ name: "battleId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  // v2: New functions
  { type: "function", name: "claimWinnerChip", inputs: [{ name: "battleId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "withdrawWinnings", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "forceResolve", inputs: [{ name: "battleId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "pendingWithdrawals", inputs: [{ name: "addr", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getVrfDeadline", inputs: [{ name: "battleId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  // Views
  { type: "function", name: "getBattle", inputs: [{ name: "battleId", type: "uint256" }], outputs: [{ name: "", type: "tuple", components: [{ name: "playerA", type: "address" }, { name: "playerB", type: "address" }, { name: "chipA", type: "uint256" }, { name: "chipB", type: "uint256" }, { name: "poolTier", type: "uint8" }, { name: "status", type: "uint8" }, { name: "winner", type: "address" }, { name: "loser", type: "address" }, { name: "randomSeed", type: "uint256" }, { name: "resolution", type: "uint8" }, { name: "paymentAmount", type: "uint256" }, { name: "feeAmount", type: "uint256" }, { name: "createdAt", type: "uint256" }, { name: "decidedAt", type: "uint256" }, { name: "settledAt", type: "uint256" }, { name: "vrfRequestId", type: "uint256" }, { name: "rollingAt", type: "uint256" }] }], stateMutability: "view" },
  { type: "function", name: "nextBattleId", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getPoolAmountInMatic", inputs: [{ name: "tier", type: "uint8" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getAllPoolAmounts", inputs: [], outputs: [{ name: "", type: "uint256[6]" }], stateMutability: "view" },
  { type: "function", name: "getDecisionDeadline", inputs: [{ name: "battleId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getRansomAmount", inputs: [{ name: "battleId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "feeBps", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "paused", inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  // Events
  { type: "event", name: "BattleCreated", inputs: [{ name: "battleId", type: "uint256", indexed: true }, { name: "playerA", type: "address", indexed: true }, { name: "chipA", type: "uint256", indexed: false }, { name: "poolTier", type: "uint8", indexed: false }] },
  { type: "event", name: "BattleJoined", inputs: [{ name: "battleId", type: "uint256", indexed: true }, { name: "playerB", type: "address", indexed: true }, { name: "chipB", type: "uint256", indexed: false }, { name: "vrfRequestId", type: "uint256", indexed: false }] },
  { type: "event", name: "BattleDecided", inputs: [{ name: "battleId", type: "uint256", indexed: true }, { name: "winner", type: "address", indexed: true }, { name: "loser", type: "address", indexed: true }, { name: "randomSeed", type: "uint256", indexed: false }] },
  { type: "event", name: "BattleSettledPaid", inputs: [{ name: "battleId", type: "uint256", indexed: true }, { name: "loser", type: "address", indexed: true }, { name: "payment", type: "uint256", indexed: false }, { name: "fee", type: "uint256", indexed: false }] },
  { type: "event", name: "BattleSettledForfeited", inputs: [{ name: "battleId", type: "uint256", indexed: true }, { name: "loser", type: "address", indexed: true }, { name: "chipForfeited", type: "uint256", indexed: false }] },
  { type: "event", name: "BattleCancelled", inputs: [{ name: "battleId", type: "uint256", indexed: true }, { name: "playerA", type: "address", indexed: true }] },
  { type: "event", name: "VRFTimedOut", inputs: [{ name: "battleId", type: "uint256", indexed: true }] },
  { type: "event", name: "WinningsWithdrawn", inputs: [{ name: "player", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
] as const;
