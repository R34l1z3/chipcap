// ============================================================
// src/services/eventsRetention.js — SEC-16
//
// The `events` table is a debug / replay aid; it grows unbounded
// otherwise.  At indexer boot we schedule a periodic prune that
// drops rows older than EVENTS_RETENTION_DAYS (default 30).
//
// Idempotency relies on the `(signature, log_index, event_name)`
// uniqueness constraint — by the time we prune a row, any backfill
// replay is also outside its useful window, so duplicate-suppression
// for fresh signatures remains intact.
// ============================================================

import db from "../db/pool.js";

let timer = null;

export function startEventsRetention({
  retentionDays = parseInt(process.env.EVENTS_RETENTION_DAYS || "30", 10),
  intervalMs    = parseInt(process.env.EVENTS_RETENTION_INTERVAL_MS || `${6 * 60 * 60 * 1000}`, 10),
} = {}) {
  if (retentionDays <= 0) {
    console.log("[retention] disabled (EVENTS_RETENTION_DAYS=0)");
    return;
  }
  if (timer) clearInterval(timer);

  async function tick() {
    try {
      const { rowCount } = await db.query(
        `DELETE FROM events WHERE indexed_at < NOW() - ($1 || ' days')::interval`,
        [String(retentionDays)],
      );
      if (rowCount > 0) {
        console.log(`[retention] pruned ${rowCount} event rows older than ${retentionDays} days`);
      }
    } catch (e) {
      // Don't crash the indexer on a transient PG error — the next tick
      // will retry.  pool.js already logs and counts these.
      console.error("[retention] prune failed:", e.message);
    }
  }

  // First sweep on boot (avoids waiting 6h to remove any backlog), then
  // periodic.
  tick();
  timer = setInterval(tick, intervalMs);
  console.log(
    `[retention] running every ${Math.round(intervalMs / 60000)} min, ` +
    `keeping ${retentionDays} days of events`,
  );
}

export function stopEventsRetention() {
  if (timer) { clearInterval(timer); timer = null; }
}
