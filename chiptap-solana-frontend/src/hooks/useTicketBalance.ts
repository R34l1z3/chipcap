// ============================================================
// src/hooks/useTicketBalance.ts — SEC-23
//
// Read the connected wallet's tournament-ticket SPL balance from its
// Associated Token Account.  Returns 0 if the ATA doesn't exist yet
// (= first-time user, the buy_ticket ix will create it via init_if_needed).
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ticketMint } from "../lib/pda";

export function useTicketBalance() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [balance, setBalance] = useState<number>(0);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!publicKey) { setBalance(0); return; }
    setLoading(true);
    try {
      const ata = getAssociatedTokenAddressSync(ticketMint(), publicKey);
      const info = await connection.getTokenAccountBalance(ata).catch(() => null);
      setBalance(info?.value?.uiAmount ?? 0);
    } catch (e) {
      // Most common case: ATA doesn't exist (first-time user).  Just 0.
      setBalance(0);
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => { refetch(); }, [refetch]);

  // Re-poll once a minute so a successful buy/burn is reflected even
  // if the caller forgets to invoke refetch().  Cheap RPC call.
  useEffect(() => {
    if (!publicKey) return;
    const id = setInterval(refetch, 60_000);
    return () => clearInterval(id);
  }, [publicKey, refetch]);

  return { balance, loading, refetch, ata: publicKey ? getAssociatedTokenAddressSync(ticketMint(), publicKey) : null };
}

export { ticketMint };
