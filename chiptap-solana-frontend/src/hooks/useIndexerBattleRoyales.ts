// ============================================================
// src/hooks/useIndexerBattleRoyales.ts — Battle Royale flavour
//
// Mirrors useIndexerBattles:
//   1. Initial REST fetch from /battle-royales/open + /live
//   2. Live updates via WS (br:* events from indexer eventHandler)
//   3. Polling fallback every 30 s when WS is down
//
// Server-side filtering by `player` (GIN-indexed players @> [{player}])
// would be cheaper for a heavy lobby — but we keep a single client-side
// pool of recent BRs so the "my active" partition is just a filter,
// same shape as 1v1.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { indexerApi, type IndexedBattleRoyale } from "../services/indexerApi";
import wsClient from "../services/wsClient";
import { POOL_TIERS } from "../config";

export interface BattleRoyaleData {
  id:                number;
  creator:           string;
  poolTier:          number;
  maxPlayers:        number;
  numJoined:         number;
  status:            number;
  players:           { slot: number; player: string; chip: string }[];
  winner:            string;
  winnerIdx:         number | null;
  randomSeed:        string;
  paymentAmount:     number;
  feeAmount:         number;
  cancelReason:      number | null;
  vrfMethod:         string | null;
  randomnessAccount: string | null;
  createdAt:         number;
  rollingAt:         number;
  decidedAt:         number;
  settledAt:         number;
  poolLabel:         string;
  poolSol:           number;
}

function toUnix(iso: string | null | undefined): number {
  return iso ? Math.floor(new Date(iso).getTime() / 1000) : 0;
}

function map(b: IndexedBattleRoyale): BattleRoyaleData {
  const tier = POOL_TIERS[b.pool_tier];
  return {
    id:                b.id,
    creator:           b.creator,
    poolTier:          b.pool_tier,
    maxPlayers:        b.max_players,
    numJoined:         b.num_joined,
    status:            b.status,
    players:           Array.isArray(b.players) ? b.players : [],
    winner:            b.winner || "",
    winnerIdx:         b.winner_idx,
    randomSeed:        b.random_seed || "",
    paymentAmount:     Number(b.payment_amount) || 0,
    feeAmount:         Number(b.fee_amount)     || 0,
    cancelReason:      b.cancel_reason,
    vrfMethod:         b.vrf_method,
    randomnessAccount: b.randomness_account,
    createdAt:         toUnix(b.created_at),
    rollingAt:         toUnix(b.rolling_at),
    decidedAt:         toUnix(b.decided_at),
    settledAt:         toUnix(b.settled_at),
    poolLabel:         tier?.label ?? "?",
    poolSol:           tier?.sol   ?? 0,
  };
}

export function useIndexerBattleRoyales() {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const [items, setItems] = useState<BattleRoyaleData[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const [openRes, liveRes, recentRes] = await Promise.all([
        indexerApi.getOpenBattleRoyales(),
        indexerApi.getLiveBattleRoyales(),
        indexerApi.getBattleRoyales({ limit: 30 }),
      ]);
      const merged = new Map<number, IndexedBattleRoyale>();
      [...openRes.battleRoyales, ...liveRes.battleRoyales, ...recentRes.battleRoyales]
        .forEach((b) => merged.set(b.id, b));
      const all = [...merged.values()].map(map).sort((a, b) => b.id - a.id);
      if (mountedRef.current) setItems(all);
    } catch (err) {
      console.warn("[indexer] BR endpoint unavailable:", (err as Error).message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refetch();
    return () => { mountedRef.current = false; };
  }, [refetch]);

  // Live WS updates — handler topic names match indexer broadcasts.
  useEffect(() => {
    wsClient.connect();
    const unsubs: (() => void)[] = [];

    unsubs.push(wsClient.on("br:created", (d: any) =>
      setItems((prev) => prev.some((b) => b.id === d.id) ? prev : [{
        id:           d.id,
        creator:      d.creator,
        poolTier:     d.poolTier,
        maxPlayers:   d.maxPlayers,
        numJoined:    0,
        status:       0,
        players:      [],
        winner:       "", winnerIdx: null, randomSeed: "",
        paymentAmount: 0, feeAmount: 0, cancelReason: null,
        vrfMethod: null, randomnessAccount: null,
        createdAt:    Math.floor(Date.now() / 1000),
        rollingAt: 0, decidedAt: 0, settledAt: 0,
        poolLabel:    POOL_TIERS[d.poolTier]?.label ?? "?",
        poolSol:      POOL_TIERS[d.poolTier]?.sol   ?? 0,
      }, ...prev]),
    ));

    unsubs.push(wsClient.on("br:joined", (d: any) =>
      // We don't have chip + slot in the broadcast — refetch the row
      // to get the canonical jsonb array.  Tiny REST hit, fine at lobby
      // cadence.  Optimistic numJoined bump avoids the UI flicker.
      setItems((prev) => {
        const next = prev.map((b) =>
          b.id === d.id ? { ...b, numJoined: d.numJoined } : b,
        );
        // Schedule a refetch outside React's setter — `getBattleRoyale`
        // can fail loudly during the brief gap between BattleJoined and
        // the DB UPDATE landing.  Best-effort.
        indexerApi.getBattleRoyale(d.id)
          .then((r) => {
            if (!mountedRef.current) return;
            setItems((p) => p.map((b) => b.id === d.id ? map(r.battleRoyale) : b));
          })
          .catch(() => {});
        return next;
      }),
    ));

    unsubs.push(wsClient.on("br:rolling", (d: any) =>
      setItems((prev) => prev.map((b) =>
        b.id === d.id ? { ...b, status: 1, rollingAt: Math.floor(Date.now() / 1000) } : b)),
    ));

    unsubs.push(wsClient.on("br:decided", (d: any) =>
      setItems((prev) => prev.map((b) =>
        b.id === d.id ? {
          ...b, status: 2, winner: d.winner, winnerIdx: d.winnerIdx,
          decidedAt: Math.floor(Date.now() / 1000),
        } : b)),
    ));

    unsubs.push(wsClient.on("br:settled", (d: any) =>
      setItems((prev) => prev.map((b) =>
        b.id === d.id ? {
          ...b, status: 3,
          paymentAmount: Number(d.payout) || b.paymentAmount,
          feeAmount:     Number(d.fee)    || b.feeAmount,
          settledAt:     Math.floor(Date.now() / 1000),
        } : b)),
    ));

    unsubs.push(wsClient.on("br:cancelled", (d: any) =>
      setItems((prev) => prev.map((b) =>
        b.id === d.id ? { ...b, status: 4, cancelReason: d.reason } : b)),
    ));

    return () => unsubs.forEach((fn) => fn());
  }, []);

  // Polling fallback when WS is down (cold-start period on Render free).
  useEffect(() => {
    const id = setInterval(() => {
      if (!wsClient.isConnected) refetch();
    }, 30_000);
    return () => clearInterval(id);
  }, [refetch]);

  const open    = items.filter((b) => b.status === 0);
  const rolling = items.filter((b) => b.status === 1);
  const decided = items.filter((b) => b.status === 2);

  const mine = items.filter(
    (b) => me && (b.creator === me || b.players.some((p) => p.player === me)),
  );
  const myActive  = mine.filter((b) => b.status < 3);
  const myHistory = mine.filter((b) => b.status >= 3);

  return {
    items, open, rolling, decided,
    myActive, myHistory, loading,
    refetch,
  };
}
