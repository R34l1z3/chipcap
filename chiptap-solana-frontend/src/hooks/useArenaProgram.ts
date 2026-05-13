import { useMemo } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { buildProvider, getBattleArenaProgram } from "../lib/programs";

export function useArenaProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    const provider = buildProvider(connection, wallet);
    if (!provider) return null;
    try { return getBattleArenaProgram(provider); }
    catch { return null; }
  }, [connection, wallet]);
}
