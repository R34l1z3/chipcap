// ============================================================
// chiptap-solana-relayer / src/index.js
//
// One responsibility: watch battle_arena for `BattleJoined` events,
// and call `fulfill_random_words(seed)` as the registered
// vrf_authority shortly after.
//
// Subscription strategy:
//   • Primary: connection.onLogs(programId) — live stream
//   • Fallback: every POLL_INTERVAL_MS, getSignaturesForAddress with
//     `until = last seen` to catch anything we missed during a WS
//     hiccup.  Same pattern as the indexer (SEC-11 watchdog).
//
// Idempotency:
//   • If two BattleJoined events arrive for the same battle_id (replay,
//     reorg, etc.), the program rejects the second `fulfill_random_words`
//     with WrongStatus (battle is already DECIDED).  Relayer treats that
//     as success.
// ============================================================

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @coral-xyz/anchor is CJS — ESM consumers must destructure from the
// default export.  Trying named ESM imports fails with "Named export
// 'BN' not found".
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, BorshEventCoder, Program, Wallet, setProvider: setProviderSafely } = anchorPkg;
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { pickSource } from "./randomness.js";
import { runSwitchboardCycle, switchboardEndpoints } from "./switchboard.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- config -------------------------------------------------------
const cfg = {
  rpcHttp:           process.env.SOLANA_RPC || "https://api.devnet.solana.com",
  rpcWs:             process.env.SOLANA_WS  || "wss://api.devnet.solana.com",
  programId:         new PublicKey(process.env.BATTLE_ARENA_PROGRAM || "Ae65nkzg2DD4dFUttxUXPpVfZT7kMPX1L9Uk9GDxkBU8"),
  keypairPath:       process.env.VRF_AUTHORITY_KEYPAIR || `${process.env.HOME}/.config/solana/id.json`,
  randomnessSource:  process.env.RANDOMNESS_SOURCE || "slothash",
  fulfillDelayMs:    parseInt(process.env.FULFILL_DELAY_MS || "3000", 10),
  pollIntervalMs:    parseInt(process.env.POLL_INTERVAL_MS || "20000", 10),
  debug:             process.env.DEBUG === "1",
};
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dbg = (...a) => { if (cfg.debug) log("[debug]", ...a); };

// ---- wallet + provider -------------------------------------------
// Two ways to provide the keypair, in priority order:
//   1. VRF_AUTHORITY_KEYPAIR_JSON — raw JSON array, used by Fly.io / Docker
//      where the keypair is a "secret" env var.
//   2. VRF_AUTHORITY_KEYPAIR — file path, used in local dev where the
//      keypair lives at ~/.config/solana/id.json.
const secret = process.env.VRF_AUTHORITY_KEYPAIR_JSON
  ? JSON.parse(process.env.VRF_AUTHORITY_KEYPAIR_JSON)
  : JSON.parse(fs.readFileSync(cfg.keypairPath, "utf8"));
const wallet = new Wallet(Keypair.fromSecretKey(Uint8Array.from(secret)));
log("[relayer] vrf_authority =", wallet.publicKey.toBase58());

const connection = new Connection(cfg.rpcHttp, {
  commitment: "confirmed",
  wsEndpoint: cfg.rpcWs,
});
const provider = new AnchorProvider(connection, wallet, {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
setProviderSafely(provider);

// ---- program + IDL helpers ---------------------------------------
const arenaIdl = JSON.parse(
  fs.readFileSync(path.join(here, "..", "idl", "battle_arena.json"), "utf8"),
);
const arena = new Program(arenaIdl, provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, arena.programId)[0];
const arenaConfig = pda([enc("arena")]);
// Battle PDA seeds in the program are [b"battle", id.le8].
const battleSeed = (id) =>
  pda([enc("battle"), new BN(id).toArrayLike(Buffer, "le", 8)]);

const eventCoder = new BorshEventCoder(arenaIdl);

// ---- main: fulfill one battle ------------------------------------
const inflight = new Set();         // battle_ids currently being processed
const completed = new Set();        // already-fulfilled in this process

async function fulfill(battleId) {
  const key = String(battleId);
  if (inflight.has(key) || completed.has(key)) {
    dbg(`battle ${battleId} already in-flight / done — skipping`);
    return;
  }
  inflight.add(key);
  try {
    // Brief pause so the on-chain state has time to commit join_battle's
    // setting status = ROLLING, AND so users see "rolling..." in the UI.
    await new Promise((r) => setTimeout(r, cfg.fulfillDelayMs));

    const bPda = battleSeed(battleId);

    // Re-read battle to confirm it's actually in ROLLING.  Avoids
    // wasting tx when a replay arrives for an already-resolved battle.
    let b;
    try { b = await arena.account.battle.fetch(bPda); }
    catch (e) { log(`[fulfill #${battleId}] battle not on chain (${e.message}) — skipping`); return; }
    if (b.status !== 1) {
      log(`[fulfill #${battleId}] status=${b.status} (not ROLLING) — skipping`);
      completed.add(key);
      return;
    }

    // SEC-21 — Option B uses a separate ix and skips picking a seed in
    // JS (the seed comes from the on-chain Switchboard value).
    if (cfg.randomnessSource === "switchboard") {
      const { queue } = switchboardEndpoints(
        cfg.rpcHttp.includes("mainnet") ? "mainnet" : "devnet",
      );
      log(`[fulfill #${battleId}] starting Switchboard cycle (queue=${queue.toBase58().slice(0,8)}…)`);
      const { randomnessAccount, fulfillSig } = await runSwitchboardCycle({
        connection,
        payer:           wallet.payer,
        arenaProgram:    arena,
        battleId,
        battlePda:       bPda,
        arenaConfigPda:  arenaConfig,
        queuePubkey:     queue,
      });
      log(`[fulfill #${battleId}] OK (Switchboard)  randomness=${randomnessAccount.toBase58().slice(0,8)}…  tx=${fulfillSig.slice(0,16)}…`);
      completed.add(key);
      return;
    }

    // Option A — legacy trusted-relayer path (slothash).
    const fetchSeed = pickSource(cfg.randomnessSource);
    const seedU64   = await fetchSeed(connection, battleId);
    dbg(`battle #${battleId} seed = ${seedU64} (source=${cfg.randomnessSource})`);

    const sig = await arena.methods
      .fulfillRandomWords(new BN(seedU64))
      .accounts({
        config: arenaConfig,
        battle: bPda,
        vrfAuthority: wallet.publicKey,
      })
      .rpc();

    log(`[fulfill #${battleId}] OK  tx=${sig.slice(0, 16)}…`);
    completed.add(key);
  } catch (e) {
    // WrongStatus (already DECIDED / SETTLED) is benign — race lost.
    if (/WrongStatus/.test(e.message) || /6002/.test(e.message)) {
      dbg(`[fulfill #${battleId}] already settled — fine`);
      completed.add(key);
    } else {
      log(`[fulfill #${battleId}] FAILED:`, e.message);
    }
  } finally {
    inflight.delete(key);
  }
}

// ---- event decoder ------------------------------------------------
const PROGRAM_DATA_PREFIX = "Program data: ";

function extractBattleJoinedIds(logs) {
  const ids = [];
  for (const line of logs || []) {
    if (typeof line !== "string") continue;
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length).trim();
    if (!b64) continue;
    try {
      const decoded = eventCoder.decode(b64);
      if (decoded?.name === "BattleJoined") {
        ids.push(decoded.data.battle_id ?? decoded.data.battleId);
      }
    } catch { /* not our event, ignore */ }
  }
  return ids;
}

// ---- live subscription -------------------------------------------
let subId = null;
async function startLive() {
  if (subId !== null) return;
  subId = connection.onLogs(
    cfg.programId,
    (logsResult) => {
      if (logsResult.err) return;
      const ids = extractBattleJoinedIds(logsResult.logs);
      for (const id of ids) {
        log(`[live] BattleJoined #${id} in sig=${logsResult.signature.slice(0,16)}…`);
        fulfill(id);
      }
    },
    "confirmed",
  );
  log(`[live] subscribed (subId=${subId})`);
}
async function stopLive() {
  if (subId === null) return;
  try { await connection.removeOnLogsListener(subId); } catch {}
  subId = null;
}

// ---- polling fallback (for missed events) ------------------------
let lastBackfillSig = null;
async function pollForMissed() {
  try {
    const sigs = await connection.getSignaturesForAddress(
      cfg.programId,
      { limit: 50, until: lastBackfillSig || undefined },
    );
    if (sigs.length === 0) return;
    lastBackfillSig = sigs[0].signature;
    // Process oldest → newest so timing remains sensible.
    for (const s of sigs.slice().reverse()) {
      if (s.err) continue;
      const tx = await connection.getTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta?.logMessages) continue;
      const ids = extractBattleJoinedIds(tx.meta.logMessages);
      for (const id of ids) {
        log(`[poll] BattleJoined #${id} in sig=${s.signature.slice(0,16)}…`);
        fulfill(id);
      }
    }
  } catch (e) {
    log("[poll] failed:", e.message);
  }
}

// ---- watchdog (mirror of SEC-11 in indexer) ----------------------
let consecutiveFailures = 0;
async function watchdog() {
  try {
    await connection.getSlot();
    consecutiveFailures = 0;
  } catch (e) {
    consecutiveFailures += 1;
    log(`[watchdog] ping failed (${consecutiveFailures}/2):`, e.message);
    if (consecutiveFailures >= 2) {
      consecutiveFailures = 0;
      log("[watchdog] tearing down + restarting subscription");
      await stopLive();
      setTimeout(startLive, 3000);
    }
  }
}

// ---- main --------------------------------------------------------
async function main() {
  const slot = await connection.getSlot();
  log(`[boot] connected to ${cfg.rpcHttp}, slot=${slot}`);
  log(`[boot] watching program ${cfg.programId.toBase58()}`);
  log(`[boot] randomness source: ${cfg.randomnessSource}`);

  await startLive();
  setInterval(pollForMissed, cfg.pollIntervalMs);
  setInterval(watchdog,      15_000);

  log("[boot] relayer running");
}

main().catch((e) => { console.error("[boot] FATAL:", e); process.exit(1); });

// Graceful shutdown — let in-flight fulfills finish.
function shutdown(sig) {
  log(`[shutdown] ${sig} received`);
  stopLive().finally(() => process.exit(0));
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
