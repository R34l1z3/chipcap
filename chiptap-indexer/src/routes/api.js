// ============================================================
// src/routes/api.js — REST API for indexed data
// ============================================================

import { Router } from "express";
import db from "../db/pool.js";

const router = Router();

// ============================================================
// BATTLES
// ============================================================

/** GET /api/battles — list battles with filters */
router.get("/battles", async (req, res, next) => {
  try {
    const { status, player, pool_tier, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status !== undefined) { conditions.push(`status = $${idx++}`); params.push(Number(status)); }
    if (pool_tier !== undefined) { conditions.push(`pool_tier = $${idx++}`); params.push(Number(pool_tier)); }
    if (player) {
      conditions.push(`(player_a = $${idx} OR player_b = $${idx})`);
      params.push(player.toLowerCase());
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(Math.min(Number(limit), 100));
    params.push(Number(offset));

    const { rows } = await db.query(
      `SELECT * FROM battles ${where} ORDER BY id DESC LIMIT $${idx++} OFFSET $${idx}`,
      params
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) as total FROM battles ${where}`,
      params.slice(0, -2)
    );

    res.json({ battles: rows, total: countRows[0].total });
  } catch (err) { next(err); }
});

/** GET /api/battles/open — open battles (WAITING) */
router.get("/battles/open", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM battles WHERE status = 0 ORDER BY created_at DESC LIMIT 50"
    );
    res.json({ battles: rows });
  } catch (err) { next(err); }
});

/** GET /api/battles/live — active battles (ROLLING + DECIDED) */
router.get("/battles/live", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM battles WHERE status IN (1, 2) ORDER BY id DESC LIMIT 50"
    );
    res.json({ battles: rows });
  } catch (err) { next(err); }
});

/** GET /api/battles/:id — single battle detail */
router.get("/battles/:id", async (req, res, next) => {
  try {
    const { rows } = await db.query("SELECT * FROM battles WHERE id = $1", [Number(req.params.id)]);
    if (rows.length === 0) return res.status(404).json({ error: "Battle not found" });
    res.json({ battle: rows[0] });
  } catch (err) { next(err); }
});

// ============================================================
// CHIPS
// ============================================================

/** GET /api/chips?owner=0x... */
router.get("/chips", async (req, res, next) => {
  try {
    const { owner, rarity, limit = 100, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (owner) { conditions.push(`owner = $${idx++}`); params.push(owner.toLowerCase()); }
    if (rarity !== undefined) { conditions.push(`rarity = $${idx++}`); params.push(Number(rarity)); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(Math.min(Number(limit), 200));
    params.push(Number(offset));

    const { rows } = await db.query(
      `SELECT * FROM chips ${where} ORDER BY token_id DESC LIMIT $${idx++} OFFSET $${idx}`,
      params
    );

    res.json({ chips: rows });
  } catch (err) { next(err); }
});

/** GET /api/chips/:tokenId */
router.get("/chips/:tokenId", async (req, res, next) => {
  try {
    const { rows } = await db.query("SELECT * FROM chips WHERE token_id = $1", [Number(req.params.tokenId)]);
    if (rows.length === 0) return res.status(404).json({ error: "Chip not found" });
    res.json({ chip: rows[0] });
  } catch (err) { next(err); }
});

// ============================================================
// PLAYERS
// ============================================================

/** GET /api/players/:address */
router.get("/players/:address", async (req, res, next) => {
  try {
    const addr = req.params.address.toLowerCase();

    const { rows: stats } = await db.query(
      "SELECT * FROM player_stats WHERE address = $1", [addr]
    );

    const { rows: recentBattles } = await db.query(
      `SELECT * FROM battles
       WHERE player_a = $1 OR player_b = $1
       ORDER BY id DESC LIMIT 20`,
      [addr]
    );

    const { rows: chips } = await db.query(
      "SELECT * FROM chips WHERE owner = $1 ORDER BY token_id", [addr]
    );

    res.json({
      address: addr,
      stats: stats[0] || { total_battles: 0, wins: 0, losses: 0, total_earned: 0, total_paid: 0, total_withdrawn: 0 },
      recentBattles,
      chips,
    });
  } catch (err) { next(err); }
});

// ============================================================
// LEADERBOARD
// ============================================================

/** GET /api/leaderboard?sort=wins|earned|battles&limit=50 */
router.get("/leaderboard", async (req, res, next) => {
  try {
    const { sort = "wins", limit = 50 } = req.query;
    const validSorts = { wins: "wins", earned: "total_earned", battles: "total_battles" };
    const orderBy = validSorts[sort] || "wins";

    const { rows } = await db.query(
      `SELECT address, total_battles, wins, losses, total_earned, total_paid, total_withdrawn, chips_won, chips_lost
       FROM player_stats
       WHERE total_battles > 0
       ORDER BY ${orderBy} DESC
       LIMIT $1`,
      [Math.min(Number(limit), 100)]
    );

    res.json({
      leaderboard: rows.map((r, i) => ({ rank: i + 1, ...r })),
    });
  } catch (err) { next(err); }
});

// ============================================================
// STATS (global)
// ============================================================

/** GET /api/stats */
router.get("/stats", async (_req, res, next) => {
  try {
    const [battlesResult, chipsResult, playersResult, volumeResult] = await Promise.all([
      db.query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 0) as open, COUNT(*) FILTER (WHERE status = 3) as settled FROM battles"),
      db.query("SELECT COUNT(*) as total FROM chips"),
      db.query("SELECT COUNT(*) as total FROM player_stats WHERE total_battles > 0"),
      db.query("SELECT COALESCE(SUM(payment_amount), 0) as total_volume, COALESCE(SUM(fee_amount), 0) as total_fees FROM battles WHERE resolution = 1"),
    ]);

    res.json({
      battles: battlesResult.rows[0],
      totalChips: chipsResult.rows[0].total,
      activePlayers: playersResult.rows[0].total,
      volume: volumeResult.rows[0],
    });
  } catch (err) { next(err); }
});

// ============================================================
// INDEXER STATUS
// ============================================================

/** GET /api/indexer/status */
router.get("/indexer/status", async (_req, res, next) => {
  try {
    const { rows } = await db.query("SELECT last_block, updated_at FROM indexer_cursor WHERE id = 1");
    const { rows: eventCount } = await db.query("SELECT COUNT(*) as total FROM events");
    res.json({
      lastBlock: rows[0]?.last_block || 0,
      lastUpdated: rows[0]?.updated_at,
      totalEvents: eventCount[0].total,
    });
  } catch (err) { next(err); }
});

export default router;
