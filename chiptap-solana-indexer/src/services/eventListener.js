// ============================================================
// src/services/eventListener.js — Solana RPC subscription + backfill
//
// Solana has no `eth_getLogs`.  We use:
//   • `connection.onLogs(programId, …)` for live ingestion
//   • `connection.getSignaturesForAddress(programId, { until })` for
//     backfill of anything missed while the indexer was offline
//
// Per-program cursor stored in `indexer_cursor.last_signature` —
// the only thing that bounds backfill walks.
// ============================================================

import { Connection, PublicKey } from "@solana/web3.js";
import config from "../config/index.js";
import db from "../db/pool.js";
import { loadIdls } from "../utils/idl.js";
import { decodeEventsFromLogs } from "../utils/events.js";
import { dispatchEvent } from "./eventHandler.js";
import { reconcileChipOwners } from "./chipOwnerReconcile.js";

let connection = null;
let coders     = null;
const subscriptions = new Map();   // programId -> subscription id
let isRunning = false;
let watchdog  = null;
let reconnecting = false;

// SEC-29 — backfill health.  A failed backfill used to be logged once
// and forgotten; the cursor then sat weeks behind while the live
// subscription only saw events from boot onward (chip_nft was stuck
// from 2026-07-04 to 08-06).  Now each failure retries with backoff and
// the state per program is served by /api/indexer/status.
const backfillState = new Map();   // programId -> { state, attempts, lastError, lastErrorAt, caughtUpAt }
const BACKOFF_MS = [5_000, 15_000, 60_000, 120_000, 300_000];
// Bumped on every start(), so retry loops from before a reconnect stop.
let generation = 0;

const RECONCILE_MS = parseInt(process.env.CHIP_RECONCILE_MS || "600000", 10);  // 10 min
let reconcileTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setBackfillState(pid, patch) {
  backfillState.set(pid, { ...(backfillState.get(pid) ?? {}), ...patch });
}

export function getBackfillState() {
  return Object.fromEntries(backfillState);
}

// ============================================================
// cursor helpers
// ============================================================

async function getCursor(program) {
  const { rows } = await db.query(
    "SELECT last_signature, last_slot FROM indexer_cursor WHERE program = $1",
    [program],
  );
  return rows[0] || { last_signature: null, last_slot: 0 };
}

async function setCursor(program, signature, slot) {
  await db.query(
    `INSERT INTO indexer_cursor (program, last_signature, last_slot, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (program) DO UPDATE
       SET last_signature = $2, last_slot = $3, updated_at = NOW()`,
    [program, signature, slot],
  );
}

// ============================================================
// process one transaction (its decoded events)
// ============================================================

async function processSignature(programIdStr, signature, slot) {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta?.err) return;

  const logs = tx.meta?.logMessages || [];
  const events = decodeEventsFromLogs(logs, coders);

  let logIndex = 0;
  for (const ev of events) {
    await dispatchEvent(ev.event, ev.data, {
      slot:      slot ?? tx.slot,
      signature,
      logIndex:  logIndex++,
      program:   programIdStr,
    });
  }
}

// ============================================================
// backfill — fetch signatures back to (but not including) cursor
// ============================================================

async function backfill(programIdStr) {
  const programId = new PublicKey(programIdStr);
  const cursor = await getCursor(programIdStr);
  const batchSize = config.indexer.backfillBatch;

  console.log(
    `[IDX] backfill ${programIdStr.slice(0, 8)}… ` +
    `until=${cursor.last_signature?.slice(0, 16) ?? "(none)"}`
  );

  let before = undefined;
  const collected = [];

  // Walk pages of recent signatures backwards in time, stopping
  // when we hit our recorded cursor.
  // (getSignaturesForAddress yields newest first.)
  for (;;) {
    const page = await connection.getSignaturesForAddress(programId, {
      limit:  batchSize,
      until:  cursor.last_signature || undefined,
      before,
    });
    if (page.length === 0) break;
    collected.push(...page);
    before = page[page.length - 1].signature;
    if (page.length < batchSize) break;
  }

  // Process oldest → newest so cursor advances monotonically.
  collected.reverse();
  for (const s of collected) {
    if (s.err) continue;
    await processSignature(programIdStr, s.signature, s.slot);
    await setCursor(programIdStr, s.signature, s.slot);
  }

  console.log(`[IDX] backfilled ${collected.length} sigs for ${programIdStr.slice(0, 8)}`);
}

// ============================================================
// live subscription
// ============================================================

function subscribeLive(programIdStr) {
  const programId = new PublicKey(programIdStr);
  const subId = connection.onLogs(programId, async (logsResult, ctx) => {
    if (logsResult.err) return;
    try {
      const events = decodeEventsFromLogs(logsResult.logs, coders);
      let logIndex = 0;
      for (const ev of events) {
        await dispatchEvent(ev.event, ev.data, {
          slot:      ctx.slot,
          signature: logsResult.signature,
          logIndex:  logIndex++,
          program:   programIdStr,
        });
      }
      // SEC-29 — only move the cursor once backfill has caught up.  If
      // it jumped forward while a backfill was still failing, the gap
      // between the old cursor and this event would never be walked.
      // The event itself is processed either way (handlers are
      // idempotent), so nothing is lost by holding the cursor back.
      if (backfillState.get(programIdStr)?.state === "ok") {
        await setCursor(programIdStr, logsResult.signature, ctx.slot);
      }
    } catch (err) {
      console.error("[IDX] live process failed:", err.message);
    }
  }, "confirmed");

  subscriptions.set(programIdStr, subId);
  console.log(`[IDX] live subscribed ${programIdStr.slice(0, 8)} (subId=${subId})`);
}

// ============================================================
// Start / stop
// ============================================================

// All program IDs we listen to — used both at start and during reconnect.
// SEC-27: `marketplace` is optional (see config/index.js), so filter out
// blanks rather than subscribing to "" and blowing up in PublicKey().
function getProgramIds() {
  // chip_nft FIRST: everything else (market fills, forfeits, win
  // progression) updates rows that ChipMinted creates, and backfill
  // runs one program at a time.
  const ids = [
    config.programs.chipNft,
    config.programs.battleArena,
    config.programs.treasury,
    config.programs.marketplace,
  ].filter(Boolean);

  if (!config.programs.marketplace) {
    console.warn(
      "[IDX] MARKETPLACE_PROGRAM is not set — P2P marketplace events " +
      "(ListingCreated/Cancelled/Filled) will NOT be indexed.",
    );
  }
  return ids;
}

export async function start() {
  if (isRunning) return;
  isRunning = true;

  try {
    connection = new Connection(config.rpc.http, {
      commitment: "confirmed",
      wsEndpoint: config.rpc.ws,
    });

    const slot = await connection.getSlot();
    console.log(`[IDX] connected to RPC, current slot = ${slot}`);

    coders = loadIdls().coders;

    const programIds = getProgramIds();

    // 1. Subscribe FIRST so we don't lose anything that happens during backfill.
    for (const pid of programIds) subscribeLive(pid);

    // 2. Backfill the gap — one program at a time to go easy on a
    //    rate-limited public RPC.  A failure no longer ends there: that
    //    program gets its own retry loop in the background, and the
    //    others carry on.
    const gen = ++generation;
    for (const pid of programIds) {
      setBackfillState(pid, { state: "running", attempts: 1 });
      try {
        await backfill(pid);
        setBackfillState(pid, { state: "ok", caughtUpAt: new Date().toISOString(), lastError: null });
      } catch (err) {
        noteBackfillFailure(pid, 1, err);
        retryBackfill(pid, gen);   // not awaited
      }
    }

    // 2b. Ask the chain who actually holds each chip — events can't see
    //     order-inverted backfills or wallet-to-wallet transfers.
    scheduleReconcile();

    // 3. Health-watchdog: pings RPC every 15s.  On 2 consecutive misses
    //    we tear down (sub IDs are dead anyway after a validator restart)
    //    and re-subscribe + re-backfill — the cursor table fills the
    //    gap automatically.
    startWatchdog();

    console.log("[IDX] indexer running");
  } catch (err) {
    console.error("[IDX] start failed:", err.message);
    isRunning = false;
    console.log("[IDX] retrying in 10s...");
    setTimeout(() => start(), 10_000);
  }
}

function noteBackfillFailure(pid, attempt, err) {
  const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
  console.error(
    `[IDX] backfill failed for ${pid.slice(0, 8)} (attempt ${attempt}): ${err.message}` +
    ` — retrying in ${wait / 1000}s`,
  );
  setBackfillState(pid, {
    state: "retrying", attempts: attempt,
    lastError: err.message, lastErrorAt: new Date().toISOString(),
  });
  return wait;
}

async function retryBackfill(pid, gen) {
  let attempt = backfillState.get(pid)?.attempts ?? 1;
  for (;;) {
    await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    if (gen !== generation || !connection) return;   // a reconnect took over
    attempt += 1;
    setBackfillState(pid, { state: "running", attempts: attempt });
    try {
      await backfill(pid);
      setBackfillState(pid, { state: "ok", caughtUpAt: new Date().toISOString(), lastError: null });
      console.log(`[IDX] backfill recovered for ${pid.slice(0, 8)} after ${attempt} attempts`);
      reconcileNow();   // the late events may have moved chips
      return;
    } catch (err) {
      noteBackfillFailure(pid, attempt, err);
    }
  }
}

function reconcileNow() {
  if (!connection) return;
  reconcileChipOwners(connection).catch(() => {});   // logs + records its own errors
}

function scheduleReconcile() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileNow();
  if (RECONCILE_MS > 0) reconcileTimer = setInterval(reconcileNow, RECONCILE_MS);
}

function startWatchdog() {
  if (watchdog) clearInterval(watchdog);
  let consecutiveFailures = 0;
  watchdog = setInterval(async () => {
    if (!connection || reconnecting) return;
    try {
      await connection.getSlot();
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      console.warn(
        `[IDX] RPC watchdog ping failed (${consecutiveFailures}/2):`,
        err.message,
      );
      if (consecutiveFailures >= 2) {
        consecutiveFailures = 0;
        triggerReconnect("watchdog 2× ping failure").catch((e) =>
          console.error("[IDX] reconnect failed:", e.message),
        );
      }
    }
  }, 15_000);
}

async function triggerReconnect(reason) {
  if (reconnecting) return;
  reconnecting = true;
  console.warn(`[IDX] reconnecting RPC: ${reason}`);
  try {
    await stop({ keepWatchdog: true });
    // Brief pause so the validator (if it's restarting) has time to be
    // up before we hammer it.
    await new Promise((r) => setTimeout(r, 3_000));
    isRunning = false;          // force start() to actually re-run
    await start();
  } finally {
    reconnecting = false;
  }
}

export async function stop({ keepWatchdog = false } = {}) {
  if (!connection) return;
  for (const subId of subscriptions.values()) {
    try { await connection.removeOnLogsListener(subId); } catch {}
  }
  subscriptions.clear();
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
  if (!keepWatchdog && watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  isRunning = false;
  connection = null;
}

export function getConnection() { return connection; }
