import pg from "pg";
import config from "../config/index.js";

pg.types.setTypeParser(20, (val) => parseInt(val, 10));   // BIGINT
pg.types.setTypeParser(1700, (val) => parseFloat(val));   // NUMERIC

const pool = new pg.Pool({
  connectionString: config.db.url,
  max: 10,
  idleTimeoutMillis: 30000,
  // Avoid noisy "Connection terminated unexpectedly" when Postgres is
  // restarted; new queries open a fresh socket on demand.
  allowExitOnIdle: false,
});

// PG emits `error` on *idle* clients when the connection drops while the
// client is parked.  Killing the process here is the classic "node-pg
// nukes prod" footgun — Docker postgres restarts, idle disconnects, even
// a momentary network blip all funnel through this path and used to call
// `process.exit(1)`.  Instead: log, increment a counter, let the pool
// reopen connections on the next acquire.  If the failure is *real* it
// will resurface on the next query and crash a request (which the API
// handles) — not the entire indexer.
let consecutivePoolErrors = 0;
let lastPoolErrorAt = 0;
pool.on("error", (err) => {
  consecutivePoolErrors += 1;
  lastPoolErrorAt = Date.now();
  console.error(
    `[pg] idle-client error (consec=${consecutivePoolErrors}):`,
    err?.message ?? err,
  );
});

// Reset the counter whenever any query succeeds.  Surfaced via /api/health.
export function poolHealth() {
  return {
    consecutiveErrors: consecutivePoolErrors,
    lastErrorAt:       lastPoolErrorAt || null,
    totalCount:        pool.totalCount,
    idleCount:         pool.idleCount,
    waitingCount:      pool.waitingCount,
  };
}

async function query(text, params) {
  try {
    const r = await pool.query(text, params);
    consecutivePoolErrors = 0;
    return r;
  } catch (e) {
    // Re-throw so the caller's try/catch sees it; just don't kill the
    // process from here.
    throw e;
  }
}

export { query };
export const getClient = () => pool.connect();
export default { query, getClient, pool, poolHealth };
