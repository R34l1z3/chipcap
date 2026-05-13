// ============================================================
// src/services/wsClient.ts — same client we used on EVM, with
// the relative-URL resolver from the previous iteration.
// ============================================================

type WsHandler = (data: any) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers = new Map<string, Set<WsHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentDelay = 2000;
  private intentionalClose = false;
  public connected = false;

  constructor(url: string) { this.url = url; }

  get isConnected(): boolean { return this.connected; }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.intentionalClose = false;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.connected = true;
        this.currentDelay = 2000;
        this.emit("ws:connected", {});
      };
      this.ws.onmessage = (e) => {
        try { const msg = JSON.parse(e.data); this.emit(msg.type, msg.data); }
        catch {}
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.emit("ws:disconnected", {});
        if (!this.intentionalClose) this.scheduleReconnect();
      };
      this.ws.onerror = () => {};
    } catch { this.scheduleReconnect(); }
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.currentDelay = Math.min(this.currentDelay * 1.5, 30000);
      this.connect();
    }, this.currentDelay);
  }

  on(event: string, handler: WsHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  private emit(event: string, data: any) {
    this.handlers.get(event)?.forEach((h) => { try { h(data); } catch {} });
    this.handlers.get("*")?.forEach((h) => { try { h({ type: event, data }); } catch {} });
  }
}

function resolveWsUrl(raw: string | undefined): string {
  const fallback = "ws://localhost:3003";
  let base = fallback;
  if (raw) {
    if (/^wss?:\/\//i.test(raw)) base = raw;
    else if (typeof window !== "undefined" && raw.startsWith("/")) {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      base = `${proto}//${window.location.host}${raw}`;
    }
  }
  // SEC-13 — append shared-token query param if configured.  The indexer
  // closes connections with code 4401 when the token doesn't match.
  // Empty/missing token = unauthenticated, which works against a dev
  // indexer that also has no WS_TOKEN set.
  const token = import.meta.env.VITE_WS_TOKEN;
  if (token) {
    const sep = base.includes("?") ? "&" : "?";
    base = `${base}${sep}token=${encodeURIComponent(token)}`;
  }
  return base;
}

export const wsClient = new WsClient(resolveWsUrl(import.meta.env.VITE_WS_URL));
export default wsClient;
