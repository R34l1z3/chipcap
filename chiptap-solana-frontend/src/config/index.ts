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

// SEC-26 — Tier system replaces the 5-level mint-time rarity.  Every
// chip mints at T0 and climbs T0→T4 by winning PvP + Battle Royale
// games (tournaments excluded).  The colour ramp is the old rarity
// ramp (grey→green→blue→purple→gold) so index.css `.rarity-*` classes
// are reused unchanged.  Tier display names come from i18n `tier.<id>`.
export const TIERS = [
  { id: 0, color: "#aaaaaa", bgClass: "rarity-common" },
  { id: 1, color: "#00FF00", bgClass: "rarity-uncommon" },
  { id: 2, color: "#3399FF", bgClass: "rarity-rare" },
  { id: 3, color: "#AA44FF", bgClass: "rarity-epic" },
  { id: 4, color: "#FFD700", bgClass: "rarity-legendary" },
] as const;

// Cumulative win thresholds — MUST match `TIER_THRESHOLDS` in
// chip-nft/src/lib.rs.  Index = current tier; a chip at tier N with
// `progression_wins >= TIER_THRESHOLDS[N]` is at tier N+1.
export const TIER_THRESHOLDS = [100, 250, 550, 1550] as const;
export const TIER_MAX = 4;

// Progress of a chip toward its next tier, for the inventory progress bar.
// Returns the wins floor of the current tier, the next threshold (or null
// at T4), and a 0..1 fraction across the current band.
export function tierProgress(wins: number, tier: number): {
  floor: number; next: number | null; pct: number;
} {
  if (tier >= TIER_MAX) return { floor: TIER_THRESHOLDS[3], next: null, pct: 1 };
  const floor = tier === 0 ? 0 : TIER_THRESHOLDS[tier - 1];
  const next  = TIER_THRESHOLDS[tier];
  const pct   = Math.max(0, Math.min(1, (wins - floor) / (next - floor)));
  return { floor, next, pct };
}

// Pool tier labels in SOL — match the on-chain `pool_amounts` defaults.
export const POOL_TIERS = [
  { id: 0, label: "0.05 SOL",  sol: 0.05  },
  { id: 1, label: "0.1 SOL",   sol: 0.1   },
  { id: 2, label: "0.25 SOL",  sol: 0.25  },
  { id: 3, label: "0.5 SOL",   sol: 0.5   },
  { id: 4, label: "1 SOL",     sol: 1     },
  { id: 5, label: "5 SOL",     sol: 5     },
] as const;

// Default flat mint price (SEC-26 — single tier-0 price).  Used as a
// stub before the chip-nft Config PDA loads; the real price comes from
// `config.mintPrice`.
export const DEFAULT_MINT_PRICE_SOL = 0.02;

// Same name conventions as EVM
export const BATTLE_STATUS = { 0: "WAITING", 1: "ROLLING", 2: "DECIDED", 3: "SETTLED", 4: "CANCELLED" } as const;
export const RESOLUTION    = { 0: "NONE",    1: "PAID",    2: "FORFEITED", 3: "EXPIRED" } as const;

// SEC-22 — Battle Royale.  The on-chain BattleRoyale account allocates
// fixed-size [pubkey;8] arrays for players + chips, so MAX_PLAYERS is
// hard-capped at 8 by the program; sizes below 2 are rejected too
// ("InvalidMaxPlayers" — error 6023).
export const BR_MAX_PLAYERS_CAP = 8;
export const BR_MIN_PLAYERS     = 2;
// Standard lobby sizes the UI offers — players can fight at any of
// these sizes; the on-chain ix accepts any value in [2, BR_MAX_PLAYERS_CAP].
export const BR_PLAYER_OPTIONS = [4, 6, 8] as const;
// Reason byte emitted by `BattleRoyaleCancelled` for UI labels.
export const BR_CANCEL_REASON = { 0: "JOIN_TIMEOUT", 1: "VRF_TIMEOUT" } as const;

// SEC-23 — Tournament.  Fixed 8-player single-elimination + 3rd-place
// playoff (= 8 matches total: 4 quarters + 2 semis + final + 3rd-place).
export const T_BRACKET_SIZE      = 8;
export const T_TOTAL_MATCHES     = 8;
// Hardcoded in program (must match T_PRIZE_*_BPS in lib.rs); shown in UI.
export const T_PRIZE_1ST_PCT     = 60;
export const T_PRIZE_2ND_PCT     = 25;
export const T_PRIZE_3RD_PCT     = 10;
export const T_FEE_PCT           = 5;
// Hardcoded ticket price in program (`buy_ticket` ix constant).
// 0.01 SOL = 10_000_000 lamports.  If you change this in lib.rs, update here.
export const TICKET_PRICE_SOL    = 0.01;
export const TICKET_PRICE_LAMPORTS = 10_000_000;
// Standard entry-fee options shown in Create UI.  Owner can deviate by
// passing a custom u64 to create_tournament — UI just guides defaults.
export const T_ENTRY_FEE_OPTIONS_SOL = [0.02, 0.05, 0.1, 0.25] as const;
// Status labels
export const T_STATUS = { 0: "REGISTERING", 1: "ACTIVE", 2: "COMPLETED", 3: "CANCELLED" } as const;
// Per-match status (cell-level)
export const T_MATCH_STATUS = { 0: "PENDING", 1: "ROLLING", 2: "DECIDED" } as const;
// Per-round labels for the bracket UI
export const T_ROUND_LABEL  = { 0: "QUARTERS", 1: "SEMIS", 2: "FINAL & 3RD" } as const;
export const T_CANCEL_REASON = { 0: "REGISTER_TIMEOUT", 1: "VRF_TIMEOUT" } as const;
