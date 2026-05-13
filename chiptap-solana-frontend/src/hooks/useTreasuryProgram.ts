import { useMemo } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { buildProvider, getTreasuryProgram } from "../lib/programs";

export function useTreasuryProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    const provider = buildProvider(connection, wallet);
    if (!provider) return null;
    try { return getTreasuryProgram(provider); }
    catch { return null; }
  }, [connection, wallet]);
}
