// Profile page — port of the EVM version, indexer-only.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { indexerApi, type IndexedBattle, type IndexedChip, type PlayerStats } from "../services/indexerApi";
import wsClient from "../services/wsClient";
import { fmtSol, shortAddr, timeAgo } from "../lib/format";
import { POOL_TIERS } from "../config";
import ChipCard from "../components/ChipCard";

interface PlayerView {
  address: string;
  stats: PlayerStats;
  recentBattles: IndexedBattle[];
  chips: IndexedChip[];
}

interface Props {
  viewedAddress: string | null;
  onViewLeaderboard: () => void;
}

export default function ProfilePage({ viewedAddress, onViewLeaderboard }: Props) {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();

  const target = useMemo(() => viewedAddress ?? me ?? null, [viewedAddress, me]);

  const [data, setData] = useState<PlayerView | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchProfile = useCallback(async () => {
    if (!target) { setData(null); return; }
    setLoading(true);
    try {
      const res = await indexerApi.getPlayer(target);
      setData(res);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  useEffect(() => {
    if (!target) return;
    const unsubs = [
      wsClient.on("battle:settled",  () => fetchProfile()),
      wsClient.on("battle:decided",  () => fetchProfile()),
      wsClient.on("player:withdrew", (d: any) => { if (d?.user === target) fetchProfile(); }),
      wsClient.on("chip:minted",     (d: any) => { if (d?.owner === target) fetchProfile(); }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [target, fetchProfile]);

  if (!target) {
    return (
      <div className="p-2 sm:p-4 max-w-3xl mx-auto">
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-gold mb-2" style={{ fontSize: 14 }}>
            CONNECT WALLET TO VIEW YOUR PROFILE
          </div>
          <div className="text-sm opacity-60">
            Or open the leaderboard and tap a player.
          </div>
          <button
            onClick={onViewLeaderboard}
            className="retro-btn retro-btn-gold mt-4"
            style={{ fontSize: 9, padding: "5px 12px" }}
          >GO TO LEADERBOARD</button>
        </div>
      </div>
    );
  }

  const isMe = me && target === me;

  const stats = data?.stats;
  const winRate = stats?.total_battles
    ? Math.round((stats.wins / stats.total_battles) * 100)
    : 0;

  const cells = [
    { label: "BATTLES", value: stats?.total_battles ?? 0, color: "#FFD700" },
    { label: "WINS",    value: stats?.wins ?? 0, color: "#00FF88" },
    { label: "LOSSES",  value: stats?.losses ?? 0, color: "#FF4444" },
    { label: "WIN %",   value: `${winRate}%`,
      color: winRate >= 60 ? "#00FF88" : winRate >= 40 ? "#FFD700" : "#FF8888" },
    { label: "EARNED",  value: `+${fmtSol(Number(stats?.total_earned ?? 0))}`, color: "#00FF88" },
    { label: "PAID",    value: `-${fmtSol(Number(stats?.total_paid ?? 0))}`, color: "#FF4444" },
    { label: "WITHDRAWN", value: fmtSol(Number(stats?.total_withdrawn ?? 0)), color: "#00FFFF" },
  ];

  return (
    <div className="p-2 sm:p-4 max-w-3xl mx-auto">
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
          {viewedAddress && (
            <button onClick={onViewLeaderboard} className="retro-btn"
              style={{ fontSize: 8, padding: "3px 8px" }}>
              &lt; LEADERBOARD
            </button>
          )}
          <button onClick={fetchProfile} className="retro-btn"
            style={{ fontSize: 8, padding: "3px 8px" }} disabled={loading}>
            {loading ? "…" : "REFRESH"}
          </button>
        </div>
      </div>

      {!data && loading ? (
        <div className="retro-panel text-center py-8">
          <div className="text-retro-cyan animate-blink">LOADING…</div>
        </div>
      ) : !data ? (
        <div className="retro-panel text-center py-8">
          <div className="text-sm opacity-60">No data for this address.</div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            {cells.map((c) => (
              <div key={c.label} className="retro-panel text-center py-2 min-w-0">
                <div className="font-pixel truncate" style={{ fontSize: 16, color: c.color }}>{c.value}</div>
                <div className="text-xs opacity-50 mt-0.5">{c.label}</div>
              </div>
            ))}
          </div>

          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>
            CHIPS ({data.chips.length}):
          </div>
          {data.chips.length ? (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-4">
              {data.chips.map((c) => (
                <ChipCard
                  key={c.asset}
                  tokenId={c.token_id}
                  asset={c.asset}
                  tier={c.tier}
                  progressionWins={c.progression_wins}
                  battleCount={c.battle_count}
                  winCount={c.win_count}
                  size="sm"
                />
              ))}
            </div>
          ) : (
            <div className="retro-panel text-center py-4 mb-4">
              <div className="text-sm opacity-50">No chips owned.</div>
            </div>
          )}

          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>
            RECENT BATTLES ({data.recentBattles.length}):
          </div>
          {data.recentBattles.length === 0 ? (
            <div className="retro-panel text-center py-4">
              <div className="text-sm opacity-50">No battles yet.</div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {data.recentBattles.map((b) => {
                const isWinner = b.winner === target;
                const isLoser  = b.loser  === target;
                return (
                  <div key={b.id} className="retro-panel"
                    style={{
                      borderColor: isWinner ? "#00FF88" : isLoser ? "#FF4444" : "#4a4a8a",
                      borderLeftWidth: 4,
                    }}>
                    <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>#{b.id}</span>
                        <span className="font-pixel text-retro-cyan" style={{ fontSize: 10 }}>{POOL_TIERS[b.pool_tier]?.label}</span>
                        {(isWinner || isLoser) && (
                          <span className="font-pixel px-1" style={{
                            fontSize: 8,
                            color: isWinner ? "#00FF88" : "#FF4444",
                            border: "1px solid currentColor",
                          }}>
                            {isWinner ? "WIN" : "LOSS"}
                          </span>
                        )}
                      </div>
                      <span className="text-xs opacity-40">
                        {timeAgo(b.settled_at || b.decided_at || b.created_at)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs flex-wrap">
                      <span style={{ color: b.winner === b.player_a ? "#00FF88" : "#cfcfff" }}>
                        {shortAddr(b.player_a)}
                      </span>
                      <span className="text-retro-gold font-pixel" style={{ fontSize: 9 }}>VS</span>
                      <span style={{ color: b.winner === b.player_b ? "#00FF88" : "#cfcfff" }}>
                        {b.player_b ? shortAddr(b.player_b) : "(open)"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
