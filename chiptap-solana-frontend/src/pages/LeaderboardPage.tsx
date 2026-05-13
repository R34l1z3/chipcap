// Indexer-only — works as-is on Solana since the API shape is identical.
import React, { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { indexerApi, type PlayerStats, type LeaderboardSort } from "../services/indexerApi";
import wsClient from "../services/wsClient";
import { fmtSol, shortAddr } from "../lib/format";

type Row = PlayerStats & { rank: number };

const SORTS: { id: LeaderboardSort; label: string }[] = [
  { id: "wins",    label: "WINS" },
  { id: "earned",  label: "EARNED" },
  { id: "battles", label: "BATTLES" },
];

interface Props {
  onViewPlayer?: (address: string) => void;
}

export default function LeaderboardPage({ onViewPlayer }: Props) {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const [sort, setSort]     = useState<LeaderboardSort>("wins");
  const [rows, setRows]     = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchBoard = useCallback(async () => {
    setLoading(true);
    try { setRows((await indexerApi.getLeaderboard(sort, 50)).leaderboard); }
    catch { setRows([]); }
    finally { setLoading(false); }
  }, [sort]);

  useEffect(() => { fetchBoard(); }, [fetchBoard]);
  useEffect(() => {
    const unsubs = [
      wsClient.on("battle:settled",  fetchBoard),
      wsClient.on("battle:decided",  fetchBoard),
      wsClient.on("player:withdrew", fetchBoard),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [fetchBoard]);

  return (
    <div className="p-2 sm:p-4 max-w-3xl mx-auto">
      <div className="text-center mb-4">
        <h1 className="font-pixel text-retro-gold animate-glow" style={{ fontSize: 18 }}>
          LEADERBOARD
        </h1>
      </div>

      <div className="retro-panel mb-4 flex flex-wrap gap-2">
        {SORTS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSort(s.id)}
            className="retro-btn"
            style={{
              fontSize: 9, padding: "4px 10px",
              borderColor: sort === s.id ? "#FFD700" : "#4a4a8a",
              color: sort === s.id ? "#FFD700" : "#4a4a8a",
              textShadow: sort === s.id ? "0 0 10px #FFD700" : "none",
            }}
          >BY {s.label}</button>
        ))}
      </div>

      {loading && rows.length === 0 ? (
        <div className="retro-panel text-center py-8">
          <div className="text-retro-cyan animate-blink">LOADING…</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="retro-panel text-center py-8">
          <div className="text-sm opacity-50">No players yet.</div>
        </div>
      ) : (
        <div className="retro-panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr className="font-pixel text-retro-cyan"
                style={{ fontSize: 9, background: "#1a1a4e", borderBottom: "2px solid #4a4a8a" }}>
                <th className="py-2 px-1 sm:px-2 text-left" style={{ width: 32 }}>#</th>
                <th className="py-2 px-1 sm:px-2 text-left">PLAYER</th>
                <th className="hidden sm:table-cell py-2 px-2 text-right">B</th>
                <th className="py-2 px-1 sm:px-2 text-right">W</th>
                <th className="hidden sm:table-cell py-2 px-2 text-right">L</th>
                <th className="py-2 px-1 sm:px-2 text-right">EARNED</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isMe  = me && r.address === me;
                const isTop = r.rank <= 3;
                const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : "";
                return (
                  <tr
                    key={r.address}
                    onClick={() => onViewPlayer?.(r.address)}
                    style={{
                      background: isMe ? "#1f1a08" : r.rank % 2 === 0 ? "#0e0e2a" : "#12122e",
                      borderBottom: "1px solid #1a1a4e",
                      borderLeft: isMe ? "3px solid #FFD700" : "3px solid transparent",
                      cursor: onViewPlayer ? "pointer" : "default",
                    }}
                  >
                    <td className="py-2 px-1 sm:px-2 font-pixel" style={{ fontSize: 10, color: isTop ? "#FFD700" : "#4a4a8a" }}>
                      {medal || r.rank}
                    </td>
                    <td className="py-2 px-1 sm:px-2 min-w-0">
                      <div className="font-pixel truncate" style={{ fontSize: 10, color: isMe ? "#FFD700" : isTop ? "#00FFFF" : "#cfcfff" }}>
                        {isMe ? "YOU" : shortAddr(r.address)}
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
                    <td className="py-2 px-1 sm:px-2 text-right text-retro-gold whitespace-nowrap" style={{ fontFamily: "'VT323', monospace", fontSize: 14 }}>
                      +{fmtSol(Number(r.total_earned))} SOL
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
