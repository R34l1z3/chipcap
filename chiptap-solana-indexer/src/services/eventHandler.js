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

  // SEC-21 — default to 'slothash' (Option A trusted relayer).  If a
  // SwitchboardVerified event arrives in the same tx (same logIndex+1),
  // the handler below will overwrite to 'switchboard' + set the
  // randomness_account.  COALESCE prevents an Option-B battle from
  // being downgraded if BattleDecided gets replayed.
  await db.query(
    `UPDATE battles
       SET status = 2, winner = $1, loser = $2, random_seed = $3,
           decided_at = NOW(), decide_tx = $4,
           vrf_method = COALESCE(vrf_method, 'slothash')
     WHERE id = $5`,
    [winner, loser, seed, ctx.signature, id],
  );

  broadcastToPlayers("battle:decided", { id, winner, loser, status: 2 }, [winner, loser]);
}

// SEC-21 / SEC-22 — emitted alongside BattleDecided (1v1) AND
// BattleRoyaleDecided (BR) when fulfilment goes through the
// `*_switchboard` ix.  Upgrades the row's vrf_method and records the
// randomness account for audit.
//
// The program reuses ONE event (`SwitchboardVerified { battle_id }`)
// for both modes — but `battle_id` is drawn from the shared
// `arena.next_battle_id` counter, so any given id lives in exactly
// one table.  We UPDATE both; the wrong one is a no-op.
export async function handleSwitchboardVerified(data, ctx) {
  const id                = asNum(data.battleId ?? data.battle_id);
  const randomnessAccount = asPubkey(data.randomnessAccount ?? data.randomness_account);

  if (!await claimEvent("SwitchboardVerified", ctx, { id, randomnessAccount })) return;

  await Promise.all([
    db.query(
      `UPDATE battles
         SET vrf_method = 'switchboard', randomness_account = $1
       WHERE id = $2`,
      [randomnessAccount, id],
    ),
    db.query(
      `UPDATE battle_royales
         SET vrf_method = 'switchboard', randomness_account = $1
       WHERE id = $2`,
      [randomnessAccount, id],
    ),
  ]);

  broadcastToPlayers(
    "battle:vrf_verified",
    { id, randomnessAccount, method: "switchboard" },
    [],
  );
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

// ============================================================
//  SEC-22 — BATTLE ROYALE
// ============================================================
// 8-player single-VRF mode.  See `battle-arena/src/lib.rs` Battle
// Royale section for state machine.  We mirror that on the DB:
//
//   0 WAITING  → created, lobby filling
//   1 ROLLING  → full, VRF in flight
//   2 DECIDED  → seed in, winner known, chips still locked
//   3 SETTLED  → winner claimed prize (chips might still be unclaimed
//                 — front-end can read `players` + chips_claimed_mask
//                 from chain if it cares)
//   4 CANCELLED → join timeout OR vrf timeout
//
// `players` jsonb holds the seating array; we keep it sorted by slot
// so winner_idx matches array index.

export async function handleBattleRoyaleCreated(data, ctx) {
  const id          = asNum(data.id);
  const creator     = asPubkey(data.creator);
  const tier        = asNum(data.poolTier   ?? data.pool_tier);
  const maxPlayers  = asNum(data.maxPlayers ?? data.max_players);

  if (!await claimEvent("BattleRoyaleCreated", ctx, { id, creator, tier, maxPlayers })) return;

  await db.query(
    `INSERT INTO battle_royales (id, creator, pool_tier, max_players, status,
                                 created_at, create_tx)
     VALUES ($1,$2,$3,$4,0,NOW(),$5)
     ON CONFLICT (id) DO UPDATE SET
       creator = $2, pool_tier = $3, max_players = $4,
       status = 0, create_tx = $5`,
    [id, creator, tier, maxPlayers, ctx.signature],
  );

  await upsertPlayer(creator);
  broadcast("br:created", { id, creator, poolTier: tier, maxPlayers });
}

export async function handleBattleRoyaleJoined(data, ctx) {
  const id        = asNum(data.id);
  const player    = asPubkey(data.player);
  const chip      = asPubkey(data.chip);
  const slot      = asNum(data.slot);
  const numJoined = asNum(data.numJoined ?? data.num_joined);

  if (!await claimEvent("BattleRoyaleJoined", ctx, { id, player, chip, slot, numJoined })) return;

  // Append the seat to `players` jsonb, idempotent on (id, slot).
  // We rebuild the array sorted by slot so winner_idx always maps to
  // array index.  jsonb_path_query_array would be cleaner but is 16+
  // — keep it portable with a CTE.
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT players FROM battle_royales WHERE id = $1 FOR UPDATE", [id],
    );
    const existing = Array.isArray(rows[0]?.players) ? rows[0].players : [];
    // De-dup by slot — replay safety beyond the claimEvent gate.
    const filtered = existing.filter((p) => p.slot !== slot);
    filtered.push({ slot, player, chip });
    filtered.sort((a, b) => a.slot - b.slot);
    await client.query(
      `UPDATE battle_royales SET players = $1::jsonb, num_joined = $2
       WHERE id = $3`,
      [JSON.stringify(filtered), numJoined, id],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  await upsertPlayer(player);

  // Notify the joiner immediately; lobby-wide subscribers get the
  // generic broadcast for the live BR list.
  broadcast("br:joined", { id, player, slot, numJoined });
}

// Emitted on the LAST join (when num_joined == max_players).  Mainly
// useful for UI to flip the lobby into "rolling…" mode and for the
// relayer to know it's time to fulfill VRF.
export async function handleBattleRoyaleRolling(data, ctx) {
  const id         = asNum(data.id);
  const poolAmount = lamportsToSol(data.poolAmount ?? data.pool_amount);
  const poolLamports = (data.poolAmount ?? data.pool_amount)?.toString?.() ?? "0";

  if (!await claimEvent("BattleRoyaleRolling", ctx, { id, poolAmount })) return;

  await db.query(
    `UPDATE battle_royales
       SET status = 1, pool_lamports = $1, rolling_at = NOW(), rolling_tx = $2
     WHERE id = $3`,
    [poolLamports, ctx.signature, id],
  );

  broadcast("br:rolling", { id, poolAmount });
}

// Switchboard fulfill landed.  `vrf_method` defaults to 'slothash' to
// stay consistent with 1v1 (even though BR currently has no slothash
// path — future-proofing).  COALESCE prevents downgrade from a
// SwitchboardVerified event that may arrive in the same tx.
export async function handleBattleRoyaleDecided(data, ctx) {
  const id         = asNum(data.id);
  const winner     = asPubkey(data.winner);
  const winnerIdx  = asNum(data.winnerIdx  ?? data.winner_idx);
  const seed       = (data.randomSeed ?? data.random_seed)?.toString?.() ?? null;
  const poolAmount = lamportsToSol(data.poolAmount ?? data.pool_amount);
  const feeAmount  = lamportsToSol(data.feeAmount  ?? data.fee_amount);

  if (!await claimEvent("BattleRoyaleDecided", ctx, { id, winner, winnerIdx, seed })) return;

  await db.query(
    `UPDATE battle_royales
       SET status = 2, winner = $1, winner_idx = $2, random_seed = $3,
           payment_amount = $4, fee_amount = $5,
           decided_at = NOW(), decide_tx = $6,
           vrf_method = COALESCE(vrf_method, 'slothash')
     WHERE id = $7`,
    [winner, winnerIdx, seed, poolAmount, feeAmount, ctx.signature, id],
  );

  // Broadcast to all participants (not just the winner) so every
  // player's UI flips from "rolling" to the result screen at once.
  const { rows } = await db.query("SELECT players FROM battle_royales WHERE id = $1", [id]);
  const participants = (rows[0]?.players ?? []).map((p) => p.player).filter(Boolean);
  broadcastToPlayers("br:decided", { id, winner, winnerIdx, status: 2 }, participants);
}

// Winner pulled their prize → BR is SETTLED.  This is when we credit
// player_stats: winner gets win + earned, everyone else gets a loss +
// `pool_tier` SOL paid.  Chips are NOT lost in BR (membership only).
export async function handleBattleRoyaleSettledPaid(data, ctx) {
  const id      = asNum(data.id);
  const winner  = asPubkey(data.winner);
  const payout  = lamportsToSol(data.payout);
  const fee     = lamportsToSol(data.fee);

  if (!await claimEvent("BattleRoyaleSettledPaid", ctx, { id, winner, payout, fee })) return;

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE battle_royales
         SET status = 3, settled_at = NOW(), settle_tx = $1,
             payment_amount = $2, fee_amount = $3
       WHERE id = $4`,
      [ctx.signature, payout, fee, id],
    );

    // Pull players + pool_tier so we can credit losers.  Read inside
    // the same tx to avoid a race with a hypothetical reset.
    const { rows } = await client.query(
      "SELECT players, pool_tier, pool_lamports FROM battle_royales WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (row) {
      const players = Array.isArray(row.players) ? row.players : [];
      const stakeSol = POOL_LAMPORTS[row.pool_tier]
        ? POOL_LAMPORTS[row.pool_tier] / 1e9
        : 0;

      // Winner stats — they earned (payout - fee) net.
      await client.query(
        `UPDATE player_stats SET
           total_battles = total_battles + 1, wins = wins + 1,
           total_earned = total_earned + $1, updated_at = NOW()
         WHERE address = $2`,
        [payout - fee, winner],
      );

      // Losers — everyone except the winner forfeits their stake.
      for (const p of players) {
        if (!p.player || p.player === winner) continue;
        await client.query(
          `UPDATE player_stats SET
             total_battles = total_battles + 1, losses = losses + 1,
             total_paid = total_paid + $1, updated_at = NOW()
           WHERE address = $2`,
          [stakeSol, p.player],
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  broadcast("br:settled", { id, winner, payout, fee });
}

// Cancellation — either the join window expired (reason=0) or VRF
// timed out (reason=1).  In both cases every player gets their stake
// back via the on-chain `cancel_br` helper, so we don't touch
// player_stats here.  Chips are returned by separate claim_chip_br
// calls which don't emit events.
export async function handleBattleRoyaleCancelled(data, ctx) {
  const id     = asNum(data.id);
  const reason = asNum(data.reason);

  if (!await claimEvent("BattleRoyaleCancelled", ctx, { id, reason })) return;

  await db.query(
    `UPDATE battle_royales
       SET status = 4, cancel_reason = $1, settled_at = NOW(), cancel_tx = $2
     WHERE id = $3`,
    [reason, ctx.signature, id],
  );

  const { rows } = await db.query("SELECT players FROM battle_royales WHERE id = $1", [id]);
  const participants = (rows[0]?.players ?? []).map((p) => p.player).filter(Boolean);
  broadcastToPlayers("br:cancelled", { id, reason }, participants);
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
  ChipMinted:               handleChipMinted,
  BattleCreated:            handleBattleCreated,
  BattleJoined:             handleBattleJoined,
  BattleDecided:            handleBattleDecided,
  BattleSettledPaid:        handleBattleSettledPaid,
  BattleSettledForfeited:   handleBattleSettledForfeited,
  BattleCancelled:          handleBattleCancelled,
  BattleExpired:            handleBattleExpired,
  VrfTimedOut:              handleVrfTimedOut,
  Deposited:                handleDeposited,
  Withdrawn:                handleWithdrawnUser,
  SwitchboardVerified:      handleSwitchboardVerified,
  // SEC-22 — Battle Royale
  BattleRoyaleCreated:      handleBattleRoyaleCreated,
  BattleRoyaleJoined:       handleBattleRoyaleJoined,
  BattleRoyaleRolling:      handleBattleRoyaleRolling,
  BattleRoyaleDecided:      handleBattleRoyaleDecided,
  BattleRoyaleSettledPaid:  handleBattleRoyaleSettledPaid,
  BattleRoyaleCancelled:    handleBattleRoyaleCancelled,
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
