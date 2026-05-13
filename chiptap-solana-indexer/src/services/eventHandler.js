// ============================================================
// src/services/eventHandler.js — process decoded Anchor events
// ============================================================
//
// One handler per event name we care about.  Mirrors the EVM
// indexer but with VARCHAR(44) addresses, lamport→SOL conversion,
// and Solana-shaped txns (signature instead of tx hash).

import db from "../db/pool.js";
import { broadcast, broadcastToPlayers } from "./wsBroadcast.js";
import { asNum, asPubkey, lamportsToSol } from "../utils/format.js";

// ============================================================
//  Pool tier → SOL  (mirrors `ArenaConfig.pool_amounts` defaults)
// ============================================================
const POOL_LAMPORTS = [
  50_000_000,
  100_000_000,
  250_000_000,
  500_000_000,
  1_000_000_000,
  5_000_000_000,
];

// ------------------------------------------------------------
// Atomic event-claim: insert into `events` and return whether the row
// is new.  Backfill and the live onLogs subscription redeliver the
// same signature routinely (Solana RPC has no exactly-once contract),
// so every handler that mutates state must short-circuit when the
// event has already been processed — otherwise player_stats wins /
// losses / earned would double on every indexer restart.
async function claimEvent(name, ctx, args) {
  const { rows } = await db.query(
    `INSERT INTO events (event_name, slot, signature, log_index, program, args)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (signature, log_index, event_name) DO NOTHING
     RETURNING id`,
    [name, ctx.slot, ctx.signature, ctx.logIndex ?? 0, ctx.program, JSON.stringify(args ?? {})],
  );
  return rows.length > 0;
}

async function upsertPlayer(address) {
  if (!address) return;
  await db.query(
    `INSERT INTO player_stats (address) VALUES ($1)
     ON CONFLICT (address) DO NOTHING`,
    [address],
  );
}

// ============================================================
//  CHIP-NFT
// ============================================================

export async function handleChipMinted(data, ctx) {
  const asset    = asPubkey(data.asset);
  const owner    = asPubkey(data.owner);
  const tokenId  = asNum(data.tokenId ?? data.token_id);
  const rarity   = asNum(data.rarity);
  const price    = lamportsToSol(data.price);

  if (!await claimEvent("ChipMinted", ctx, { asset, owner, tokenId, rarity, price })) return;

  await db.query(
    `INSERT INTO chips (asset, token_id, owner, rarity, minted_at, mint_tx)
     VALUES ($1,$2,$3,$4,NOW(),$5)
     ON CONFLICT (asset) DO UPDATE
       SET owner = $3, rarity = $4`,
    [asset, tokenId, owner, rarity, ctx.signature],
  );

  await upsertPlayer(owner);
  broadcast("chip:minted", { asset, tokenId, owner, rarity });
}

// ============================================================
//  BATTLE-ARENA
// ============================================================

export async function handleBattleCreated(data, ctx) {
  const id        = asNum(data.battleId  ?? data.battle_id);
  const playerA   = asPubkey(data.playerA ?? data.player_a);
  const chipA     = asPubkey(data.chipA   ?? data.chip_a);
  const tier      = asNum(data.poolTier  ?? data.pool_tier);
  const lamports  = POOL_LAMPORTS[tier] ?? 0;

  if (!await claimEvent("BattleCreated", ctx, { id, playerA, chipA, tier })) return;

  await db.query(
    `INSERT INTO battles (id, player_a, chip_a, pool_tier, pool_lamports, status, created_at, create_tx)
     VALUES ($1,$2,$3,$4,$5,0,NOW(),$6)
     ON CONFLICT (id) DO UPDATE SET
       player_a = $2, chip_a = $3, pool_tier = $4, pool_lamports = $5,
       status = 0, create_tx = $6`,
    [id, playerA, chipA, tier, lamports, ctx.signature],
  );

  await upsertPlayer(playerA);
  broadcast("battle:created", { id, playerA, chipA, poolTier: tier, poolLamports: lamports });
}

export async function handleBattleJoined(data, ctx) {
  const id      = asNum(data.battleId ?? data.battle_id);
  const playerB = asPubkey(data.playerB ?? data.player_b);
  const chipB   = asPubkey(data.chipB   ?? data.chip_b);

  if (!await claimEvent("BattleJoined", ctx, { id, playerB, chipB })) return;

  await db.query(
    `UPDATE battles
       SET player_b = $1, chip_b = $2, status = 1, join_tx = $3
     WHERE id = $4`,
    [playerB, chipB, ctx.signature, id],
  );

  await upsertPlayer(playerB);

  const { rows } = await db.query("SELECT player_a FROM battles WHERE id = $1", [id]);
  const playerA = rows[0]?.player_a;
  broadcastToPlayers(
    "battle:joined",
    { id, playerB, chipB, status: 1 },
    [playerA, playerB].filter(Boolean),
  );
}

export async function handleBattleDecided(data, ctx) {
  const id     = asNum(data.battleId ?? data.battle_id);
  const winner = asPubkey(data.winner);
  const loser  = asPubkey(data.loser);
  const seed   = (data.randomSeed ?? data.random_seed)?.toString?.() ?? null;

  if (!await claimEvent("BattleDecided", ctx, { id, winner, loser })) return;

  await db.query(
    `UPDATE battles
       SET status = 2, winner = $1, loser = $2, random_seed = $3,
           decided_at = NOW(), decide_tx = $4
     WHERE id = $5`,
    [winner, loser, seed, ctx.signature, id],
  );

  broadcastToPlayers("battle:decided", { id, winner, loser, status: 2 }, [winner, loser]);
}

export async function handleBattleSettledPaid(data, ctx) {
  const id      = asNum(data.battleId ?? data.battle_id);
  const loser   = asPubkey(data.loser);
  const payment = lamportsToSol(data.payment);
  const fee     = lamportsToSol(data.fee);

  if (!await claimEvent("BattleSettledPaid", ctx, { id, loser, payment, fee })) return;

  // Atomic: settle the battle and increment player stats together so a
  // mid-handler crash can't leave stats out of sync with the battle row.
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE battles SET status = 3, resolution = 1, payment_amount = $1, fee_amount = $2,
         settled_at = NOW(), settle_tx = $3
       WHERE id = $4`,
      [payment, fee, ctx.signature, id],
    );
    const { rows } = await client.query(
      "SELECT winner, loser, player_a, player_b, chip_a, chip_b FROM battles WHERE id = $1",
      [id],
    );
    if (rows[0]) {
      const b = rows[0];
      await client.query(
        `UPDATE player_stats SET
           total_battles = total_battles + 1, wins = wins + 1,
           total_earned = total_earned + $1, updated_at = NOW()
         WHERE address = $2`,
        [payment - fee, b.winner],
      );
      await client.query(
        `UPDATE player_stats SET
           total_battles = total_battles + 1, losses = losses + 1,
           total_paid = total_paid + $1, updated_at = NOW()
         WHERE address = $2`,
        [payment, b.loser],
      );
      // SEC-9 — on-chain `chip.battle_count` / `win_count` are gone;
      // the indexer is now the only source of per-chip W/L stats.
      await bumpChipStats(client, b.chip_a, b.winner === b.player_a);
      await bumpChipStats(client, b.chip_b, b.winner === b.player_b);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  broadcast("battle:settled", { id, resolution: "paid", payment, fee });
}

// Per-chip W/L counter — replaces what on-chain `record_battle` used to
// do.  Called from both settle paths; gated by `claimEvent` at the top
// of each handler so it's safe under replay.
async function bumpChipStats(client, asset, won) {
  if (!asset) return;
  await client.query(
    `UPDATE chips SET
       battle_count = battle_count + 1,
       win_count    = win_count + $1
     WHERE asset = $2`,
    [won ? 1 : 0, asset],
  );
}

export async function handleBattleSettledForfeited(data, ctx) {
  const id              = asNum(data.battleId ?? data.battle_id);
  const loser           = asPubkey(data.loser);
  const chipForfeited   = asPubkey(data.chipForfeited ?? data.chip_forfeited);

  if (!await claimEvent("BattleSettledForfeited", ctx, { id, loser, chipForfeited })) return;

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE battles SET status = 3, resolution = 2, settled_at = NOW(), settle_tx = $1
       WHERE id = $2`,
      [ctx.signature, id],
    );
    const { rows } = await client.query(
      "SELECT winner, loser, player_a, player_b, chip_a, chip_b FROM battles WHERE id = $1",
      [id],
    );
    if (rows[0]) {
      const b = rows[0];
      await client.query(
        `UPDATE player_stats SET total_battles = total_battles + 1, wins = wins + 1,
           chips_won = chips_won + 1, updated_at = NOW() WHERE address = $1`,
        [b.winner],
      );
      await client.query(
        `UPDATE player_stats SET total_battles = total_battles + 1, losses = losses + 1,
           chips_lost = chips_lost + 1, updated_at = NOW() WHERE address = $1`,
        [b.loser],
      );
      await bumpChipStats(client, b.chip_a, b.winner === b.player_a);
      await bumpChipStats(client, b.chip_b, b.winner === b.player_b);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  broadcast("battle:settled", { id, resolution: "forfeited", chipForfeited });
}

export async function handleBattleCancelled(data, ctx) {
  const id = asNum(data.battleId ?? data.battle_id);
  if (!await claimEvent("BattleCancelled", ctx, { id })) return;
  await db.query(
    "UPDATE battles SET status = 4, settled_at = NOW() WHERE id = $1", [id],
  );
  broadcast("battle:cancelled", { id });
}

export async function handleBattleExpired(data, ctx) {
  const id    = asNum(data.battleId ?? data.battle_id);
  const loser = asPubkey(data.loser);
  if (!await claimEvent("BattleExpired", ctx, { id, loser })) return;
  await db.query(
    `UPDATE battles SET status = 3, resolution = 3, settled_at = NOW(), settle_tx = $1
     WHERE id = $2`,
    [ctx.signature, id],
  );
  broadcast("battle:settled", { id, resolution: "expired" });
}

export async function handleVrfTimedOut(data, ctx) {
  const id = asNum(data.battleId ?? data.battle_id);
  if (!await claimEvent("VrfTimedOut", ctx, { id })) return;
  const { rows } = await db.query(
    "SELECT player_a, player_b FROM battles WHERE id = $1", [id],
  );
  broadcastToPlayers(
    "battle:vrf_timeout",
    { id, message: "VRF failed — chips refunded" },
    [rows[0]?.player_a, rows[0]?.player_b].filter(Boolean),
  );
}

export async function handleDeposited(data, ctx) {
  const user    = asPubkey(data.user);
  const amount  = lamportsToSol(data.amount);
  const balance = lamportsToSol(data.balance);
  if (!await claimEvent("Deposited", ctx, { user, amount, balance })) return;
  await upsertPlayer(user);
  broadcastToPlayers("player:deposit", { user, amount, balance }, [user]);
}

export async function handleWithdrawnUser(data, ctx) {
  const user    = asPubkey(data.user);
  const amount  = lamportsToSol(data.amount);
  const balance = lamportsToSol(data.balance);
  // `total_withdrawn` is an accumulator — gating on claimEvent is required.
  if (!await claimEvent("Withdrawn", ctx, { user, amount, balance })) return;
  await upsertPlayer(user);
  await db.query(
    `UPDATE player_stats SET total_withdrawn = COALESCE(total_withdrawn,0) + $1,
       updated_at = NOW() WHERE address = $2`,
    [amount, user],
  );
  broadcastToPlayers("player:withdrew", { user, amount }, [user]);
}

// ============================================================
//  Dispatcher — called by eventListener for every decoded event
// ============================================================

const DISPATCH = {
  ChipMinted:             handleChipMinted,
  BattleCreated:          handleBattleCreated,
  BattleJoined:           handleBattleJoined,
  BattleDecided:          handleBattleDecided,
  BattleSettledPaid:      handleBattleSettledPaid,
  BattleSettledForfeited: handleBattleSettledForfeited,
  BattleCancelled:        handleBattleCancelled,
  BattleExpired:          handleBattleExpired,
  VrfTimedOut:            handleVrfTimedOut,
  Deposited:              handleDeposited,
  Withdrawn:              handleWithdrawnUser,
};

export async function dispatchEvent(event, data, ctx) {
  const fn = DISPATCH[event];
  if (!fn) return;
  try {
    await fn(data, ctx);
  } catch (err) {
    console.error(`[IDX] handler ${event} failed:`, err.message);
  }
}
