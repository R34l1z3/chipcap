// ============================================================
// src/pages/ProfilePage.tsx — single-player view
//
// Sources:
//   GET /api/players/:address  — stats, recent battles, chips
//
// Shows for the given address:
//   • stat cards (battles / W / L / win % / earned / paid / net / withdrawn)
//   • on-chain chip grid (owner-filtered, indexer is source of truth)
//   • last 20 battles
//
// Live: refetches whenever a relevant WS event fires
// (battle:settled / battle:decided / chip:minted touching this address).
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import {
  indexerApi,
  type IndexedBattle,
  type IndexedChip,
  type PlayerStats,
} from "../services/indexerApi";
import wsClient from "../services/wsClient";
import ChipCard from "../components/ChipCard";
import { POOL_TIERS } from "../config";

interface PlayerView {
  address: string;
  stats: PlayerStats;
  recentBattles: IndexedBattle[];
  chips: IndexedChip[];
}

function shortAddr(a: string): string {
  if (!a || a === "0x0000000000000000000000000000000000000000") return "---";
  return a.slice(0, 6) + "..." + a.slice(-4);
}

function fmtPol(n: number | string | undefined): string {
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (!Number.isFinite(v)) return "0";
  return (v as number).toLocaleString("en-US", { maximumFractionDigits: 4, useGrouping: false });
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ============================================================
// Stat cards row
// ============================================================
function StatCards({ stats }: { stats: PlayerStats }) {
  const winRate = stats.total_battles
    ? Math.round((stats.wins / stats.total_battles) * 100)
    : 0;
  const earned = Number(stats.total_earned) || 0;
  const paid = Number(stats.total_paid) || 0;
  const net = earned - paid;

  const cells: { label: string; value: React.ReactNode; color?: string }[] = [
    { label: "BATTLES",   value: stats.total_battles, color: "#FFD700" },
    { label: "WINS",      value: stats.wins,          color: "#00FF88" },
    { label: "LOSSES",    value: stats.losses,        color: "#FF4444" },
    { label: "WIN %",     value: `${winRate}%`,
      color: winRate >= 60 ? "#00FF88" : winRate >= 40 ? "#FFD700" : "#FF8888" },
    { label: "EARNED",    value: `+${fmtPol(earned)}`, color: "#00FF88" },
    { label: "PAID",      value: `-${fmtPol(paid)}`,   color: "#FF4444" },
    { label: "NET",       value: `${net >= 0 ? "+" : "-"}${fmtPol(Math.abs(net))}`,
      color: net > 0 ? "#00FF88" : net < 0 ? "#FF4444" : "#FFD700" },
    { label: "WITHDRAWN", value: fmtPol(stats.total_withdrawn), color: "#00FFFF" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
      {cells.map((c) => (
        <div key={c.label} className="retro-panel text-center py-2 min-w-0">
          <div className="font-pixel truncate" style={{ fontSize: 16, color: c.color || "#FFD700" }}>
            {c.value}
          </div>
          <div className="text-xs opacity-50 mt-0.5">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Recent battles table
// ============================================================
function RecentBattles({ battles, addr }: { battles: IndexedBattle[]; addr: string }) {
  if (battles.length === 0) {
    return (
      <div className="retro-panel text-center py-4">
        <div className="text-sm opacity-50">No battles yet for this player.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {battles.map((b) => {
        const isWinner = b.winner?.toLowerCase() === addr;
        const isLoser = b.loser?.toLowerCase() === addr;
        const poolLabel = POOL_TIERS[b.pool_tier]?.label ?? "?";

        return (
          <div
            key={b.id}
            className="retro-panel"
            style={{
              borderColor: isWinner ? "#00FF88" : isLoser ? "#FF4444" : "#4a4a8a",
              borderLeftWidth: 4,
            }}
          >
            <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>#{b.id}</span>
                <span className="font-pixel text-retro-cyan" style={{ fontSize: 10 }}>{poolLabel}</span>
                {(isWinner || isLoser) && (
                  <span
                    className="font-pixel px-1"
                    style={{
                      fontSize: 8,
                      color: isWinner ? "#00FF88" : "#FF4444",
                      border: "1px solid currentColor",
                    }}
                  >
                    {isWinner ? "WIN" : "LOSS"}
                  </span>
                )}
                <span className="font-pixel px-1" style={{
                  fontSize: 8, color: "#aaa", border: "1px solid #aaa", opacity: 0.6,
                }}>
                  {b.status === 0 ? "WAITING"
                  : b.status === 1 ? "ROLLING"
                  : b.status === 2 ? "DECIDED"
                  : b.status === 3 ? "SETTLED"
                  : "CANCELLED"}
                </span>
              </div>
              <span className="text-xs opacity-40 flex-shrink-0">{timeAgo(b.settled_at || b.decided_at || b.created_at)}</span>
            </div>

            <div className="flex items-center gap-2 text-xs flex-wrap">
              <span style={{ color: b.winner === b.player_a ? "#00FF88" : "#cfcfff" }}>
                {shortAddr(b.player_a)} [#{b.chip_a}]
              </span>
              <span className="text-retro-gold font-pixel" style={{ fontSize: 9 }}>VS</span>
              <span style={{ color: b.winner && b.winner === b.player_b ? "#00FF88" : "#cfcfff" }}>
                {b.player_b ? `${shortAddr(b.player_b)} [#${b.chip_b}]` : "(open)"}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 mt-1 text-xs opacity-50 flex-wrap">
              <span>
                {b.resolution === 1
                  ? `Loser paid ${fmtPol(b.payment_amount)} POL`
                  : b.resolution === 2
                  ? "Chip forfeited"
                  : b.resolution === 3
                  ? "Expired (auto-forfeit)"
                  : "—"}
              </span>
              {b.winner && (
                <span>Winner: {shortAddr(b.winner)}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// Chip grid (owned by player, indexer-sourced)
// ============================================================
function ChipGrid({ chips }: { chips: IndexedChip[] }) {
  if (chips.length === 0) {
    return (
      <div className="retro-panel text-center py-4">
        <div className="text-sm opacity-50">No chips owned.</div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
      {chips.map((c) => (
        <ChipCard
          key={c.token_id}
          tokenId={c.token_id}
          rarity={c.rarity}
          battleCount={c.battle_count}
          winCount={c.win_count}
          size="sm"
        />
      ))}
    </div>
  );
}

// ============================================================
// Main page
// ============================================================
export default function ProfilePage({
  viewedAddress,
  onViewLeaderboard,
}: {
  viewedAddress: string | null;
  onViewLeaderboard: () => void;
}) {
  const { address: connected } = useAccount();
  const [data, setData] = useState<PlayerView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Effective address: viewedAddress (from leaderboard click) takes priority,
  // otherwise the connected wallet, otherwise null (show "connect" stub).
  const target = useMemo<string | null>(() => {
    const t = viewedAddress?.toLowerCase() ?? connected?.toLowerCase() ?? null;
    return t || null;
  }, [viewedAddress, connected]);

  const fetchProfile = useCallback(async () => {
    if (!target) { setData(null); return; }
    setLoading(true); setError(null);
    try {
      const res = await indexerApi.getPlayer(target);
      setData(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  // Live refresh on relevant WS events
  useEffect(() => {
    if (!target) return;
    const refetchIfRelevant = (data: { winner?: string; loser?: string; player?: string; to?: string }) => {
      const addrs = [data.winner, data.loser, data.player, data.to].map((x) => x?.toLowerCase()).filter(Boolean);
      if (!addrs.length || addrs.includes(target)) fetchProfile();
    };
    const unsubs = [
      wsClient.on("battle:settled", () => fetchProfile()),
      wsClient.on("battle:decided", refetchIfRelevant),
      wsClient.on("player:withdrew", refetchIfRelevant),
      wsClient.on("chip:minted", refetchIfRelevant),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [target, fetchProfile]);

  // ---- Empty / not-connected stub ----
  if (!target) {
    return (
      <div className="p-2 sm:p-4 max-w-3xl mx-auto">
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-gold mb-2" style={{ fontSize: 14 }}>
            CONNECT WALLET TO VIEW YOUR PROFILE
          </div>
          <div className="text-sm opacity-60">
            Or open the leaderboard and tap a player to see theirs.
          </div>
          <button
            onClick={onViewLeaderboard}
            className="retro-btn retro-btn-gold mt-4"
            style={{ fontSize: 9, padding: "5px 12px" }}
          >
            GO TO LEADERBOARD
          </button>
        </div>
      </div>
    );
  }

  const isMe = connected && target === connected.toLowerCase();
  const isViewingOther = viewedAddress && (!connected || viewedAddress.toLowerCase() !== connected.toLowerCase());

  return (
    <div className="p-2 sm:p-4 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-start sm:items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="font-pixel text-retro-gold animate-glow" style={{ fontSize: 16 }}>
            {isMe ? "MY PROFILE" : "PLAYER PROFILE"}
          </h1>
          <div className="font-pixel mt-1 break-all" style={{ fontSize: 10, color: "#00FFFF" }}>
            {target}
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          {isViewingOther && (
            <button
              onClick={onViewLeaderboard}
              className="retro-btn"
              style={{ fontSize: 8, padding: "3px 8px" }}
            >
              &lt; LEADERBOARD
            </button>
          )}
          <button
            onClick={fetchProfile}
            className="retro-btn"
            style={{ fontSize: 8, padding: "3px 8px" }}
            disabled={loading}
          >
            {loading ? "..." : "REFRESH"}
          </button>
        </div>
      </div>

      {error && (
        <div className="retro-panel mb-4" style={{ borderColor: "#FF8800" }}>
          <div className="font-pixel text-retro-orange" style={{ fontSize: 10 }}>
            INDEXER ERROR
          </div>
          <div className="text-xs opacity-70 mt-1">{error}</div>
        </div>
      )}

      {!data && loading ? (
        <div className="retro-panel text-center py-8">
          <div className="text-retro-cyan animate-blink">LOADING PROFILE...</div>
        </div>
      ) : !data ? (
        <div className="retro-panel text-center py-8">
          <div className="text-sm opacity-60">No data for this address.</div>
        </div>
      ) : (
        <>
          <StatCards stats={data.stats} />

          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>
            CHIPS ({data.chips.length}):
          </div>
          <div className="mb-4">
            <ChipGrid chips={data.chips} />
          </div>

          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>
            RECENT BATTLES ({data.recentBattles.length}):
          </div>
          <RecentBattles battles={data.recentBattles} addr={target} />
        </>
      )}
    </div>
  );
}
