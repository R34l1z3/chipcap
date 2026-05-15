// ============================================================
// src/index.js — ChipTap Solana indexer entry point
// ============================================================

import express from "express";
import cors from "cors";
import helmet from "helmet";
import config from "./config/index.js";
import apiRoutes from "./routes/api.js";
import db from "./db/pool.js";
import { start as startIndexer } from "./services/eventListener.js";
import { startWsServer } from "./services/wsBroadcast.js";
import { startEventsRetention } from "./services/eventsRetention.js";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1kb" }));

if (config.isDev) {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// Healthcheck returns 503 when the DB has been unhappy too long —
// otherwise Docker `depends_on: service_healthy` would let the frontend
// boot against a disconnected indexer.
app.get("/api/health", async (_req, res) => {
  const ph = db.poolHealth?.() ?? null;
  let dbOk = false;
  try {
    await db.query("SELECT 1");
    dbOk = true;
  } catch { /* dbOk stays false */ }

  const healthy = dbOk && (ph?.consecutiveErrors ?? 0) < 5;
  res.status(healthy ? 200 : 503).json({
    status:  healthy ? "ok" : "degraded",
    service: "chiptap-solana-indexer",
    db:      { ok: dbOk, ...(ph ?? {}) },
    timestamp: new Date().toISOString(),
  });
});

app.use("/api", apiRoutes);

app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error("[ERR]", err);
  res.status(500).json({ error: config.isDev ? err.message : "Internal error" });
});

async function main() {
  // Bind to PORT (Render / Heroku / Fly all set this) or fall back.
  const port = parseInt(process.env.PORT || config.port, 10);
  const httpServer = app.listen(port, () => {
    console.log(`
  ╔══════════════════════════════════════╗
  ║   ChipTap Solana Indexer             ║
  ║   API:  http://localhost:${String(port).padEnd(13)}║
  ║   WS:   ${(process.env.WS_ATTACH_HTTP === "1" ? `/ws on :${port}` : `ws://localhost:${config.wsPort}`).padEnd(28)} ║
  ║   RPC:  ${config.rpc.http.padEnd(28)} ║
  ╚══════════════════════════════════════╝`);
  });

  // Single-port hosts (Render free tier, Vercel proxy) attach WS to the
  // same port via /ws path-upgrade.  Multi-port (Fly.io, local dev) use
  // a separate WS_PORT.
  if (process.env.WS_ATTACH_HTTP === "1") {
    startWsServer({ httpServer, path: "/ws" });
  } else {
    startWsServer();
  }

  startEventsRetention();
  await startIndexer();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
