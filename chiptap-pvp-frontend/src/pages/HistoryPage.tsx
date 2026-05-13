// ============================================================
// src/pages/HistoryPage.tsx — Battle history with retro table
// ============================================================

import React, { useState } from "react";
import { useAccount } from "wagmi";
import { useBattles } from "../hooks/useBattles";

// Indexer returns payment_amount/fee_amount as already-formatted POL (number).
// Keep totals as numbers and format with fixed precision instead of formatEther.
function fmtPol(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // Trim trailing zeros, max 6 decimals.
  return n.toLocaleString("en-US", { maximumFractionDigits: 6, useGrouping: false });
}

function shortenAddr(a: string) {
  if (!a || a === "0x0000000000000000000000000000000000000000") return "---";
  return a.slice(0, 6) + "..." + a.slice(-4);
}

function timeAgo(ts: number) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function HistoryPage({
  onViewPlayer,
}: {
  onViewPlayer?: (address: string) => void;
}) {
  const { address } = useAccount();
  const { myHistory, battles, loading } = useBattles();
  const [showAll, setShowAll] = useState(false);

  const clickAddr = (a: string | undefined) => {
    if (a && onViewPlayer && a !== "0x0000000000000000000000000000000000000000") {
      onViewPlayer(a);
    }
  };

  const displayBattles = showAll
    ? battles.filter((b) => b.status >= 3)
    : myHistory;

  // Stats
  const wins = myHistory.filter((b) => b.winner.toLowerCase() === address?.toLowerCase()).length;
  const losses = myHistory.filter((b) => b.loser.toLowerCase() === address?.toLowerCase()).length;
  const totalPaid = myHistory.reduce<number>((sum, b) => {
    if (b.loser.toLowerCase() === address?.toLowerCase() && b.resolution === 1) {
      return sum + b.paymentAmount;
    }
    return sum;
  }, 0);
  const totalEarned = myHistory.reduce<number>((sum, b) => {
    if (b.winner.toLowerCase() === address?.toLowerCase() && b.resolution === 1) {
      return sum + (b.paymentAmount - b.feeAmount);
    }
    return sum;
  }, 0);

  return (
    <div className="p-2 sm:p-4 max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-2 mb-4">
        <h1 className="font-pixel text-retro-cyan" style={{ fontSize: 14 }}>
          BATTLE HISTORY
        </h1>
        <button
          onClick={() => setShowAll(!showAll)}
          className="retro-btn flex-shrink-0"
          style={{ fontSize: 8, padding: "3px 8px" }}
        >
          {showAll ? "MY BATTLES" : "ALL BATTLES"}
        </button>
      </div>

      {/* Stats cards */}
      {!showAll && myHistory.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <div className="retro-panel text-center py-2">
            <div className="font-pixel text-retro-gold" style={{ fontSize: 16 }}>{myHistory.length}</div>
            <div className="text-xs opacity-50">TOTAL</div>
          </div>
          <div className="retro-panel text-center py-2">
            <div className="font-pixel text-retro-win" style={{ fontSize: 16 }}>{wins}</div>
            <div className="text-xs opacity-50">WINS</div>
          </div>
          <div className="retro-panel text-center py-2">
            <div className="font-pixel text-retro-lose" style={{ fontSize: 16 }}>{losses}</div>
            <div className="text-xs opacity-50">LOSSES</div>
          </div>
          <div className="retro-panel text-center py-2">
            <div className="font-pixel text-retro-gold" style={{ fontSize: 16 }}>
              {myHistory.length > 0 ? Math.round((wins / myHistory.length) * 100) : 0}%
            </div>
            <div className="text-xs opacity-50">WIN %</div>
          </div>
        </div>
      )}

      {/* P&L summary */}
      {!showAll && (totalPaid > 0 || totalEarned > 0) && (
        <div className="retro-panel mb-4 flex justify-around text-center gap-1 flex-wrap">
          <div>
            <div className="text-xs opacity-50 mb-1">EARNED</div>
            <div className="font-pixel text-retro-win" style={{ fontSize: 13 }}>
              +{fmtPol(totalEarned)} POL
            </div>
          </div>
          <div style={{ width: 1, background: "#2a2a5a" }} />
          <div>
            <div className="text-xs opacity-50 mb-1">PAID</div>
            <div className="font-pixel text-retro-lose" style={{ fontSize: 13 }}>
              -{fmtPol(totalPaid)} POL
            </div>
          </div>
          <div style={{ width: 1, background: "#2a2a5a" }} />
          <div>
            <div className="text-xs opacity-50 mb-1">NET</div>
            <div
              className="font-pixel"
              style={{
                fontSize: 13,
                color: totalEarned > totalPaid ? "#00FF88" : totalEarned < totalPaid ? "#FF4444" : "#FFD700",
              }}
            >
              {totalEarned >= totalPaid ? "+" : "-"}
              {fmtPol(Math.abs(totalEarned - totalPaid))} POL
            </div>
          </div>
        </div>
      )}

      {/* Battle list */}
      {loading && displayBattles.length === 0 ? (
        <div className="retro-panel text-center py-8">
          <div className="animate-blink text-retro-cyan">LOADING HISTORY...</div>
        </div>
      ) : displayBattles.length === 0 ? (
        <div className="retro-panel text-center py-8">
          <div className="text-sm opacity-50">No battles yet. Go to [!] BATTLE to start!</div>
          <pre className="text-retro-cyan opacity-20 mt-4" style={{ fontSize: 10 }}>
{`
  _____________________
 |  _________________  |
 | |                 | |
 | |  NO DATA FOUND  | |
 | |_________________| |
 |_____________________|
`}
          </pre>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {displayBattles.map((b) => {
            const isWinner = address?.toLowerCase() === b.winner.toLowerCase();
            const isLoser = address?.toLowerCase() === b.loser.toLowerCase();
            const isParticipant = isWinner || isLoser;

            return (
              <div
                key={b.id}
                className="retro-panel"
                style={{
                  borderColor: isWinner ? "#00FF88" : isLoser ? "#FF4444" : "#4a4a8a",
                  borderLeftWidth: isParticipant ? 4 : 2,
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-pixel" style={{ fontSize: 10, color: "#FFD700" }}>
                      #{b.id}
                    </span>
                    <span className="font-pixel" style={{ fontSize: 10, color: "#00FFFF" }}>
                      {b.poolLabel}
                    </span>
                    {isParticipant && (
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
                  </div>
                  <span className="text-xs opacity-40">{timeAgo(b.settledAt || b.createdAt)}</span>
                </div>

                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <span
                    onClick={() => clickAddr(b.playerA)}
                    style={{
                      color: b.winner === b.playerA ? "#00FF88" : "#FF4444",
                      cursor: onViewPlayer ? "pointer" : "default",
                      textDecoration: onViewPlayer ? "underline dotted" : "none",
                    }}
                  >
                    {shortenAddr(b.playerA)} [#{b.chipA}]
                  </span>
                  <span className="text-retro-gold font-pixel" style={{ fontSize: 9 }}>VS</span>
                  <span
                    onClick={() => clickAddr(b.playerB)}
                    style={{
                      color: b.winner === b.playerB ? "#00FF88" : "#FF4444",
                      cursor: onViewPlayer && b.playerB ? "pointer" : "default",
                      textDecoration: onViewPlayer && b.playerB ? "underline dotted" : "none",
                    }}
                  >
                    {shortenAddr(b.playerB)} [#{b.chipB}]
                  </span>
                </div>

                <div className="flex items-center justify-between gap-2 mt-1 text-xs opacity-50 flex-wrap">
                  <span>
                    {b.resolution === 1
                      ? `Loser paid ${fmtPol(b.paymentAmount)} POL`
                      : b.resolution === 2
                      ? "Chip forfeited"
                      : b.resolution === 3
                      ? "Expired (auto-forfeit)"
                      : "---"}
                  </span>
                  <span
                    onClick={() => clickAddr(b.winner)}
                    style={{
                      cursor: onViewPlayer && b.winner ? "pointer" : "default",
                      textDecoration: onViewPlayer && b.winner ? "underline dotted" : "none",
                    }}
                  >
                    Winner: {shortenAddr(b.winner)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
