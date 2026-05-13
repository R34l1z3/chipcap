// ============================================================
// src/services/notifications.ts — global in-memory toast bus
//
// Used by:
//   - useWsNotifications (subscribes + emits WS-driven events)
//   - any page that wants to push a tx error/info toast via notify()
// ============================================================

export type NotifType = "win" | "loss" | "joined" | "settled" | "created" | "info" | "error";

export interface Notification {
  id: number;
  type: NotifType;
  message: string;
  timestamp: number;
}

type Listener = (list: Notification[]) => void;

let nextId = 0;
let items: Notification[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

/** Push a toast. Auto-dismisses after `ttlMs` (default 8s). */
export function notify(type: NotifType, message: string, ttlMs = 8000): number {
  const n: Notification = { id: ++nextId, type, message, timestamp: Date.now() };
  items = [n, ...items].slice(0, 20);
  emit();
  if (ttlMs > 0) setTimeout(() => dismiss(n.id), ttlMs);
  return n.id;
}

export function dismiss(id: number): void {
  items = items.filter((x) => x.id !== id);
  emit();
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(items);
  return () => { listeners.delete(l); };
}

/**
 * Convert a wagmi/viem error into a short human-readable message
 * and push a toast. Best-effort — falls back to the raw message.
 */
export function notifyTxError(label: string, err: unknown): void {
  if (!err) return;
  const e = err as { shortMessage?: string; message?: string; cause?: { shortMessage?: string } };
  const msg =
    e.shortMessage ||
    e.cause?.shortMessage ||
    (e.message ? e.message.split("\n")[0].slice(0, 140) : "Unknown error");
  notify("error", `${label}: ${msg}`);
}
