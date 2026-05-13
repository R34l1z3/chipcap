// ============================================================
// src/pages/LeaderboardPage.tsx — top players, indexer-backed
//
// Reads /api/leaderboard. Lets the user sort by wins / earnings /
// total battles, and re-uses the WS stream to refresh whenever a
// battle settles or a player withdraws winnings.
// ============================================================

import React, { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  indexerApi,
  type PlayerStats,
  type LeaderboardSort,
} from "../services/indexerApi";
import wsClient from "../services/wsClient";

type Row = PlayerStats & { rank: number };

const SORTS: { id: LeaderboardSort; label: string; column: keyof PlayerStats }[] = [
  { id: "wins", label: "WINS", column: "wins" },
  { id: "earned", label: "EARNED", column: "total_earned" },
  { id: "battles", label: "BATTLES", column: "total_battles" },
];

function shortAddr(a: string): string {
  if (!a) return "---";
  return a.slice(0, 6) + "..." + a.slice(-4);
}

function fmtPol(n: number | string | undefined): string {
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (!Number.isFinite(v)) return "0";
  return (v as number).toLocaleString("en-US", { maximumFractionDigits: 4, useGrouping: false });
}

function winRate(r: PlayerStats): number {
  if (!r.total_battles) return 0;
  return Math.round((r.wins / r.total_battles) * 100);
}

export default function LeaderboardPage({
  onViewPlayer,
}: {
  onViewPlayer?: (address: string) => void;
}) {
  const { address } = useAccount();
  const [sort, setSort] = useState<LeaderboardSort>("wins");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBoard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await indexerApi.getLeaderboard(sort, 50);
      setRows(res.leaderboard);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sort]);

  useEffect(() => { fetchBoard(); }, [fetchBoard]);

  // Live refresh whenever something that affects stats happens.
  useEffect(() => {
    const unsubs = [
      wsClient.on("battle:settled", fetchBoard),
      wsClient.on("battle:decided", fetchBoard),
      wsClient.on("player:withdrew", fetchBoard),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [fetchBoard]);

  const me = address?.toLowerCase();

  return (
    <div className="p-2 sm:p-4 max-w-3xl mx-auto">
      {/* Title */}
      <div className="text-center mb-4">
        <h1 className="font-pixel text-retro-gold animate-glow" style={{ fontSize: 18 }}>
          LEADERBOARD
        </h1>
        <div className="text-sm opacity-60 mt-1">Top 50 players</div>
      </div>

      {/* Sort tabs */}
      <div className="retro-panel mb-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex gap-2 flex-wrap">
            {SORTS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSort(s.id)}
                className="retro-btn"
                style={{
                  fontSize: 9,
                  padding: "4px 10px",
                  borderColor: sort === s.id ? "#FFD700" : "#4a4a8a",
                  color: sort === s.id ? "#FFD700" : "#4a4a8a",
                  textShadow: sort === s.id ? "0 0 10px #FFD700" : "none",
                }}
              >
                BY {s.label}
              </button>
            ))}
          </div>
          <button
            onClick={fetchBoard}
            className="retro-btn"
            style={{ fontSize: 8, padding: "3px 8px" }}
            disabled={loading}
          >
            {loading ? "..." : "REFRESH"}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="retro-panel mb-4" style={{ borderColor: "#FF8800" }}>
          <div className="font-pixel text-retro-orange" style={{ fontSize: 10 }}>
            INDEXER ERROR
          </div>
          <div className="text-xs opacity-70 mt-1">{error}</div>
        </div>
      )}

      {/* Table */}
      {loading && rows.length === 0 ? (
        <div className="retro-panel text-center py-8">
          <div className="text-retro-cyan animate-blink">LOADING LEADERBOARD...</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 12 }}>
            NO PLAYERS YET
          </div>
          <div className="text-sm opacity-60">
            Win some battles to claim the top spot!
          </div>
          <pre className="text-retro-cyan opacity-20 mt-4" style={{ fontSize: 10 }}>
{`
   ___________________
  |   1. ___ ___ ___  |
  |   2. ___ ___ ___  |
  |   3. ___ ___ ___  |
  |___________________|
`}
          </pre>
        </div>
      ) : (
        <div className="retro-panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr
                className="font-pixel text-retro-cyan"
                style={{ fontSize: 9, background: "#1a1a4e", borderBottom: "2px solid #4a4a8a" }}
              >
                <th className="py-2 px-1 sm:px-2 text-left" style={{ width: 32 }}>#</th>
                <th className="py-2 px-1 sm:px-2 text-left">PLAYER</th>
                <th className="hidden sm:table-cell py-2 px-2 text-right">B</th>
                <th className="py-2 px-1 sm:px-2 text-right">W</th>
                <th className="hidden sm:table-cell py-2 px-2 text-right">L</th>
                <th className="py-2 px-1 sm:px-2 text-right">WIN %</th>
                <th className="py-2 px-1 sm:px-2 text-right">EARNED</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isMe = me && r.address === me;
                const isTop = r.rank <= 3;
                const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : "";
                const clickable = !!onViewPlayer;
                return (
                  <tr
                    key={r.address}
                    onClick={clickable ? () => onViewPlayer!(r.address) : undefined}
                    title={clickable ? "View profile" : undefined}
                    style={{
                      background: isMe ? "#1f1a08" : r.rank % 2 === 0 ? "#0e0e2a" : "#12122e",
                      borderBottom: "1px solid #1a1a4e",
                      borderLeft: isMe ? "3px solid #FFD700" : "3px solid transparent",
                      cursor: clickable ? "pointer" : "default",
                    }}
                  >
                    <td className="py-2 px-1 sm:px-2 font-pixel" style={{
                      fontSize: 10,
                      color: isTop ? "#FFD700" : "#4a4a8a",
                    }}>
                      {medal || r.rank}
                    </td>
                    <td className="py-2 px-1 sm:px-2 min-w-0">
                      <div
                        className="font-pixel truncate"
                        style={{ fontSize: 10, color: isMe ? "#FFD700" : isTop ? "#00FFFF" : "#cfcfff" }}
                      >
                        {isMe ? "YOU" : shortAddr(r.address)}
                      </div>
                      <div className="text-xs opacity-40" style={{ fontSize: 10 }}>
                        {r.total_battles}B · {r.chips_won}W/{r.chips_lost}L chips
                      </div>
                    </td>
                    <td className="hidden sm:table-cell py-2 px-2 text-right" style={{ fontFamily: "'VT323', monospace", fontSize: 14 }}>
                      {r.total_battles}
                    </td>
                    <td className="py-2 px-1 sm:px-2 text-right text-retro-win" style={{ fontFamily: "'VT323', monospace", fontSize: 14 }}>
                      {r.wins}
                    </td>
                    <td className="hidden sm:table-cell py-2 px-2 text-right text-retro-lose" style={{ fontFamily: "'VT323', monospace", fontSize: 14 }}>
                      {r.losses}
                    </td>
                    <td className="py-2 px-1 sm:px-2 text-right font-pixel" style={{
                      fontSize: 10,
                      color: winRate(r) >= 60 ? "#00FF88" : winRate(r) >= 40 ? "#FFD700" : "#FF8888",
                    }}>
                      {winRate(r)}%
                    </td>
                    <td className="py-2 px-1 sm:px-2 text-right text-retro-gold whitespace-nowrap" style={{ fontFamily: "'VT323', monospace", fontSize: 14 }}>
                      +{fmtPol(r.total_earned)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer hint */}
      {rows.length > 0 && (
        <div className="text-center text-xs opacity-40 mt-3">
          Stats are aggregated by the indexer from on-chain events. Updates live via WebSocket.
        </div>
      )}
    </div>
  );
}
