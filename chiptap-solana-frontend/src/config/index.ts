// ============================================================
// src/config/index.ts — environment + on-chain constants
// ============================================================

import { PublicKey, clusterApiUrl } from "@solana/web3.js";

export type Cluster = "localnet" | "devnet" | "mainnet";

export const CLUSTER: Cluster =
  (import.meta.env.VITE_SOLANA_CLUSTER as Cluster | undefined) ?? "localnet";

export const RPC_URL: string = (() => {
  if (import.meta.env.VITE_SOLANA_RPC) return import.meta.env.VITE_SOLANA_RPC!;
  if (CLUSTER === "localnet") return "http://127.0.0.1:8899";
  if (CLUSTER === "devnet")   return clusterApiUrl("devnet");
  return clusterApiUrl("mainnet-beta");
})();

// Collected here so the boot-time error overlay (ErrorBoundary) can show
// a clear "missing env" message instead of a cryptic `Non-base58 char`
// stack trace from a placeholder that never decoded to 32 bytes anyway.
function readProgramId(envVar: string, name: string): PublicKey {
  const raw = import.meta.env[envVar];
  if (!raw || typeof raw !== "string") {
    throw new Error(
      `[config] Missing ${envVar} in .env — expected the on-chain program ID for ${name}. ` +
      `Copy chiptap-solana-frontend/.env.example to .env and fill in the IDs printed by run-init.sh.`,
    );
  }
  try {
    return new PublicKey(raw);
  } catch (e) {
    throw new Error(
      `[config] ${envVar}="${raw}" is not a valid Solana pubkey. ` +
      `Did you paste the value from \`solana address -k target/deploy/${name}-keypair.json\`?`,
    );
  }
}

export const CHIP_NFT_PROGRAM     = readProgramId("VITE_CHIP_NFT_PROGRAM",     "chip_nft");
export const BATTLE_ARENA_PROGRAM = readProgramId("VITE_BATTLE_ARENA_PROGRAM", "battle_arena");
export const TREASURY_PROGRAM     = readProgramId("VITE_TREASURY_PROGRAM",     "treasury");

// Mirrors the EVM frontend RARITIES so existing UI code keeps working.
export const RARITIES = [
  { id: 0, name: "Common",    color: "#aaaaaa", bgClass: "rarity-common" },
  { id: 1, name: "Uncommon",  color: "#00FF00", bgClass: "rarity-uncommon" },
  { id: 2, name: "Rare",      color: "#3399FF", bgClass: "rarity-rare" },
  { id: 3, name: "Epic",      color: "#AA44FF", bgClass: "rarity-epic" },
  { id: 4, name: "Legendary", color: "#FFD700", bgClass: "rarity-legendary" },
] as const;

// Pool tier labels in SOL — match the on-chain `pool_amounts` defaults.
export const POOL_TIERS = [
  { id: 0, label: "0.05 SOL",  sol: 0.05  },
  { id: 1, label: "0.1 SOL",   sol: 0.1   },
  { id: 2, label: "0.25 SOL",  sol: 0.25  },
  { id: 3, label: "0.5 SOL",   sol: 0.5   },
  { id: 4, label: "1 SOL",     sol: 1     },
  { id: 5, label: "5 SOL",     sol: 5     },
] as const;

// Numeric defaults for mint prices (used when a Phantom-not-connected
// MintPage just wants to show stub prices).  Real prices come from the
// chip-nft Config PDA.
export const DEFAULT_MINT_PRICE_SOL = [0.02, 0.1, 0.4, 1, 4];

// Same name conventions as EVM
export const BATTLE_STATUS = { 0: "WAITING", 1: "ROLLING", 2: "DECIDED", 3: "SETTLED", 4: "CANCELLED" } as const;
export const RESOLUTION    = { 0: "NONE",    1: "PAID",    2: "FORFEITED", 3: "EXPIRED" } as const;
