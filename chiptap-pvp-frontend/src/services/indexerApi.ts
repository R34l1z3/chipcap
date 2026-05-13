// ============================================================
// src/services/indexerApi.ts — REST client for chiptap-indexer
// ============================================================

const BASE = import.meta.env.VITE_INDEXER_URL || "http://localhost:3002/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Indexer ${res.status}`);
  return res.json();
}

export interface IndexedBattle {
  id: number; player_a: string; player_b: string | null;
  chip_a: number; chip_b: number | null; pool_tier: number; pool_usd: number;
  status: number; winner: string | null; loser: string | null;
  random_seed: string | null;
  resolution: number; payment_amount: number; fee_amount: number;
  created_at: string; decided_at: string | null; settled_at: string | null;
}

export interface IndexedChip {
  token_id: number; owner: string; rarity: number; battle_count: number; win_count: number;
}

export interface PlayerStats {
  address: string;
  total_battles: number;
  wins: number;
  losses: number;
  total_earned: number;
  total_paid: number;
  total_withdrawn: number;
  chips_won: number;
  chips_lost: number;
}

export type LeaderboardSort = "wins" | "earned" | "battles";

export const indexerApi = {
  getOpenBattles: () => get<{ battles: IndexedBattle[] }>("/battles/open"),
  getLiveBattles: () => get<{ battles: IndexedBattle[] }>("/battles/live"),
  getBattle: (id: number) => get<{ battle: IndexedBattle }>(`/battles/${id}`),
  getBattles: (p?: { status?: number; player?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (p?.status !== undefined) q.set("status", String(p.status));
    if (p?.player) q.set("player", p.player);
    if (p?.limit) q.set("limit", String(p.limit));
    if (p?.offset) q.set("offset", String(p.offset));
    return get<{ battles: IndexedBattle[]; total: number }>(`/battles?${q}`);
  },
  getChips: (owner: string) => get<{ chips: IndexedChip[] }>(`/chips?owner=${owner.toLowerCase()}`),
  getPlayer: (addr: string) =>
    get<{
      address: string;
      stats: PlayerStats;
      recentBattles: IndexedBattle[];
      chips: IndexedChip[];
    }>(`/players/${addr.toLowerCase()}`),
  getLeaderboard: (sort: LeaderboardSort = "wins", limit = 50) =>
    get<{ leaderboard: (PlayerStats & { rank: number })[] }>(`/leaderboard?sort=${sort}&limit=${limit}`),
  getStats: () => get<{ battles: { total: number; open: number; settled: number }; totalChips: number; activePlayers: number }>("/stats"),
};
