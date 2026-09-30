// ============================================================
// test/chip-owner.test.js — regression for SEC-29
//
// 1. A forfeited chip moves to the winner in `chips.owner` — and stays
//    moved under replay (handlers are claimEvent-gated).
// 2. The on-chain reconcile corrects what events can't see:
//      • a chip transferred wallet-to-wallet outside the game
//      • a chip whose ChipMinted was indexed after its market fill
//    and leaves escrowed chips (arena / market authority) with their
//    event-derived owner, only fixing `listed`.
//
// Requires: indexer DB up (docker compose up -d postgres) and migrations
// applied (npm run db:migrate).  No RPC — the connection is stubbed.
// ============================================================

import { strict as assert } from "node:assert";
import { Keypair, PublicKey } from "@solana/web3.js";
import config from "../src/config/index.js";
import db from "../src/db/pool.js";
import {
  handleBattleCreated,
  handleBattleJoined,
  handleBattleDecided,
  handleBattleSettledForfeited,
} from "../src/services/eventHandler.js";
import { reconcileChipOwners } from "../src/services/chipOwnerReconcile.js";

const key = () => Keypair.generate().publicKey.toBase58();
const WINNER = key(), LOSER = key(), OUTSIDER = key(), SELLER = key(), BUYER = key();
const CHIP_A = key(), CHIP_B = key(), CHIP_SOLD = key(), CHIP_LISTED = key();
const PROG = key();
const ID = 99_990_029;
const SIG = (tag) => "T".repeat(85) + "o" + tag;   // 87 chars

const enc = (s) => new TextEncoder().encode(s);
const pdaOf = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, new PublicKey(pid))[0];
const CHIP_AUTHORITY = pdaOf([enc("arena"), enc("chip_authority")], config.programs.battleArena);
const MARKET_AUTHORITY = config.programs.marketplace
  ? pdaOf([enc("market"), enc("authority")], config.programs.marketplace)
  : null;

const ALL_CHIPS = [CHIP_A, CHIP_B, CHIP_SOLD, CHIP_LISTED];

async function reset() {
  await db.query("DELETE FROM events WHERE signature LIKE $1", ["T".repeat(85) + "o%"]);
  await db.query("DELETE FROM battles WHERE id = $1", [ID]);
  await db.query("DELETE FROM chips WHERE asset = ANY($1)", [ALL_CHIPS]);
  await db.query("DELETE FROM player_stats WHERE address = ANY($1)", [[WINNER, LOSER]]);
}
const ownerOf = async (asset) =>
  (await db.query("SELECT owner, listed FROM chips WHERE asset = $1", [asset])).rows[0];
const insertChip = (asset, owner, tokenId, listed = false) => db.query(
  `INSERT INTO chips (asset, token_id, owner, listed) VALUES ($1,$2,$3,$4)`,
  [asset, tokenId, owner, listed],
);

// mpl-core AssetV1 layout the reconcile reads: [key=1][owner 32 bytes]…
const assetAccount = (holder) => {
  const data = Buffer.alloc(40);
  data[0] = 1;
  new PublicKey(holder).toBuffer().copy(data, 1);
  return { data };
};

async function main() {
  await reset();

  // ---- 1. forfeit moves the chip -------------------------------------
  await insertChip(CHIP_A, WINNER, 990_001);
  await insertChip(CHIP_B, LOSER,  990_002);
  const ctx = (tag) => ({ slot: 1, signature: SIG(tag), logIndex: 0, program: PROG });
  await handleBattleCreated({ battleId: ID, playerA: WINNER, chipA: CHIP_A, poolTier: 0 }, ctx("C"));
  await handleBattleJoined({ battleId: ID, playerB: LOSER, chipB: CHIP_B }, ctx("J"));
  await handleBattleDecided({ battleId: ID, winner: WINNER, loser: LOSER, randomSeed: 42 }, ctx("D"));

  for (let i = 0; i < 3; i++) {   // first call applies, replays must not
    await handleBattleSettledForfeited(
      { battleId: ID, loser: LOSER, chipForfeited: CHIP_B }, ctx("F"),
    );
  }
  assert.equal((await ownerOf(CHIP_B)).owner, WINNER, "forfeited chip must belong to the winner");
  assert.equal((await ownerOf(CHIP_A)).owner, WINNER, "winner's own chip unchanged");
  const w = (await db.query("SELECT chips_won FROM player_stats WHERE address = $1", [WINNER])).rows[0];
  assert.equal(w.chips_won, 1, "chips_won must stay 1 under replay");
  console.log("[test] ✓ forfeit moves chip to winner, idempotent under replay");

  // ---- 2. reconcile against the chain --------------------------------
  // CHIP_A: sent wallet-to-wallet to OUTSIDER — no event ever saw it.
  // CHIP_B: back in arena escrow (e.g. the winner staked it again) —
  //         must keep its event-derived owner.
  // CHIP_SOLD: late-indexed mint left the SELLER as owner; chain says BUYER.
  // CHIP_LISTED: sitting in the market escrow but row says listed=false.
  await insertChip(CHIP_SOLD, SELLER, 990_003);
  await insertChip(CHIP_LISTED, SELLER, 990_004, false);

  const chain = new Map([
    [CHIP_A, assetAccount(OUTSIDER)],
    [CHIP_B, assetAccount(CHIP_AUTHORITY)],
    [CHIP_SOLD, assetAccount(BUYER)],
    [CHIP_LISTED, assetAccount(MARKET_AUTHORITY ?? SELLER)],
  ]);
  const stub = {
    // Other rows may exist in a dev DB; report them as missing so the
    // test only touches its own fixtures.
    getMultipleAccountsInfo: async (keys) => keys.map((k) => chain.get(k.toBase58()) ?? null),
  };
  const run = await reconcileChipOwners(stub);
  assert.ok(run.ok, `reconcile failed: ${run.error}`);

  assert.equal((await ownerOf(CHIP_A)).owner, OUTSIDER, "external transfer must be picked up");
  assert.equal((await ownerOf(CHIP_B)).owner, WINNER, "escrowed chip keeps its beneficial owner");
  assert.equal((await ownerOf(CHIP_SOLD)).owner, BUYER, "order-inverted fill must be corrected");
  if (MARKET_AUTHORITY) {
    const l = await ownerOf(CHIP_LISTED);
    assert.equal(l.owner, SELLER, "listed chip keeps the seller as owner");
    assert.equal(l.listed, true, "chip in market escrow must be flagged listed");
  }
  console.log(`[test] ✓ reconcile: ${run.ownerFixed} owner / ${run.listedFixed} listed fixed`);

  // A second pass changes nothing.
  const again = await reconcileChipOwners(stub);
  assert.equal(again.ownerFixed + again.listedFixed, 0, "reconcile must be idempotent");
  console.log("[test] ✓ reconcile idempotent");

  await reset();
  console.log("\nOK — chip ownership follows forfeits and the chain");
  process.exit(0);
}

main().catch(async (e) => { console.error(e); await reset().catch(() => {}); process.exit(1); });
