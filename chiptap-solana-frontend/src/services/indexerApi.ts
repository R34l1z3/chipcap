// ============================================================
// src/services/indexerApi.ts — REST client for chiptap-solana-indexer
// ============================================================
//
// Same shape as the EVM indexerApi but with Solana-typed fields:
//   • addresses are base58 Pubkeys (44 chars) instead of hex
//   • chip_a / chip_b are asset Pubkeys (string), not numeric token ids
//   • payment_amount / fee_amount are SOL (float), not wei

const BASE = import.meta.env.VITE_INDEXER_URL || "http://localhost:3002/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Indexer ${res.status}`);
  return res.json();
}

export interface IndexedBattle {
  id:              number;
  player_a:        string;
  player_b:        string | null;
  chip_a:          string;
  chip_b:          string | null;
  pool_tier:       number;
  pool_lamports:   number;
  status:          number;
  winner:          string | null;
  loser:           string | null;
  random_seed:     string | null;
  resolution:      number;
  payment_amount:  number;        // SOL
  fee_amount:      number;        // SOL
  created_at:      string;
  decided_at:      string | null;
  settled_at:      string | null;
}

// SEC-22 — Battle Royale row shape, mirrors `battle_royales` table.
// `players` is the JSONB array — slot is 0-indexed and matches the
// on-chain seating order, so `winner_idx` indexes directly.
export interface IndexedBattleRoyale {
  id:                 number;
  creator:            string;
  pool_tier:          number;
  max_players:        number;
  pool_lamports:      number;
  status:             number;        // 0=waiting 1=rolling 2=decided 3=settled 4=cancelled
  num_joined:         number;
  players:            { slot: number; player: string; chip: string }[];
  winner:             string | null;
  winner_idx:         number | null;
  random_seed:        string | null;
  payment_amount:     number;        // SOL
  fee_amount:         number;        // SOL
  cancel_reason:      number | null;
  vrf_method:         string | null;
  randomness_account: string | null;
  created_at:         string;
  rolling_at:         string | null;
  decided_at:         string | null;
  settled_at:         string | null;
}

export interface IndexedChip {
  asset:        string;
  token_id:     number;
  owner:        string;
  rarity:       number;
  battle_count: number;
  win_count:    number;
}

export interface PlayerStats {
  address:         string;
  total_battles:   number;
  wins:            number;
  losses:          number;
  total_earned:    number;
  total_paid:      number;
  total_withdrawn: number;
  chips_won:       number;
  chips_lost:      number;
}

export type LeaderboardSort = "wins" | "earned" | "battles";

export const indexerApi = {
  getOpenBattles:  () => get<{ battles: IndexedBattle[] }>("/battles/open"),
  getLiveBattles:  () => get<{ battles: IndexedBattle[] }>("/battles/live"),
  getBattle:       (id: number) => get<{ battle: IndexedBattle }>(`/battles/${id}`),
  getBattles: (p?: { status?: number; player?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (p?.status !== undefined) q.set("status", String(p.status));
    if (p?.player)               q.set("player", p.player);
    if (p?.limit)                q.set("limit",  String(p.limit));
    if (p?.offset)               q.set("offset", String(p.offset));
    return get<{ battles: IndexedBattle[]; total: number }>(`/battles?${q}`);
  },
  getChips: (owner: string) => get<{ chips: IndexedChip[] }>(`/chips?owner=${owner}`),
  getChip:  (asset: string) => get<{ chip:  IndexedChip }>(`/chips/${asset}`),
  getPlayer: (addr: string) =>
    get<{
      address: string;
      stats: PlayerStats;
      recentBattles: IndexedBattle[];
      chips: IndexedChip[];
    }>(`/players/${addr}`),
  getLeaderboard: (sort: LeaderboardSort = "wins", limit = 50) =>
    get<{ leaderboard: (PlayerStats & { rank: number })[] }>(
      `/leaderboard?sort=${sort}&limit=${limit}`,
    ),
  getStats: () =>
    get<{
      battles: { total: number; open: number; settled: number };
      battleRoyales?: { total: number; open: number; settled: number };
      totalChips: number;
      activePlayers: number;
      volume?:   { total_volume: number; total_fees: number };
      brVolume?: { total_volume: number; total_fees: number };
    }>("/stats"),

  // ----- SEC-22 — Battle Royale --------------------------------
  getOpenBattleRoyales: () =>
    get<{ battleRoyales: IndexedBattleRoyale[] }>("/battle-royales/open"),
  getLiveBattleRoyales: () =>
    get<{ battleRoyales: IndexedBattleRoyale[] }>("/battle-royales/live"),
  getBattleRoyale: (id: number) =>
    get<{ battleRoyale: IndexedBattleRoyale }>(`/battle-royales/${id}`),
  getBattleRoyales: (p?: {
    status?: number; player?: string; pool_tier?: number;
    limit?: number; offset?: number;
  }) => {
    const q = new URLSearchParams();
    if (p?.status    !== undefined) q.set("status",    String(p.status));
    if (p?.player)                  q.set("player",    p.player);
    if (p?.pool_tier !== undefined) q.set("pool_tier", String(p.pool_tier));
    if (p?.limit)                   q.set("limit",     String(p.limit));
    if (p?.offset)                  q.set("offset",    String(p.offset));
    return get<{ battleRoyales: IndexedBattleRoyale[]; total: number }>(`/battle-royales?${q}`);
  },
};
