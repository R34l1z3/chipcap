// ============================================================
// src/services/wsBroadcast.js — WebSocket server for real-time updates
// ============================================================

import { WebSocketServer } from "ws";
import config from "../config/index.js";

let wss = null;

export function startWsServer() {
  wss = new WebSocketServer({ port: config.wsPort });

  wss.on("connection", (ws) => {
    console.log(`[WS] Client connected (total: ${wss.clients.size})`);
    ws.send(JSON.stringify({ type: "connected", timestamp: Date.now() }));

    ws.on("close", () => {
      console.log(`[WS] Client disconnected (total: ${wss.clients.size})`);
    });

    ws.on("error", (err) => {
      console.error("[WS] Client error:", err.message);
    });
  });

  console.log(`[WS] WebSocket server running on port ${config.wsPort}`);
  return wss;
}

/**
 * Broadcast an event to all connected clients.
 * @param {string} type — event type (e.g. "battle:created", "battle:decided")
 * @param {object} data — event payload
 */
export function broadcast(type, data) {
  if (!wss) return;

  const message = JSON.stringify({ type, data, timestamp: Date.now() });
  let sent = 0;

  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(message);
      sent++;
    }
  });

  if (sent > 0 && config.isDev) {
    console.log(`[WS] Broadcast "${type}" to ${sent} clients`);
  }
}

/**
 * Broadcast to specific player addresses only.
 */
export function broadcastToPlayers(type, data, playerAddresses) {
  // In production, map ws connections to addresses via auth.
  // For now, broadcast to all — frontend filters by address.
  broadcast(type, { ...data, relevantPlayers: playerAddresses });
}
