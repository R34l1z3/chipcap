// ============================================================
// src/hooks/useWsNotifications.ts
// ============================================================

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import wsClient from "../services/wsClient";
import { notify, dismiss, subscribe, type Notification } from "../lib/notifications";

export type { Notification };

export function useWsNotifications() {
  const { publicKey } = useWallet();
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => subscribe(setNotifications), []);

  useEffect(() => {
    if (!publicKey) return;
    const me = publicKey.toBase58();
    const unsubs: (() => void)[] = [];

    unsubs.push(wsClient.on("battle:decided", (d: any) => {
      if (d.winner === me) notify("win", `You won battle #${d.id}! Claim your chip.`);
      else if (d.loser === me) notify("loss", `You lost battle #${d.id}. Pay or forfeit within 24h.`);
    }));

    unsubs.push(wsClient.on("battle:joined", (d: any) => {
      if (d.relevantPlayers?.includes(me) && d.playerB !== me) {
        notify("joined", `Someone joined your battle #${d.id}! Rolling…`);
      }
    }));

    unsubs.push(wsClient.on("battle:settled", (d: any) => {
      notify("settled", `Battle #${d.id} settled (${d.resolution}).`);
    }));

    unsubs.push(wsClient.on("battle:vrf_timeout", (d: any) => {
      notify("info", `Battle #${d.id}: VRF timed out, chips refunded.`);
    }));

    unsubs.push(wsClient.on("battle:cancelled", (d: any) => {
      notify("info", `Battle #${d.id} cancelled.`);
    }));

    return () => unsubs.forEach((fn) => fn());
  }, [publicKey?.toBase58()]);

  return { notifications, dismissNotif: dismiss };
}
