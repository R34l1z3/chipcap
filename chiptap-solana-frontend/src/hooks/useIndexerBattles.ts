// ============================================================
// src/hooks/useIndexerBattles.ts — Solana flavour
//
// Same hybrid strategy as EVM:
//   1. Initial REST fetch from indexer
//   2. Live updates via WS
//   3. Polling fallback every 30s when WS is down
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { indexerApi, type IndexedBattle } from "../services/indexerApi";
import wsClient from "../services/wsClient";
import { POOL_TIERS } from "../config";

export interface BattleData {
  id: number;
  playerA: string;
  playerB: string;
  chipA:   string;
  chipB:   string;
  poolTier: number;
  status:   number;
  winner:   string;
  loser:    string;
  randomSeed: string;
  resolution: number;
  paymentAmount: number;
  feeAmount:     number;
  createdAt:     number;
  decidedAt:     number;
  settledAt:     number;
  poolLabel:     string;
  poolSol:       number;
}

function toUnix(iso: string | null | undefined): number {
  return iso ? Math.floor(new Date(iso).getTime() / 1000) : 0;
}

function mapBattle(b: IndexedBattle): BattleData {
  const tier = POOL_TIERS[b.pool_tier];
  return {
    id: b.id,
    playerA: b.player_a || "",
    playerB: b.player_b || "",
    chipA:   b.chip_a   || "",
    chipB:   b.chip_b   || "",
    poolTier: b.pool_tier,
    status:   b.status,
    winner:   b.winner || "",
    loser:    b.loser  || "",
    randomSeed: b.random_seed || "",
    resolution: b.resolution,
    paymentAmount: Number(b.payment_amount) || 0,
    feeAmount:     Number(b.fee_amount)     || 0,
    createdAt:     toUnix(b.created_at),
    decidedAt:     toUnix(b.decided_at),
    settledAt:     toUnix(b.settled_at),
    poolLabel:     tier?.label ?? "?",
    poolSol:       tier?.sol   ?? 0,
  };
}

export function useIndexerBattles() {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const [battles, setBattles] = useState<BattleData[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  const fetchBattles = useCallback(async () => {
    setLoading(true);
    try {
      const [openRes, liveRes, recentRes] = await Promise.all([
        indexerApi.getOpenBattles(),
        indexerApi.getLiveBattles(),
        indexerApi.getBattles({ limit: 30 }),
      ]);
      const merged = new Map<number, IndexedBattle>();
      [...openRes.battles, ...liveRes.battles, ...recentRes.battles]
        .forEach((b) => merged.set(b.id, b));
      const all = [...merged.values()].map(mapBattle).sort((a, b) => b.id - a.id);
      if (mountedRef.current) setBattles(all);
    } catch (err) {
      console.warn("[indexer] unavailable:", (err as Error).message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchBattles();
    return () => { mountedRef.current = false; };
  }, [fetchBattles]);

  // Live WS updates.
  useEffect(() => {
    wsClient.connect();
    const unsubs: (() => void)[] = [];

    unsubs.push(wsClient.on("battle:created", (d: any) => {
      setBattles((prev) => prev.some((b) => b.id === d.id) ? prev : [{
        id: d.id,
        playerA: d.playerA,
        playerB: "",
        chipA: d.chipA,
        chipB: "",
        poolTier: d.poolTier,
        status: 0,
        winner: "", loser: "", randomSeed: "",
        resolution: 0, paymentAmount: 0, feeAmount: 0,
        createdAt: Math.floor(Date.now() / 1000),
        decidedAt: 0, settledAt: 0,
        poolLabel: POOL_TIERS[d.poolTier]?.label ?? "?",
        poolSol:   POOL_TIERS[d.poolTier]?.sol   ?? 0,
      }, ...prev]);
    }));

    unsubs.push(wsClient.on("battle:joined", (d: any) =>
      setBattles((prev) => prev.map((b) =>
        b.id === d.id ? { ...b, playerB: d.playerB, chipB: d.chipB, status: 1 } : b)),
    ));

    unsubs.push(wsClient.on("battle:decided", (d: any) =>
      setBattles((prev) => prev.map((b) =>
        b.id === d.id ? {
          ...b, status: 2, winner: d.winner, loser: d.loser,
          decidedAt: Math.floor(Date.now() / 1000),
        } : b)),
    ));

    unsubs.push(wsClient.on("battle:settled", (d: any) =>
      setBattles((prev) => prev.map((b) => {
        if (b.id !== d.id) return b;
        const resolution = d.resolution === "paid" ? 1 : d.resolution === "forfeited" ? 2 : 3;
        return {
          ...b, status: 3, resolution,
          paymentAmount: Number(d.payment) || b.paymentAmount,
          feeAmount:     Number(d.fee)     || b.feeAmount,
          settledAt:     Math.floor(Date.now() / 1000),
        };
      })),
    ));

    unsubs.push(wsClient.on("battle:cancelled", (d: any) =>
      setBattles((prev) => prev.map((b) => b.id === d.id ? { ...b, status: 4 } : b)),
    ));

    unsubs.push(wsClient.on("battle:vrf_timeout", (d: any) =>
      setBattles((prev) => prev.map((b) => b.id === d.id ? { ...b, status: 4 } : b)),
    ));

    return () => unsubs.forEach((fn) => fn());
  }, []);

  // Polling fallback when WS is down.
  useEffect(() => {
    const id = setInterval(() => {
      if (!wsClient.isConnected) fetchBattles();
    }, 30_000);
    return () => clearInterval(id);
  }, [fetchBattles]);

  const openBattles    = battles.filter((b) => b.status === 0);
  const rollingBattles = battles.filter((b) => b.status === 1);
  const decidedBattles = battles.filter((b) => b.status === 2);

  const myBattles = battles.filter(
    (b) => me && (b.playerA === me || b.playerB === me),
  );
  const myActiveBattles = myBattles.filter((b) => b.status < 3);
  const myHistory       = myBattles.filter((b) => b.status >= 3);

  return {
    battles, openBattles, rollingBattles, decidedBattles,
    myActiveBattles, myHistory, loading,
    refetch: fetchBattles,
  };
}
