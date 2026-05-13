// ============================================================
// src/index.js — ChipTap Indexer entry point
// ============================================================

import express from "express";
import cors from "cors";
import helmet from "helmet";
import config from "./config/index.js";
import apiRoutes from "./routes/api.js";
import { start as startIndexer } from "./services/eventListener.js";
import { startWsServer } from "./services/wsBroadcast.js";

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1kb" }));

// Logging
if (config.isDev) {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// Health
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "chiptap-indexer", timestamp: new Date().toISOString() });
});

// API routes
app.use("/api", apiRoutes);

// 404
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error("[ERR]", err);
  res.status(500).json({ error: config.isDev ? err.message : "Internal error" });
});

// ============================================================
// Start everything
// ============================================================
async function main() {
  // 1. Start HTTP API
  app.listen(config.port, () => {
    console.log(`
  ╔══════════════════════════════════════╗
  ║   ChipTap Indexer                    ║
  ║   API:  http://localhost:${config.port}        ║
  ║   WS:   ws://localhost:${config.wsPort}         ║
  ╚══════════════════════════════════════╝`);
  });

  // 2. Start WebSocket server
  startWsServer();

  // 3. Start blockchain event indexer
  await startIndexer();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
