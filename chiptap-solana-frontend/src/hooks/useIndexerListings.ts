// ============================================================
// src/hooks/useIndexerListings.ts — SEC-27 P2P marketplace
//
// Same shape as useIndexerBattleRoyales:
//   1. Initial REST fetch (/listings/active + my own rows)
//   2. Live updates over WS (market:* topics from eventHandler)
//   3. 30 s polling fallback while WS is down (Render free cold-start)
//
// Unlike battles, a listing's id space belongs to the MARKETPLACE
// program's own counter — never cross-reference it with a battle id.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { indexerApi, type IndexedListing } from "../services/indexerApi";
import wsClient from "../services/wsClient";
import { MARKET_ENABLED } from "../config";

export interface ListingData {
  id:           number;
  asset:        string;
  seller:       string;
  buyer:        string;
  price:        number;   // SOL
  feeBps:       number;
  fee:          number;
  paidToSeller: number;
  status:       number;   // 0=active 1=filled 2=cancelled
  tokenId:      number | null;
  tier:         number;
  wins:         number;
  createdAt:    number;
  filledAt:     number;
}

function toUnix(iso: string | null | undefined): number {
  return iso ? Math.floor(new Date(iso).getTime() / 1000) : 0;
}

function map(l: IndexedListing): ListingData {
  return {
    id:           l.id,
    asset:        l.asset,
    seller:       l.seller,
    buyer:        l.buyer || "",
    price:        Number(l.price) || 0,
    feeBps:       l.fee_bps,
    fee:          Number(l.fee) || 0,
    paidToSeller: Number(l.paid_to_seller) || 0,
    status:       l.status,
    tokenId:      l.token_id,
    tier:         l.tier ?? 0,
    wins:         l.progression_wins ?? 0,
    createdAt:    toUnix(l.created_at),
    filledAt:     toUnix(l.filled_at),
  };
}

export function useIndexerListings() {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const [items, setItems] = useState<ListingData[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  const refetch = useCallback(async () => {
    if (!MARKET_ENABLED) return;
    setLoading(true);
    try {
      // Active listings power the grid; the seller/buyer queries pull in
      // this wallet's own history so "my listings" and "sold" don't need
      // the (capped) active page to contain them.
      const reqs: Promise<{ listings: IndexedListing[] }>[] = [
        indexerApi.getActiveListings("price"),
      ];
      if (me) {
        reqs.push(indexerApi.getListings({ seller: me, limit: 50 }));
        reqs.push(indexerApi.getListings({ buyer:  me, limit: 50 }));
      }
      const res = await Promise.all(reqs);
      const merged = new Map<number, IndexedListing>();
      res.forEach((r) => r.listings.forEach((l) => merged.set(l.id, l)));
      const all = [...merged.values()].map(map).sort((a, b) => b.id - a.id);
      if (mountedRef.current) setItems(all);
    } catch (err) {
      console.warn("[indexer] listings endpoint unavailable:", (err as Error).message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [me]);

  useEffect(() => {
    mountedRef.current = true;
    refetch();
    return () => { mountedRef.current = false; };
  }, [refetch]);

  // Live WS updates — topic names match the indexer's broadcast() calls.
  useEffect(() => {
    if (!MARKET_ENABLED) return;
    wsClient.connect();
    const unsubs: (() => void)[] = [];

    unsubs.push(wsClient.on("market:listed", (d: any) =>
      setItems((prev) => {
        if (prev.some((l) => l.id === d.id)) return prev;
        // The broadcast carries no chip metadata (tier/token_id live in
        // the joined `chips` row), so pull the canonical row in the
        // background and patch it in.  Best-effort; the optimistic entry
        // already renders with sane defaults.
        indexerApi.getListing(d.id)
          .then((r) => {
            if (!mountedRef.current) return;
            setItems((p) => p.map((l) => (l.id === d.id ? map(r.listing) : l)));
          })
          .catch(() => {});
        return [{
          id: d.id, asset: d.asset, seller: d.seller, buyer: "",
          price: Number(d.price) || 0, feeBps: d.feeBps ?? 0,
          fee: 0, paidToSeller: 0, status: 0,
          tokenId: null, tier: 0, wins: 0,
          createdAt: Math.floor(Date.now() / 1000), filledAt: 0,
        }, ...prev];
      }),
    ));

    unsubs.push(wsClient.on("market:cancelled", (d: any) =>
      setItems((prev) => prev.map((l) =>
        l.id === d.id ? { ...l, status: 2 } : l)),
    ));

    unsubs.push(wsClient.on("market:filled", (d: any) =>
      setItems((prev) => prev.map((l) =>
        l.id === d.id ? {
          ...l, status: 1, buyer: d.buyer,
          fee: Number(d.fee) || 0,
          paidToSeller: Number(d.paidToSeller) || 0,
          filledAt: Math.floor(Date.now() / 1000),
        } : l)),
    ));

    return () => unsubs.forEach((fn) => fn());
  }, []);

  // Polling fallback when WS is down.
  useEffect(() => {
    if (!MARKET_ENABLED) return;
    const id = setInterval(() => {
      if (!wsClient.isConnected) refetch();
    }, 30_000);
    return () => clearInterval(id);
  }, [refetch]);

  const active = items.filter((l) => l.status === 0);

  return {
    items,
    active,
    // Everything this wallet is selling right now.
    myActive:  active.filter((l) => me && l.seller === me),
    // Other people's listings — the actually-buyable set.
    buyable:   active.filter((l) => !me || l.seller !== me),
    mySold:    items.filter((l) => me && l.seller === me && l.status === 1),
    myBought:  items.filter((l) => me && l.buyer  === me),
    loading,
    refetch,
  };
}
