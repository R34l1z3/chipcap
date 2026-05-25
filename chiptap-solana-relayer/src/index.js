// ============================================================
// chiptap-solana-relayer / src/index.js
//
// Three responsibilities:
//   1. Watch battle_arena for `BattleJoined` events → fulfill 1v1 VRF
//      (SEC-21 Switchboard Option B, or legacy slothash Option A).
//   2. (SEC-22 Phase 2) Watch for `BattleRoyaleRolling` events →
//      fulfill Battle Royale VRF via the same Switchboard pipeline
//      (BR is Switchboard-only — there is no slothash fallback ix).
//   3. (SEC-23 Phase 2) Watch for `TournamentMatchRolling` events →
//      fulfill ONE bracket match via Switchboard.  start_tournament
//      emits 4 events (R0 quarters) at once; advance_match emits 2 more
//      for R1 semis and 2 for R2 (final + 3rd-place).  We fulfil each
//      independently — 7 total Switchboard cycles per tournament.
//
// Subscription strategy:
//   • Primary: connection.onLogs(programId) — live stream
//   • Fallback: every POLL_INTERVAL_MS, getSignaturesForAddress with
//     `until = last seen` to catch anything we missed during a WS
//     hiccup.  Same pattern as the indexer (SEC-11 watchdog).
//
// Idempotency:
//   • If two events arrive for the same target (replay, reorg, etc.),
//     the program rejects the second fulfil with WrongStatus or
//     TournamentMatchNotPending.  Relayer treats both as success.
//   • Plus per-target in-process `completed` Set short-circuits before
//     we even burn a Switchboard cycle on the dupe.
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
// SEC-22 — Battle Royale PDA seeds are [b"royale", id.le8].
// Royale ID is drawn from the same `arena.next_battle_id` counter,
// so 1v1 and BR cannot collide on the same numeric id.
const royaleSeed = (id) =>
  pda([enc("royale"), new BN(id).toArrayLike(Buffer, "le", 8)]);
// SEC-23 — Tournament PDA seeds are [b"tournament", id.le8].
const tournamentSeed = (id) =>
  pda([enc("tournament"), new BN(id).toArrayLike(Buffer, "le", 8)]);

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
        payer:        wallet.payer,
        queuePubkey:  queue,
        buildFulfillIx: (randomnessAccountPk) =>
          arena.methods
            .fulfillRandomWordsSwitchboard()
            .accounts({
              config:            arenaConfig,
              battle:            bPda,
              randomnessAccount: randomnessAccountPk,
              caller:            wallet.publicKey,
            })
            .instruction(),
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

// ---- SEC-22 — Battle Royale fulfill ------------------------------
const brInflight  = new Set();
const brCompleted = new Set();

async function fulfillBr(royaleId) {
  const key = String(royaleId);
  if (brInflight.has(key) || brCompleted.has(key)) {
    dbg(`royale ${royaleId} already in-flight / done — skipping`);
    return;
  }
  brInflight.add(key);
  try {
    // Brief pause so on-chain state has time to commit join_battle_royale's
    // last write (status transitions to ROLLING on the 8th join).
    await new Promise((r) => setTimeout(r, cfg.fulfillDelayMs));

    const rPda = royaleSeed(royaleId);

    // Re-read to confirm it's actually ROLLING.  Race: another caller
    // (e.g. a player invoked fulfill via UI) may have already fulfilled.
    let r;
    try { r = await arena.account.battleRoyale.fetch(rPda); }
    catch (e) { log(`[fulfillBr #${royaleId}] not on chain (${e.message}) — skipping`); return; }
    if (r.status !== 1) {
      log(`[fulfillBr #${royaleId}] status=${r.status} (not ROLLING) — skipping`);
      brCompleted.add(key);
      return;
    }

    // BR has no slothash path — it was introduced post SEC-21 and
    // only the Switchboard ix exists.  If RANDOMNESS_SOURCE != switchboard,
    // we simply don't auto-fulfill; an admin can run force_resolve.
    if (cfg.randomnessSource !== "switchboard") {
      log(`[fulfillBr #${royaleId}] RANDOMNESS_SOURCE=${cfg.randomnessSource} — BR requires switchboard, skipping`);
      brCompleted.add(key);
      return;
    }

    const { queue } = switchboardEndpoints(
      cfg.rpcHttp.includes("mainnet") ? "mainnet" : "devnet",
    );
    log(`[fulfillBr #${royaleId}] starting Switchboard cycle (queue=${queue.toBase58().slice(0,8)}…)`);
    const { randomnessAccount, fulfillSig } = await runSwitchboardCycle({
      connection,
      payer:        wallet.payer,
      queuePubkey:  queue,
      buildFulfillIx: (randomnessAccountPk) =>
        arena.methods
          .fulfillRandomWordsBrSwitchboard()
          .accounts({
            config:            arenaConfig,
            royale:            rPda,
            randomnessAccount: randomnessAccountPk,
            caller:            wallet.publicKey,
          })
          .instruction(),
    });
    log(`[fulfillBr #${royaleId}] OK  randomness=${randomnessAccount.toBase58().slice(0,8)}…  tx=${fulfillSig.slice(0,16)}…`);
    brCompleted.add(key);
  } catch (e) {
    // WrongStatus = already DECIDED — benign race lost.
    if (/WrongStatus/.test(e.message) || /6002/.test(e.message)) {
      dbg(`[fulfillBr #${royaleId}] already decided — fine`);
      brCompleted.add(key);
    } else {
      log(`[fulfillBr #${royaleId}] FAILED:`, e.message);
    }
  } finally {
    brInflight.delete(key);
  }
}

// ---- SEC-23 — Tournament fulfill --------------------------------
// Compound key "tournamentId:matchIdx" because a single tournament has
// up to 8 matches and we want per-match inflight tracking.
const tournamentInflight  = new Set();
const tournamentCompleted = new Set();

async function fulfillTournamentMatch(tournamentId, matchIdx) {
  const key = `${tournamentId}:${matchIdx}`;
  if (tournamentInflight.has(key) || tournamentCompleted.has(key)) {
    dbg(`tournament ${tournamentId}/m${matchIdx} already in-flight / done — skipping`);
    return;
  }
  tournamentInflight.add(key);
  try {
    await new Promise((r) => setTimeout(r, cfg.fulfillDelayMs));

    const tPda = tournamentSeed(tournamentId);
    let t;
    try { t = await arena.account.tournament.fetch(tPda); }
    catch (e) { log(`[fulfillT #${tournamentId}/m${matchIdx}] not on chain (${e.message}) — skipping`); return; }
    if (t.status !== 1) {
      log(`[fulfillT #${tournamentId}/m${matchIdx}] tournament status=${t.status} (not ACTIVE) — skipping`);
      tournamentCompleted.add(key);
      return;
    }
    const m = t.matches[matchIdx];
    if (m.status !== 0) {
      log(`[fulfillT #${tournamentId}/m${matchIdx}] match status=${m.status} (not PENDING) — skipping`);
      tournamentCompleted.add(key);
      return;
    }
    if (m.round !== t.currentRound) {
      log(`[fulfillT #${tournamentId}/m${matchIdx}] not in current round (m.round=${m.round}, current=${t.currentRound}) — skipping`);
      tournamentCompleted.add(key);
      return;
    }
    if (cfg.randomnessSource !== "switchboard") {
      log(`[fulfillT #${tournamentId}/m${matchIdx}] RANDOMNESS_SOURCE=${cfg.randomnessSource} — tournaments require switchboard, skipping`);
      tournamentCompleted.add(key);
      return;
    }

    const { queue } = switchboardEndpoints(
      cfg.rpcHttp.includes("mainnet") ? "mainnet" : "devnet",
    );
    log(`[fulfillT #${tournamentId}/m${matchIdx}] starting Switchboard cycle (slots ${m.slotA}v${m.slotB})`);
    const { randomnessAccount, fulfillSig } = await runSwitchboardCycle({
      connection,
      payer:        wallet.payer,
      queuePubkey:  queue,
      buildFulfillIx: (randomnessAccountPk) =>
        arena.methods
          .advanceMatchSwitchboard(matchIdx)
          .accounts({
            config:            arenaConfig,
            tournament:        tPda,
            randomnessAccount: randomnessAccountPk,
            caller:            wallet.publicKey,
          })
          .instruction(),
    });
    log(`[fulfillT #${tournamentId}/m${matchIdx}] OK  randomness=${randomnessAccount.toBase58().slice(0,8)}…  tx=${fulfillSig.slice(0,16)}…`);
    tournamentCompleted.add(key);
  } catch (e) {
    if (/WrongStatus|TournamentMatchNotPending|WrongTournamentRound/.test(e.message)
        || /6002|6033|6034/.test(e.message)) {
      dbg(`[fulfillT #${tournamentId}/m${matchIdx}] already decided / out of round — fine`);
      tournamentCompleted.add(key);
    } else {
      log(`[fulfillT #${tournamentId}/m${matchIdx}] FAILED:`, e.message);
    }
  } finally {
    tournamentInflight.delete(key);
  }
}

// ---- event decoder ------------------------------------------------
const PROGRAM_DATA_PREFIX = "Program data: ";

/**
 * Walk a tx's log lines and return:
 *   { battleIds: u64[], royaleIds: u64[], tournamentMatches: [tid, midx][] }
 * for the events we care about.
 * Other events are silently ignored — we don't fail-open on the
 * presence of unknown event names, mirroring SEC-12's `startsWith`
 * discipline (`indexOf` would false-positive on `msg!()` logs).
 */
function extractFulfillCandidates(logs) {
  const battleIds = [];
  const royaleIds = [];
  const tournamentMatches = [];
  for (const line of logs || []) {
    if (typeof line !== "string") continue;
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length).trim();
    if (!b64) continue;
    try {
      const decoded = eventCoder.decode(b64);
      if (!decoded) continue;
      if (decoded.name === "BattleJoined") {
        battleIds.push(decoded.data.battle_id ?? decoded.data.battleId);
      } else if (decoded.name === "BattleRoyaleRolling") {
        // SEC-22 — BR transitions to ROLLING only on the LAST join
        // (when max_players is reached).  That's the signal to roll VRF.
        royaleIds.push(decoded.data.id);
      } else if (decoded.name === "TournamentMatchRolling") {
        // SEC-23 — start_tournament emits 4 of these (R0 quarters);
        // advance_match emits 2 more when R0→R1 completes, then 2 more
        // for R1→R2.  Each one is a separate Switchboard cycle.
        const tid = decoded.data.id;
        const midx = decoded.data.match_idx ?? decoded.data.matchIdx;
        tournamentMatches.push([tid, midx]);
      }
    } catch { /* not our event, ignore */ }
  }
  return { battleIds, royaleIds, tournamentMatches };
}

// ---- live subscription -------------------------------------------
let subId = null;
async function startLive() {
  if (subId !== null) return;
  subId = connection.onLogs(
    cfg.programId,
    (logsResult) => {
      if (logsResult.err) return;
      const { battleIds, royaleIds, tournamentMatches } =
        extractFulfillCandidates(logsResult.logs);
      for (const id of battleIds) {
        log(`[live] BattleJoined #${id} in sig=${logsResult.signature.slice(0,16)}…`);
        fulfill(id);
      }
      for (const id of royaleIds) {
        log(`[live] BattleRoyaleRolling #${id} in sig=${logsResult.signature.slice(0,16)}…`);
        fulfillBr(id);
      }
      for (const [tid, midx] of tournamentMatches) {
        log(`[live] TournamentMatchRolling #${tid}/m${midx} in sig=${logsResult.signature.slice(0,16)}…`);
        fulfillTournamentMatch(tid, midx);
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
      const { battleIds, royaleIds, tournamentMatches } =
        extractFulfillCandidates(tx.meta.logMessages);
      for (const id of battleIds) {
        log(`[poll] BattleJoined #${id} in sig=${s.signature.slice(0,16)}…`);
        fulfill(id);
      }
      for (const id of royaleIds) {
        log(`[poll] BattleRoyaleRolling #${id} in sig=${s.signature.slice(0,16)}…`);
        fulfillBr(id);
      }
      for (const [tid, midx] of tournamentMatches) {
        log(`[poll] TournamentMatchRolling #${tid}/m${midx} in sig=${s.signature.slice(0,16)}…`);
        fulfillTournamentMatch(tid, midx);
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
  log(`[boot] dispatch table:`);
  log(`[boot]   BattleJoined            → fulfill_random_words${cfg.randomnessSource === "switchboard" ? "_switchboard" : "(seed)"}`);
  log(`[boot]   BattleRoyaleRolling     → fulfill_random_words_br_switchboard${cfg.randomnessSource === "switchboard" ? "" : " (DISABLED — needs RANDOMNESS_SOURCE=switchboard)"}`);
  log(`[boot]   TournamentMatchRolling  → advance_match_switchboard${cfg.randomnessSource === "switchboard" ? "" : " (DISABLED — needs RANDOMNESS_SOURCE=switchboard)"}`);

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
