// ============================================================
// src/lib/notifications.ts — global toast bus (carry-over from EVM)
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

function emit() { for (const l of listeners) l(items); }

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
 * Convert a Solana / Anchor error into a short human-readable line.
 * Tries: AnchorError.error.errorMessage → SendTransactionError logs → message → toString.
 */
export function notifyTxError(label: string, err: unknown): void {
  if (!err) return;
  const e = err as any;

  let msg: string =
    e?.error?.errorMessage      // AnchorError
    || e?.message               // generic
    || String(err);

  if (e?.logs && Array.isArray(e.logs)) {
    const last = e.logs.find((l: string) => l.includes("Error"));
    if (last) msg = last;
  }
  // Truncate
  msg = msg.split("\n")[0].slice(0, 160);
  notify("error", `${label}: ${msg}`);
}
