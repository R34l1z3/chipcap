// Stub — uses indexer-backed hook so it already works at read-time.
import React, { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useIndexerBattles } from "../hooks/useIndexerBattles";
import { POOL_TIERS } from "../config";
import { fmtSol, shortAddr, timeAgo } from "../lib/format";

interface Props {
  onViewPlayer?: (address: string) => void;
  onWatchBattle?: (id: number) => void;
}

export default function HistoryPage({ onViewPlayer, onWatchBattle }: Props) {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const { myHistory, battles, loading } = useIndexerBattles();
  const [view, setView] = useState<"mine" | "all">(publicKey ? "mine" : "all");

  // "all" shows every public decided/settled battle.  "mine" shows
  // only battles where the connected wallet was player_a or player_b.
  const displayed = view === "all"
    ? battles.filter((b) => b.status >= 2)
    : myHistory;

  return (
    <div className="p-2 sm:p-4 max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <h1 className="font-pixel text-retro-cyan" style={{ fontSize: 14 }}>
          BATTLE HISTORY
        </h1>
        {publicKey && (
          <div className="flex gap-1">
            <button
              className="retro-btn"
              style={{
                fontSize: 8, padding: "3px 8px",
                background: view === "mine" ? "#FFD700" : undefined,
                color:      view === "mine" ? "#000"    : undefined,
              }}
              onClick={() => setView("mine")}
            >MY</button>
            <button
              className="retro-btn"
              style={{
                fontSize: 8, padding: "3px 8px",
                background: view === "all"  ? "#FFD700" : undefined,
                color:      view === "all"  ? "#000"    : undefined,
              }}
              onClick={() => setView("all")}
            >ALL</button>
          </div>
        )}
      </div>

      {loading && displayed.length === 0 ? (
        <div className="retro-panel text-center py-8">
          <div className="animate-blink text-retro-cyan">LOADING…</div>
        </div>
      ) : displayed.length === 0 ? (
        <div className="retro-panel text-center py-8">
          <div className="text-sm opacity-50">No battles yet.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {displayed.map((b) => {
            const isWinner = me && b.winner === me;
            const isLoser  = me && b.loser  === me;
            return (
              <div
                key={b.id}
                className="retro-panel"
                style={{
                  borderColor: isWinner ? "#00FF88" : isLoser ? "#FF4444" : "#4a4a8a",
                  borderLeftWidth: (isWinner || isLoser) ? 4 : 2,
                  cursor: onWatchBattle ? "pointer" : "default",
                }}
                onClick={() => onWatchBattle?.(b.id)}
                title={onWatchBattle ? "Open audit trail" : undefined}
              >
                <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>#{b.id}</span>
                    <span className="font-pixel text-retro-cyan" style={{ fontSize: 10 }}>
                      {POOL_TIERS[b.poolTier]?.label}
                    </span>
                  </div>
                  <span className="text-xs opacity-40">{timeAgo(b.settledAt || b.createdAt)}</span>
                </div>
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <span
                    onClick={(e) => { e.stopPropagation(); onViewPlayer?.(b.playerA); }}
                    style={{
                      color: b.winner === b.playerA ? "#00FF88" : "#FF4444",
                      cursor: onViewPlayer ? "pointer" : "default",
                      textDecoration: onViewPlayer ? "underline dotted" : "none",
                    }}
                  >{shortAddr(b.playerA)}</span>
                  <span className="text-retro-gold font-pixel" style={{ fontSize: 9 }}>VS</span>
                  <span
                    onClick={(e) => { e.stopPropagation(); b.playerB && onViewPlayer?.(b.playerB); }}
                    style={{
                      color: b.winner === b.playerB ? "#00FF88" : "#FF4444",
                      cursor: onViewPlayer && b.playerB ? "pointer" : "default",
                      textDecoration: onViewPlayer && b.playerB ? "underline dotted" : "none",
                    }}
                  >{shortAddr(b.playerB)}</span>
                </div>
                <div className="text-xs opacity-50 mt-1">
                  {b.resolution === 1 ? `Loser paid ${fmtSol(b.paymentAmount)} SOL`
                   : b.resolution === 2 ? "Chip forfeited"
                   : b.resolution === 3 ? "Expired (auto-forfeit)"
                   : "—"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
