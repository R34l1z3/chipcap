// ============================================================
// src/services/eventHandler.js — Process blockchain events
// ============================================================

import db from "../db/pool.js";
import { POOL_USD } from "../utils/abis.js";
import { broadcast, broadcastToPlayers } from "./wsBroadcast.js";
import { ethers } from "ethers";

/**
 * Store raw event in events table.
 */
async function logEvent(eventName, blockNumber, txHash, logIndex, contract, args) {
  await db.query(
    `INSERT INTO events (event_name, block_number, tx_hash, log_index, contract, args)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [eventName, blockNumber, txHash, logIndex, contract, JSON.stringify(args)]
  );
}

/**
 * Upsert player stats.
 */
async function upsertPlayer(address) {
  await db.query(
    `INSERT INTO player_stats (address) VALUES ($1)
     ON CONFLICT (address) DO NOTHING`,
    [address.toLowerCase()]
  );
}

// ============================================================
// CHIP EVENTS
// ============================================================

export async function handleChipMinted(log) {
  const { to, tokenId, rarity, price } = log.args;
  const id = Number(tokenId);

  await db.query(
    `INSERT INTO chips (token_id, owner, rarity, minted_at, mint_tx)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (token_id) DO UPDATE SET owner = $2, rarity = $3`,
    [id, to.toLowerCase(), Number(rarity), log.transactionHash]
  );

  await upsertPlayer(to);
  await logEvent("ChipMinted", log.blockNumber, log.transactionHash, (log.index ?? log.logIndex), log.address, {
    to, tokenId: id, rarity: Number(rarity), price: price.toString(),
  });

  broadcast("chip:minted", { tokenId: id, to: to.toLowerCase(), rarity: Number(rarity) });
}

export async function handleTransfer(log) {
  const { from, to, tokenId } = log.args;
  const id = Number(tokenId);
  const ZERO = "0x0000000000000000000000000000000000000000";

  // Skip mint transfers (handled by ChipMinted)
  if (from === ZERO) return;

  await db.query(
    `UPDATE chips SET owner = $1 WHERE token_id = $2`,
    [to.toLowerCase(), id]
  );
}

// ============================================================
// BATTLE EVENTS
// ============================================================

export async function handleBattleCreated(log) {
  const { battleId, playerA, chipA, poolTier } = log.args;
  const id = Number(battleId);
  const tier = Number(poolTier);

  await db.query(
    `INSERT INTO battles (id, player_a, chip_a, pool_tier, pool_usd, status, created_at, create_tx)
     VALUES ($1, $2, $3, $4, $5, 0, NOW(), $6)
     ON CONFLICT (id) DO UPDATE SET
       player_a = $2, chip_a = $3, pool_tier = $4, pool_usd = $5, status = 0, create_tx = $6`,
    [id, playerA.toLowerCase(), Number(chipA), tier, POOL_USD[tier] || 0, log.transactionHash]
  );

  await upsertPlayer(playerA);
  await logEvent("BattleCreated", log.blockNumber, log.transactionHash, (log.index ?? log.logIndex), log.address, {
    battleId: id, playerA: playerA.toLowerCase(), chipA: Number(chipA), poolTier: tier,
  });

  broadcast("battle:created", {
    id, playerA: playerA.toLowerCase(), chipA: Number(chipA), poolTier: tier,
    poolUsd: POOL_USD[tier] || 0,
  });
}

export async function handleBattleJoined(log) {
  const { battleId, playerB, chipB, vrfRequestId } = log.args;
  const id = Number(battleId);

  await db.query(
    `UPDATE battles SET
       player_b = $1, chip_b = $2, status = 1, join_tx = $3
     WHERE id = $4`,
    [playerB.toLowerCase(), Number(chipB), log.transactionHash, id]
  );

  await upsertPlayer(playerB);
  await logEvent("BattleJoined", log.blockNumber, log.transactionHash, (log.index ?? log.logIndex), log.address, {
    battleId: id, playerB: playerB.toLowerCase(), chipB: Number(chipB),
  });

  // Get playerA for targeted broadcast
  const { rows } = await db.query("SELECT player_a FROM battles WHERE id = $1", [id]);
  const playerA = rows[0]?.player_a;

  broadcastToPlayers("battle:joined", {
    id, playerB: playerB.toLowerCase(), chipB: Number(chipB), status: 1,
  }, [playerA, playerB.toLowerCase()]);
}

export async function handleBattleDecided(log) {
  const { battleId, winner, loser, randomSeed } = log.args;
  const id = Number(battleId);

  await db.query(
    `UPDATE battles SET
       status = 2, winner = $1, loser = $2, random_seed = $3,
       decided_at = NOW(), decide_tx = $4
     WHERE id = $5`,
    [winner.toLowerCase(), loser.toLowerCase(), randomSeed.toString(), log.transactionHash, id]
  );

  await logEvent("BattleDecided", log.blockNumber, log.transactionHash, (log.index ?? log.logIndex), log.address, {
    battleId: id, winner: winner.toLowerCase(), loser: loser.toLowerCase(),
  });

  broadcastToPlayers("battle:decided", {
    id, winner: winner.toLowerCase(), loser: loser.toLowerCase(), status: 2,
  }, [winner.toLowerCase(), loser.toLowerCase()]);
}

export async function handleBattleSettledPaid(log) {
  const { battleId, loser, payment, fee } = log.args;
  const id = Number(battleId);
  const paymentEth = ethers.formatEther(payment);
  const feeEth = ethers.formatEther(fee);

  await db.query(
    `UPDATE battles SET
       status = 3, resolution = 1, payment_amount = $1, fee_amount = $2,
       settled_at = NOW(), settle_tx = $3
     WHERE id = $4`,
    [paymentEth, feeEth, log.transactionHash, id]
  );

  // Update player stats
  const { rows } = await db.query(
    "SELECT winner, loser, player_a, player_b FROM battles WHERE id = $1", [id]
  );
  if (rows[0]) {
    const b = rows[0];
    await db.query(
      `UPDATE player_stats SET
         total_battles = total_battles + 1, wins = wins + 1,
         total_earned = total_earned + $1, updated_at = NOW()
       WHERE address = $2`,
      [parseFloat(paymentEth) - parseFloat(feeEth), b.winner]
    );
    await db.query(
      `UPDATE player_stats SET
         total_battles = total_battles + 1, losses = losses + 1,
         total_paid = total_paid + $1, updated_at = NOW()
       WHERE address = $2`,
      [parseFloat(paymentEth), b.loser]
    );
  }

  await logEvent("BattleSettledPaid", log.blockNumber, log.transactionHash, (log.index ?? log.logIndex), log.address, {
    battleId: id, loser: loser.toLowerCase(), payment: paymentEth, fee: feeEth,
  });

  broadcast("battle:settled", { id, resolution: "paid", payment: paymentEth, fee: feeEth });
}

export async function handleBattleSettledForfeited(log) {
  const { battleId, loser, chipForfeited } = log.args;
  const id = Number(battleId);

  await db.query(
    `UPDATE battles SET
       status = 3, resolution = 2, settled_at = NOW(), settle_tx = $1
     WHERE id = $2`,
    [log.transactionHash, id]
  );

  const { rows } = await db.query("SELECT winner, loser FROM battles WHERE id = $1", [id]);
  if (rows[0]) {
    await db.query(
      `UPDATE player_stats SET
         total_battles = total_battles + 1, wins = wins + 1, chips_won = chips_won + 1, updated_at = NOW()
       WHERE address = $1`,
      [rows[0].winner]
    );
    await db.query(
      `UPDATE player_stats SET
         total_battles = total_battles + 1, losses = losses + 1, chips_lost = chips_lost + 1, updated_at = NOW()
       WHERE address = $1`,
      [rows[0].loser]
    );
  }

  await logEvent("BattleSettledForfeited", log.blockNumber, log.transactionHash, (log.index ?? log.logIndex), log.address, {
    battleId: id, loser: loser.toLowerCase(), chipForfeited: Number(chipForfeited),
  });

  broadcast("battle:settled", { id, resolution: "forfeited", chipForfeited: Number(chipForfeited) });
}

export async function handleBattleCancelled(log) {
  const { battleId, playerA } = log.args;
  const id = Number(battleId);

  await db.query(
    "UPDATE battles SET status = 4, settled_at = NOW() WHERE id = $1", [id]
  );

  await logEvent("BattleCancelled", log.blockNumber, log.transactionHash, (log.index ?? log.logIndex), log.address, {
    battleId: id,
  });

  broadcast("battle:cancelled", { id });
}

export async function handleBattleExpired(log) {
  const { battleId, loser } = log.args;
  const id = Number(battleId);

  await db.query(
    `UPDATE battles SET status = 3, resolution = 3, settled_at = NOW(), settle_tx = $1 WHERE id = $2`,
    [log.transactionHash, id]
  );

  await logEvent("BattleExpired", log.blockNumber, log.transactionHash, (log.index ?? log.logIndex), log.address, {
    battleId: id, loser: loser.toLowerCase(),
  });

  broadcast("battle:settled", { id, resolution: "expired" });
}

// ============================================================
// V2 EVENTS
// ============================================================

/**
 * VRFTimedOut — VRF never responded within vrfTimeout (1h).
 * Battle gets cancelled, both chips returned to players.
 * This is followed by a BattleCancelled event, so we just log + notify.
 */
export async function handleVRFTimedOut(log) {
  const { battleId } = log.args;
  const id = Number(battleId);

  // Get affected players for targeted broadcast
  const { rows } = await db.query(
    "SELECT player_a, player_b FROM battles WHERE id = $1", [id]
  );
  const playerA = rows[0]?.player_a;
  const playerB = rows[0]?.player_b;

  await logEvent("VRFTimedOut", log.blockNumber, log.transactionHash, (log.index ?? log.logIndex), log.address, {
    battleId: id,
  });

  // Notify both players — their chips will be refunded via the BattleCancelled handler
  broadcastToPlayers("battle:vrf_timeout", {
    id,
    message: "VRF failed to respond — battle cancelled, chips refunded",
  }, [playerA, playerB].filter(Boolean));
}

/**
 * WinningsWithdrawn — winner claimed their pendingWithdrawals balance.
 * Updates player stats and notifies the player.
 */
export async function handleWinningsWithdrawn(log) {
  const { player, amount } = log.args;
  const amountEth = ethers.formatEther(amount);
  const playerAddr = player.toLowerCase();

  // Ensure player row exists, then track withdrawal
  await upsertPlayer(player);
  await db.query(
    `UPDATE player_stats SET
       total_withdrawn = COALESCE(total_withdrawn, 0) + $1,
       updated_at = NOW()
     WHERE address = $2`,
    [parseFloat(amountEth), playerAddr]
  );

  await logEvent("WinningsWithdrawn", log.blockNumber, log.transactionHash, (log.index ?? log.logIndex), log.address, {
    player: playerAddr,
    amount: amountEth,
  });

  broadcastToPlayers("player:withdrew", {
    player: playerAddr,
    amount: amountEth,
  }, [playerAddr]);
}
