// ============================================================
// src/services/wsBroadcast.js — WebSocket fanout
//
// SEC-13 hardening:
//   • Optional shared-token auth (WS_TOKEN env).  Without it, on a
//     public host anyone with the URL would receive wallet-address
//     broadcasts (deposit / withdraw / battle events).
//   • Hard cap on concurrent clients (WS_MAX_CLIENTS) — protects
//     against trivial resource exhaustion.
//   • Backpressure-aware send: if a client's `bufferedAmount` exceeds
//     WS_MAX_BUFFERED_BYTES we terminate the socket instead of letting
//     it pile up.
//   • Heartbeat: 30 s ping interval, terminate on missed pong — kicks
//     out dead TCP connections that the kernel hasn't reaped yet.
// ============================================================

import { WebSocketServer } from "ws";
import config from "../config/index.js";

let wss = null;
let heartbeat = null;

/**
 * Start the WS server.
 *
 * Two modes:
 *   - standalone port (dev / Fly.io style):  startWsServer()
 *   - attached to an existing HTTP server at `/ws` (Render free tier,
 *     Vercel proxy, or any single-port host):
 *         startWsServer({ httpServer, path: "/ws" })
 *
 * Same WSS instance + handlers either way.
 */
export function startWsServer(opts = {}) {
  const { httpServer = null, path = "/ws" } = opts;
  const wssOpts = httpServer
    ? { server: httpServer, path, handleProtocols: () => false }
    : { port: config.wsPort, handleProtocols: () => false };
  wss = new WebSocketServer(wssOpts);

  wss.on("connection", (ws, req) => {
    // ---- auth -----------------------------------------------------
    if (config.ws.token) {
      const url = new URL(req.url ?? "/", "http://placeholder");
      const provided =
        url.searchParams.get("token") ??
        req.headers["sec-websocket-protocol"] ??
        "";
      if (provided !== config.ws.token) {
        // 4401 ≈ "unauthorized" (app-defined 4xxx range).
        ws.close(4401, "unauthorized");
        return;
      }
    }

    // ---- capacity -------------------------------------------------
    if (wss.clients.size > config.ws.maxClients) {
      ws.close(4503, "server full");
      return;
    }

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    safeSend(ws, JSON.stringify({ type: "connected", timestamp: Date.now() }));
    ws.on("error", (err) => console.error("[WS] client:", err.message));
  });

  // ---- heartbeat --------------------------------------------------
  heartbeat = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch {}
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    });
  }, config.ws.pingMs);

  wss.on("close", () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  });

  const where = httpServer
    ? `attached to API server at path=${path}`
    : `on port ${config.wsPort}`;
  console.log(
    `[WS] WebSocket server running ${where}` +
    (config.ws.token ? " (token auth on)" : " (anon)"),
  );
  return wss;
}

// Send with backpressure awareness — drop clients that aren't draining.
function safeSend(ws, payload) {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > config.ws.maxBufferedBytes) {
    try { ws.terminate(); } catch {}
    return;
  }
  try { ws.send(payload); } catch (e) {
    console.error("[WS] send failed, terminating client:", e.message);
    try { ws.terminate(); } catch {}
  }
}

export function broadcast(type, data) {
  if (!wss) return;
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  wss.clients.forEach((c) => safeSend(c, msg));
}

export function broadcastToPlayers(type, data, players) {
  // Per-player auth would go here.  Until then, broadcast to all and let
  // the frontend filter by `relevantPlayers`.
  broadcast(type, { ...data, relevantPlayers: players });
}
