// ============================================================
// src/services/backfillRunner.js — one-shot backfill, then exit.
//
// Usage:  npm run backfill
// ============================================================

import { start, stop } from "./eventListener.js";
import db from "../db/pool.js";

(async () => {
  await start();
  // Give backfill a moment to walk back, then exit cleanly.
  await new Promise((r) => setTimeout(r, 30_000));
  await stop();
  await db.pool.end();
  process.exit(0);
})();
