// ============================================================
// test/idempotency.test.js — regression for SEC-IDX-5
//
// Replays BattleSettledPaid 5× with the same (signature, log_index,
// event_name) tuple.  Expects player_stats.wins / losses / earned to
// match the single-execution result, not 5× it.
//
// Requires: indexer DB up (docker compose up -d postgres) and migrations
// applied (npm run db:migrate).
// ============================================================

import { strict as assert } from "node:assert";
import db from "../src/db/pool.js";
import {
  handleBattleCreated,
  handleBattleJoined,
  handleBattleDecided,
  handleBattleSettledPaid,
} from "../src/services/eventHandler.js";

const WINNER = "Test111111111111111111111111111111111111111W";
const LOSER  = "Test111111111111111111111111111111111111111L";
const CHIP   = "Test111111111111111111111111111111111111111C";
const PROG   = "Test111111111111111111111111111111111111111P";

const ID = 99_990_001;                       // unlikely to clash with real data
const SIG_BASE = "T".repeat(85) + "rs";      // 87 chars — leaves room for 1-char tag
const SIG_CREATE  = SIG_BASE + "C";
const SIG_JOIN    = SIG_BASE + "J";
const SIG_DECIDE  = SIG_BASE + "D";
const SIG_SETTLE  = SIG_BASE + "S";

async function reset() {
  await db.query(
    "DELETE FROM events       WHERE signature IN ($1,$2,$3,$4)",
    [SIG_CREATE, SIG_JOIN, SIG_DECIDE, SIG_SETTLE],
  );
  await db.query("DELETE FROM battles      WHERE id = $1",            [ID]);
  await db.query("DELETE FROM player_stats WHERE address IN ($1,$2)", [WINNER, LOSER]);
}

async function getStats(addr) {
  const { rows } = await db.query("SELECT * FROM player_stats WHERE address = $1", [addr]);
  return rows[0] ?? { wins: 0, losses: 0, total_earned: 0, total_paid: 0, total_battles: 0 };
}

async function main() {
  console.log("[test] cleaning prior fixture rows…");
  await reset();

  // Seed a battle so SettledPaid has winner/loser to look up.
  await handleBattleCreated(
    { battleId: ID, playerA: WINNER, chipA: CHIP, poolTier: 0 },
    { slot: 1, signature: SIG_CREATE, logIndex: 0, program: PROG },
  );
  await handleBattleJoined(
    { battleId: ID, playerB: LOSER, chipB: CHIP },
    { slot: 1, signature: SIG_JOIN, logIndex: 0, program: PROG },
  );
  await handleBattleDecided(
    { battleId: ID, winner: WINNER, loser: LOSER, randomSeed: 42 },
    { slot: 1, signature: SIG_DECIDE, logIndex: 0, program: PROG },
  );

  // First settle — should mutate stats.
  await handleBattleSettledPaid(
    { battleId: ID, loser: LOSER, payment: 100_000_000n, fee: 5_000_000n },
    { slot: 1, signature: SIG_SETTLE, logIndex: 0, program: PROG },
  );
  const after1 = await getStats(WINNER);
  console.log("[test] after 1st settle:", after1);

  // Replay 4 more times — must be ignored.
  for (let i = 0; i < 4; i++) {
    await handleBattleSettledPaid(
      { battleId: ID, loser: LOSER, payment: 100_000_000n, fee: 5_000_000n },
      { slot: 1, signature: SIG_SETTLE, logIndex: 0, program: PROG },
    );
  }
  const after5 = await getStats(WINNER);
  const loserStats = await getStats(LOSER);
  console.log("[test] after 5× replay (winner):", after5);
  console.log("[test] after 5× replay (loser):",  loserStats);

  assert.equal(after5.wins,          1,    "winner.wins must stay 1");
  assert.equal(after5.total_battles, 1,    "winner.total_battles must stay 1");
  assert.equal(after5.total_earned,  0.095, "winner.total_earned must stay 0.095 SOL");
  assert.equal(loserStats.losses,    1,    "loser.losses must stay 1");
  assert.equal(loserStats.total_paid, 0.1, "loser.total_paid must stay 0.1 SOL");

  await reset();
  console.log("\nOK — idempotent under 5× replay");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
