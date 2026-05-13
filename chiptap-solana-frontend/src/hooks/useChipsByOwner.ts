// ============================================================
// src/hooks/useChipsByOwner.ts
//
// Reads chips owned by an address from the indexer.  This is fast
// and consistent with battle history; an alternative would be a
// chain-side getProgramAccounts on Metaplex Core, but that's
// expensive on mainnet without paid RPC.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { indexerApi, type IndexedChip } from "../services/indexerApi";
import wsClient from "../services/wsClient";

export function useChipsByOwner(owner: string | undefined) {
  const [chips, setChips] = useState<IndexedChip[]>([]);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!owner) { setChips([]); return; }
    setLoading(true);
    try {
      const res = await indexerApi.getChips(owner);
      setChips(res.chips || []);
    } catch {
      setChips([]);
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => { refetch(); }, [refetch]);

  // Refetch on relevant WS pings.
  //
  // SEC-18 — was `toLowerCase()` on both sides.  Solana addresses are
  // base58, which IS case-sensitive (different bytes encode under
  // different cases), so lower-casing both broke the equality check for
  // any non-lower input — refetch silently never fired and the
  // inventory page went stale until the user reloaded.
  useEffect(() => {
    if (!owner) return;
    const unsubs = [
      wsClient.on("chip:minted",   (d: any) => { if (d?.owner === owner) refetch(); }),
      wsClient.on("battle:settled", () => refetch()),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [owner, refetch]);

  return { chips, loading, refetch };
}
