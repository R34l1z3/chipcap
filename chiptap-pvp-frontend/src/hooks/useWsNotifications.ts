import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import wsClient from "../services/wsClient";
import {
  notify,
  dismiss,
  subscribe,
  type Notification,
} from "../services/notifications";

export type { Notification };

/**
 * Subscribes to the global notification bus and to WS events relevant
 * to the connected account (wins, losses, joins, settlements, VRF timeout, cancels).
 *
 * Returns the current toast list and a `dismissNotif` callback.
 * Pages can also push toasts directly via `notify(...)` from `services/notifications`.
 */
export function useWsNotifications() {
  const { address } = useAccount();
  const [notifications, setNotifications] = useState<Notification[]>([]);

  // Subscribe to the shared store.
  useEffect(() => subscribe(setNotifications), []);

  // Wire WS → toasts (only while a wallet is connected).
  useEffect(() => {
    if (!address) return;
    const addr = address.toLowerCase();
    const unsubs: (() => void)[] = [];

    unsubs.push(wsClient.on("battle:decided", (data) => {
      if (data.winner === addr) notify("win", `You won battle #${data.id}! Claim your chip.`);
      else if (data.loser === addr) notify("loss", `You lost battle #${data.id}. Pay or forfeit within 24h.`);
    }));

    unsubs.push(wsClient.on("battle:joined", (data) => {
      if (data.relevantPlayers?.includes(addr) && data.playerB !== addr) {
        notify("joined", `Someone joined your battle #${data.id}! VRF rolling...`);
      }
    }));

    unsubs.push(wsClient.on("battle:settled", (data) => {
      notify("settled", `Battle #${data.id} settled (${data.resolution}).`);
    }));

    unsubs.push(wsClient.on("battle:vrf_timeout", (data) => {
      notify("info", `Battle #${data.id}: VRF timed out, chips refunded.`);
    }));

    unsubs.push(wsClient.on("battle:cancelled", (data) => {
      notify("info", `Battle #${data.id} cancelled.`);
    }));

    return () => unsubs.forEach((fn) => fn());
  }, [address]);

  return { notifications, dismissNotif: dismiss };
}
