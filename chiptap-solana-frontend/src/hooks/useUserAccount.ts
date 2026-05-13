// ============================================================
// src/hooks/useUserAccount.ts
//
// Read the connected wallet's UserAccount PDA (lamport ledger).
// Returns null if not connected or PDA doesn't exist yet.
// ============================================================

import { useEffect, useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { useArenaProgram } from "./useArenaProgram";
import * as pda from "../lib/pda";

export interface UserAccountData {
  authority: string;
  balance: BN;
  locked:  BN;
}

export function useUserAccount(refetchEvery = 8000) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const program = useArenaProgram();

  const [data, setData]   = useState<UserAccountData | null>(null);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!publicKey || !program) { setData(null); return; }
    setLoading(true);
    try {
      const accPda = pda.userAccount(publicKey);
      const acc = await (program.account as any).userAccount.fetchNullable(accPda);
      if (acc) {
        setData({
          authority: acc.authority.toBase58(),
          balance: acc.balance,
          locked:  acc.locked,
        });
      } else {
        setData(null);
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [publicKey?.toBase58(), program, connection]);

  useEffect(() => {
    refetch();
    if (!refetchEvery) return;
    const id = setInterval(refetch, refetchEvery);
    return () => clearInterval(id);
  }, [refetch, refetchEvery]);

  return { data, loading, refetch };
}
