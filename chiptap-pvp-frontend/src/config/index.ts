import { hardhat, polygonAmoy, polygon } from "wagmi/chains";

export const CONTRACTS: Record<number, { chipNFT: `0x${string}`; battleArena: `0x${string}`; treasury: `0x${string}` }> = {
  [hardhat.id]: {
    chipNFT: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    battleArena: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
    treasury: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  },
  [polygonAmoy.id]: {
    chipNFT: "0x0000000000000000000000000000000000000000",
    battleArena: "0x0000000000000000000000000000000000000000",
    treasury: "0x0000000000000000000000000000000000000000",
  },
  [polygon.id]: {
    chipNFT: "0x0000000000000000000000000000000000000000",
    battleArena: "0x0000000000000000000000000000000000000000",
    treasury: "0x0000000000000000000000000000000000000000",
  },
};

export const RARITIES = [
  { id: 0, name: "Common", color: "#aaaaaa", bgClass: "rarity-common" },
  { id: 1, name: "Uncommon", color: "#00FF00", bgClass: "rarity-uncommon" },
  { id: 2, name: "Rare", color: "#3399FF", bgClass: "rarity-rare" },
  { id: 3, name: "Epic", color: "#AA44FF", bgClass: "rarity-epic" },
  { id: 4, name: "Legendary", color: "#FFD700", bgClass: "rarity-legendary" },
] as const;

export const POOL_TIERS = [
  { id: 0, label: "$5", usd: 5 },
  { id: 1, label: "$10", usd: 10 },
  { id: 2, label: "$25", usd: 25 },
  { id: 3, label: "$50", usd: 50 },
  { id: 4, label: "$100", usd: 100 },
  { id: 5, label: "$500", usd: 500 },
] as const;

export const BATTLE_STATUS = { 0: "WAITING", 1: "ROLLING", 2: "DECIDED", 3: "SETTLED", 4: "CANCELLED" } as const;
export const RESOLUTION = { 0: "NONE", 1: "PAID", 2: "FORFEITED", 3: "EXPIRED" } as const;

export function getContracts(chainId: number) {
  return CONTRACTS[chainId] || CONTRACTS[hardhat.id];
}
