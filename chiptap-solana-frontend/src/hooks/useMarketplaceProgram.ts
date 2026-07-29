import { useMemo } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { buildProvider, getMarketplaceProgram } from "../lib/programs";
import { MARKET_ENABLED } from "../config";

export function useMarketplaceProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    // SEC-27 — the marketplace program id is optional config; without it
    // we return null so the page renders its "not configured" state
    // instead of sending txs to a program the operator never enabled.
    if (!MARKET_ENABLED) return null;
    const provider = buildProvider(connection, wallet);
    if (!provider) return null;
    try { return getMarketplaceProgram(provider); }
    catch { return null; }
  }, [connection, wallet]);
}
