// ============================================================
// src/hooks/useIndexerTournaments.ts — SEC-23
//
// Mirrors useIndexerBattles / useIndexerBattleRoyales:
//   1. Initial REST fetch from /tournaments/open + /active + recent
//   2. Live updates via WS (tournament:* events from indexer)
//   3. Polling fallback every 30 s when WS is down
//
// Bracket-aware: matches[] is reconstructed from JSONB so the UI can
// render the bracket without re-fetching from chain.  We re-fetch the
// single row on TournamentMatchDecided (the broadcast doesn't carry
// the full match cell — only id/round/matchIdx/winnerSlot — but the
// bracket UI needs the full matches[] array to redraw).
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { indexerApi, type IndexedTournament, type IndexedTMatch } from "../services/indexerApi";
import wsClient from "../services/wsClient";

export interface TournamentData {
  id:                  number;
  creator:             string;
  bracketSize:         number;
  registered:          number;
  currentRound:        number;
  status:              number;
  entryFee:            number;        // lamports
  players:             { slot: number; player: string; chip: string }[];
  matches:             IndexedTMatch[];
  winner1stSlot:       number | null;
  winner2ndSlot:       number | null;
  winner3rdSlot:       number | null;
  poolAmount:          number;
  feeAmount:           number;
  prize1st:            number;
  prize2nd:            number;
  prize3rd:            number;
  prizeClaimedMask:    number;
  chipsClaimedMask:    number;
  cancelReason:        number | null;
  vrfMethod:           string | null;
  createdAt:           number;
  startedAt:           number;
  completedAt:         number;
}

function toUnix(iso: string | null | undefined): number {
  return iso ? Math.floor(new Date(iso).getTime() / 1000) : 0;
}

function map(t: IndexedTournament): TournamentData {
  return {
    id:               t.id,
    creator:          t.creator,
    bracketSize:      t.bracket_size,
    registered:       t.registered,
    currentRound:     t.current_round,
    status:           t.status,
    entryFee:         Number(t.entry_fee) || 0,
    players:          Array.isArray(t.players) ? t.players : [],
    matches:          Array.isArray(t.matches) ? t.matches : [],
    winner1stSlot:    t.winner_1st_slot,
    winner2ndSlot:    t.winner_2nd_slot,
    winner3rdSlot:    t.winner_3rd_slot,
    poolAmount:       Number(t.pool_amount) || 0,
    feeAmount:        Number(t.fee_amount)  || 0,
    prize1st:         Number(t.prize_1st)   || 0,
    prize2nd:         Number(t.prize_2nd)   || 0,
    prize3rd:         Number(t.prize_3rd)   || 0,
    prizeClaimedMask: t.prize_claimed_mask  || 0,
    chipsClaimedMask: t.chips_claimed_mask  || 0,
    cancelReason:     t.cancel_reason,
    vrfMethod:        t.vrf_method,
    createdAt:        toUnix(t.created_at),
    startedAt:        toUnix(t.started_at),
    completedAt:      toUnix(t.completed_at),
  };
}

export function useIndexerTournaments() {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const [items, setItems] = useState<TournamentData[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const [openRes, activeRes, recentRes] = await Promise.all([
        indexerApi.getOpenTournaments(),
        indexerApi.getActiveTournaments(),
        indexerApi.getTournaments({ limit: 30 }),
      ]);
      const merged = new Map<number, IndexedTournament>();
      [...openRes.tournaments, ...activeRes.tournaments, ...recentRes.tournaments]
        .forEach((t) => merged.set(t.id, t));
      const all = [...merged.values()].map(map).sort((a, b) => b.id - a.id);
      if (mountedRef.current) setItems(all);
    } catch (err) {
      console.warn("[indexer] tournaments unavailable:", (err as Error).message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refetch();
    return () => { mountedRef.current = false; };
  }, [refetch]);

  // Refetch a single tournament — used after WS events that don't carry
  // enough info to reconstruct state (most match-level events).
  const refetchOne = useCallback(async (id: number) => {
    try {
      const r = await indexerApi.getTournament(id);
      if (!mountedRef.current) return;
      setItems((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        const mapped = map(r.tournament);
        if (idx === -1) return [mapped, ...prev];
        const next = prev.slice();
        next[idx] = mapped;
        return next;
      });
    } catch { /* swallow — happens during the race between event and DB commit */ }
  }, []);

  useEffect(() => {
    wsClient.connect();
    const unsubs: (() => void)[] = [];

    unsubs.push(wsClient.on("tournament:created", (d: any) =>
      setItems((prev) => prev.some((t) => t.id === d.id) ? prev : [{
        id: d.id, creator: d.creator,
        bracketSize: d.bracketSize, registered: 0, currentRound: 0,
        status: 0, entryFee: Number(d.entryFee) || 0,
        players: [],
        matches: Array.from({ length: 8 }, () => ({
          status: 0, round: 0, slot_a: 255, slot_b: 255, winner_slot: 255,
          seed: null, randomness_account: null, decided_at: null,
        })),
        winner1stSlot: null, winner2ndSlot: null, winner3rdSlot: null,
        poolAmount: 0, feeAmount: 0,
        prize1st: 0, prize2nd: 0, prize3rd: 0,
        prizeClaimedMask: 0, chipsClaimedMask: 0,
        cancelReason: null, vrfMethod: null,
        createdAt: Math.floor(Date.now() / 1000),
        startedAt: 0, completedAt: 0,
      }, ...prev]),
    ));

    unsubs.push(wsClient.on("tournament:registered", (d: any) => {
      // Optimistic registered++; full row arrives via refetchOne.
      setItems((prev) => prev.map((t) =>
        t.id === d.id ? { ...t, registered: d.registered } : t,
      ));
      refetchOne(d.id);
    }));

    unsubs.push(wsClient.on("tournament:started", (d: any) => refetchOne(d.id)));
    unsubs.push(wsClient.on("tournament:match_rolling", (d: any) => refetchOne(d.id)));
    unsubs.push(wsClient.on("tournament:match_decided", (d: any) => refetchOne(d.id)));
    unsubs.push(wsClient.on("tournament:completed", (d: any) => refetchOne(d.id)));
    unsubs.push(wsClient.on("tournament:prize_claimed", (d: any) => refetchOne(d.id)));
    unsubs.push(wsClient.on("tournament:chip_claimed", (d: any) => refetchOne(d.id)));
    unsubs.push(wsClient.on("tournament:cancelled", (d: any) => refetchOne(d.id)));

    return () => unsubs.forEach((fn) => fn());
  }, [refetchOne]);

  // Polling fallback when WS is down.
  useEffect(() => {
    const id = setInterval(() => {
      if (!wsClient.isConnected) refetch();
    }, 30_000);
    return () => clearInterval(id);
  }, [refetch]);

  const open      = items.filter((t) => t.status === 0);
  const active    = items.filter((t) => t.status === 1);
  const completed = items.filter((t) => t.status === 2);

  const mine = items.filter(
    (t) => me && (t.creator === me || t.players.some((p) => p.player === me)),
  );
  const myActive  = mine.filter((t) => t.status < 2);
  const myHistory = mine.filter((t) => t.status >= 2);

  return {
    items, open, active, completed,
    myActive, myHistory, loading,
    refetch, refetchOne,
  };
}
