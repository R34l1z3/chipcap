// ============================================================
// src/hooks/useIndexerBattles.ts
//
// Hybrid data loading:
// 1. Initial load: REST from indexer API (fast)
// 2. Live updates: WebSocket pushes from indexer
// 3. Fallback: REST polling every 30s if WS drops
// ============================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount } from "wagmi";
import { indexerApi, type IndexedBattle } from "../services/indexerApi";
import wsClient from "../services/wsClient";
import { POOL_TIERS } from "../config";

export interface BattleData {
  id: number;
  playerA: string;
  playerB: string;
  chipA: number;
  chipB: number;
  poolTier: number;
  status: number;
  winner: string;
  loser: string;
  randomSeed: string;
  resolution: number;
  paymentAmount: number;
  feeAmount: number;
  createdAt: number;
  decidedAt: number;
  settledAt: number;
  poolLabel: string;
  poolUsd: number;
}

function mapBattle(b: IndexedBattle): BattleData {
  return {
    id: b.id,
    playerA: b.player_a || "",
    playerB: b.player_b || "",
    chipA: b.chip_a,
    chipB: b.chip_b || 0,
    poolTier: b.pool_tier,
    status: b.status,
    winner: b.winner || "",
    loser: b.loser || "",
    randomSeed: b.random_seed || "",
    resolution: b.resolution,
    paymentAmount: b.payment_amount || 0,
    feeAmount: b.fee_amount || 0,
    createdAt: b.created_at ? Math.floor(new Date(b.created_at).getTime() / 1000) : 0,
    decidedAt: b.decided_at ? Math.floor(new Date(b.decided_at).getTime() / 1000) : 0,
    settledAt: b.settled_at ? Math.floor(new Date(b.settled_at).getTime() / 1000) : 0,
    poolLabel: POOL_TIERS[b.pool_tier]?.label || "?",
    poolUsd: b.pool_usd || 0,
  };
}

export function useIndexerBattles() {
  const { address } = useAccount();
  const [battles, setBattles] = useState<BattleData[]>([]);
  const [loading, setLoading] = useState(false);
  const [indexerOnline, setIndexerOnline] = useState(true);
  const mountedRef = useRef(true);

  const fetchBattles = useCallback(async () => {
    setLoading(true);
    try {
      const [openRes, liveRes, recentRes] = await Promise.all([
        indexerApi.getOpenBattles(),
        indexerApi.getLiveBattles(),
        indexerApi.getBattles({ limit: 30 }),
      ]);

      const map = new Map<number, IndexedBattle>();
      [...openRes.battles, ...liveRes.battles, ...recentRes.battles].forEach((b) => map.set(b.id, b));

      const all = Array.from(map.values()).map(mapBattle).sort((a, b) => b.id - a.id);

      if (mountedRef.current) {
        setBattles(all);
        setIndexerOnline(true);
      }
    } catch (err) {
      console.warn("[Indexer] API unavailable:", (err as Error).message);
      if (mountedRef.current) setIndexerOnline(false);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchBattles();
    return () => { mountedRef.current = false; };
  }, [fetchBattles]);

  useEffect(() => {
    wsClient.connect();
    const unsubs: (() => void)[] = [];

    unsubs.push(wsClient.on("battle:created", (data) => {
      setBattles((prev) => {
        if (prev.some((b) => b.id === data.id)) return prev;
        return [{
          id: data.id,
          playerA: data.playerA,
          playerB: "",
          chipA: data.chipA,
          chipB: 0,
          poolTier: data.poolTier,
          status: 0,
          winner: "", loser: "", randomSeed: "",
          resolution: 0, paymentAmount: 0, feeAmount: 0,
          createdAt: Math.floor(Date.now() / 1000),
          decidedAt: 0, settledAt: 0,
          poolLabel: POOL_TIERS[data.poolTier]?.label || "?",
          poolUsd: data.poolUsd || 0,
        }, ...prev];
      });
    }));

    unsubs.push(wsClient.on("battle:joined", (data) => {
      setBattles((prev) => prev.map((b) =>
        b.id === data.id ? { ...b, playerB: data.playerB, chipB: data.chipB, status: 1 } : b
      ));
    }));

    unsubs.push(wsClient.on("battle:decided", (data) => {
      setBattles((prev) => prev.map((b) =>
        b.id === data.id ? {
          ...b, status: 2, winner: data.winner, loser: data.loser,
          decidedAt: Math.floor(Date.now() / 1000),
        } : b
      ));
    }));

    unsubs.push(wsClient.on("battle:settled", (data) => {
      setBattles((prev) => prev.map((b) => {
        if (b.id !== data.id) return b;
        const resolution = data.resolution === "paid" ? 1 : data.resolution === "forfeited" ? 2 : 3;
        return {
          ...b, status: 3, resolution,
          paymentAmount: parseFloat(data.payment || "0"),
          feeAmount: parseFloat(data.fee || "0"),
          settledAt: Math.floor(Date.now() / 1000),
        };
      }));
    }));

    unsubs.push(wsClient.on("battle:cancelled", (data) => {
      setBattles((prev) => prev.map((b) => b.id === data.id ? { ...b, status: 4 } : b));
    }));

    unsubs.push(wsClient.on("battle:vrf_timeout", (data) => {
      setBattles((prev) => prev.map((b) => b.id === data.id ? { ...b, status: 4 } : b));
    }));

    return () => unsubs.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!wsClient.isConnected) fetchBattles();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchBattles]);

  const openBattles = battles.filter((b) => b.status === 0);
  const rollingBattles = battles.filter((b) => b.status === 1);
  const decidedBattles = battles.filter((b) => b.status === 2);

  const myBattles = battles.filter((b) =>
    address && (
      b.playerA.toLowerCase() === address.toLowerCase() ||
      b.playerB.toLowerCase() === address.toLowerCase()
    )
  );
  const myActiveBattles = myBattles.filter((b) => b.status < 3);
  const myHistory = myBattles.filter((b) => b.status >= 3);

  return {
    battles, openBattles, rollingBattles, decidedBattles,
    myActiveBattles, myHistory, loading, indexerOnline,
    refetch: fetchBattles,
  };
}
