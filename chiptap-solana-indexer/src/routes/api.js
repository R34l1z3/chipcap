// ============================================================
// src/routes/api.js — REST API (Solana port — same shape as EVM)
// ============================================================

import { Router } from "express";
import db from "../db/pool.js";

const router = Router();

// ============================================================
//  BATTLES
// ============================================================

router.get("/battles", async (req, res, next) => {
  try {
    const { status, player, pool_tier, limit = 50, offset = 0 } = req.query;
    const conds = []; const params = []; let i = 1;

    if (status !== undefined)    { conds.push(`status = $${i++}`);    params.push(Number(status)); }
    if (pool_tier !== undefined) { conds.push(`pool_tier = $${i++}`); params.push(Number(pool_tier)); }
    if (player) {
      conds.push(`(player_a = $${i} OR player_b = $${i})`);
      params.push(player);
      i++;
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(Math.min(Number(limit), 100));
    params.push(Number(offset));

    const { rows } = await db.query(
      `SELECT * FROM battles ${where} ORDER BY id DESC LIMIT $${i++} OFFSET $${i}`,
      params,
    );
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) as total FROM battles ${where}`, params.slice(0, -2),
    );
    res.json({ battles: rows, total: countRows[0].total });
  } catch (err) { next(err); }
});

router.get("/battles/open", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM battles WHERE status = 0 ORDER BY created_at DESC LIMIT 50");
    res.json({ battles: rows });
  } catch (err) { next(err); }
});

router.get("/battles/live", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM battles WHERE status IN (1, 2) ORDER BY id DESC LIMIT 50");
    res.json({ battles: rows });
  } catch (err) { next(err); }
});

router.get("/battles/:id", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM battles WHERE id = $1", [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: "Battle not found" });
    res.json({ battle: rows[0] });
  } catch (err) { next(err); }
});

// ============================================================
//  CHIPS
// ============================================================

router.get("/chips", async (req, res, next) => {
  try {
    const { owner, rarity, limit = 100, offset = 0 } = req.query;
    const conds = []; const params = []; let i = 1;

    if (owner)               { conds.push(`owner = $${i++}`);  params.push(owner); }
    if (rarity !== undefined) { conds.push(`rarity = $${i++}`); params.push(Number(rarity)); }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(Math.min(Number(limit), 200));
    params.push(Number(offset));

    const { rows } = await db.query(
      `SELECT * FROM chips ${where} ORDER BY token_id DESC LIMIT $${i++} OFFSET $${i}`,
      params,
    );
    res.json({ chips: rows });
  } catch (err) { next(err); }
});

router.get("/chips/:asset", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM chips WHERE asset = $1", [req.params.asset]);
    if (!rows.length) return res.status(404).json({ error: "Chip not found" });
    res.json({ chip: rows[0] });
  } catch (err) { next(err); }
});

// ============================================================
//  PLAYERS
// ============================================================

router.get("/players/:address", async (req, res, next) => {
  try {
    const addr = req.params.address;
    const [stats, recentBattles, chips] = await Promise.all([
      db.query("SELECT * FROM player_stats WHERE address = $1", [addr]),
      db.query(
        `SELECT * FROM battles WHERE player_a = $1 OR player_b = $1
         ORDER BY id DESC LIMIT 20`, [addr]),
      db.query(
        "SELECT * FROM chips WHERE owner = $1 ORDER BY token_id", [addr]),
    ]);
    res.json({
      address: addr,
      stats: stats.rows[0] || {
        total_battles: 0, wins: 0, losses: 0,
        total_earned: 0, total_paid: 0, total_withdrawn: 0,
      },
      recentBattles: recentBattles.rows,
      chips: chips.rows,
    });
  } catch (err) { next(err); }
});

// ============================================================
//  LEADERBOARD
// ============================================================

router.get("/leaderboard", async (req, res, next) => {
  try {
    const { sort = "wins", limit = 50 } = req.query;
    const map = { wins: "wins", earned: "total_earned", battles: "total_battles" };
    const orderBy = map[sort] || "wins";

    const { rows } = await db.query(
      `SELECT address, total_battles, wins, losses, total_earned, total_paid,
              total_withdrawn, chips_won, chips_lost
       FROM player_stats WHERE total_battles > 0
       ORDER BY ${orderBy} DESC LIMIT $1`,
      [Math.min(Number(limit), 100)],
    );
    res.json({
      leaderboard: rows.map((r, i) => ({ rank: i + 1, ...r })),
    });
  } catch (err) { next(err); }
});

// ============================================================
//  STATS
// ============================================================

router.get("/stats", async (_req, res, next) => {
  try {
    const [b, c, p, v] = await Promise.all([
      db.query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 0) as open, COUNT(*) FILTER (WHERE status = 3) as settled FROM battles"),
      db.query("SELECT COUNT(*) as total FROM chips"),
      db.query("SELECT COUNT(*) as total FROM player_stats WHERE total_battles > 0"),
      db.query("SELECT COALESCE(SUM(payment_amount),0) as total_volume, COALESCE(SUM(fee_amount),0) as total_fees FROM battles WHERE resolution = 1"),
    ]);
    res.json({
      battles: b.rows[0],
      totalChips: c.rows[0].total,
      activePlayers: p.rows[0].total,
      volume: v.rows[0],
    });
  } catch (err) { next(err); }
});

// ============================================================
//  INDEXER STATUS
// ============================================================

router.get("/indexer/status", async (_req, res, next) => {
  try {
    const [{ rows: cursors }, { rows: ev }] = await Promise.all([
      db.query("SELECT program, last_signature, last_slot, updated_at FROM indexer_cursor ORDER BY program"),
      db.query("SELECT COUNT(*) as total FROM events"),
    ]);
    res.json({ cursors, totalEvents: ev[0].total });
  } catch (err) { next(err); }
});

export default router;
