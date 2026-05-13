import { useMemo } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { buildProvider, getChipNftProgram } from "../lib/programs";

export function useChipNftProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    const provider = buildProvider(connection, wallet);
    if (!provider) return null;
    try { return getChipNftProgram(provider); }
    catch { return null; }
  }, [connection, wallet]);
}
