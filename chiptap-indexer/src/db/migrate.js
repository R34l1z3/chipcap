import db from "./pool.js";

const migration = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Indexed chips (mirrors on-chain state)
-- ============================================================
CREATE TABLE IF NOT EXISTS chips (
  token_id        INT PRIMARY KEY,
  owner           VARCHAR(42) NOT NULL,
  rarity          SMALLINT NOT NULL DEFAULT 0,
  battle_count    INT NOT NULL DEFAULT 0,
  win_count       INT NOT NULL DEFAULT 0,
  minted_at       TIMESTAMPTZ,
  mint_tx         VARCHAR(66),
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chips_owner ON chips(owner);
CREATE INDEX IF NOT EXISTS idx_chips_rarity ON chips(rarity);

-- ============================================================
-- Indexed battles
-- ============================================================
CREATE TABLE IF NOT EXISTS battles (
  id              INT PRIMARY KEY,
  player_a        VARCHAR(42) NOT NULL,
  player_b        VARCHAR(42),
  chip_a          INT NOT NULL,
  chip_b          INT,
  pool_tier       SMALLINT NOT NULL,
  pool_usd        INT NOT NULL DEFAULT 0,
  status          SMALLINT NOT NULL DEFAULT 0,
  winner          VARCHAR(42),
  loser           VARCHAR(42),
  random_seed     TEXT,
  resolution      SMALLINT NOT NULL DEFAULT 0,
  payment_amount  NUMERIC DEFAULT 0,
  fee_amount      NUMERIC DEFAULT 0,
  created_at      TIMESTAMPTZ,
  decided_at      TIMESTAMPTZ,
  settled_at      TIMESTAMPTZ,
  create_tx       VARCHAR(66),
  join_tx         VARCHAR(66),
  decide_tx       VARCHAR(66),
  settle_tx       VARCHAR(66),
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_battles_status ON battles(status);
CREATE INDEX IF NOT EXISTS idx_battles_player_a ON battles(player_a);
CREATE INDEX IF NOT EXISTS idx_battles_player_b ON battles(player_b);
CREATE INDEX IF NOT EXISTS idx_battles_winner ON battles(winner);
CREATE INDEX IF NOT EXISTS idx_battles_created ON battles(created_at DESC);

-- ============================================================
-- Player stats (aggregated)
-- ============================================================
CREATE TABLE IF NOT EXISTS player_stats (
  address         VARCHAR(42) PRIMARY KEY,
  total_battles   INT NOT NULL DEFAULT 0,
  wins            INT NOT NULL DEFAULT 0,
  losses          INT NOT NULL DEFAULT 0,
  total_earned    NUMERIC NOT NULL DEFAULT 0,
  total_paid      NUMERIC NOT NULL DEFAULT 0,
  total_withdrawn NUMERIC NOT NULL DEFAULT 0,
  chips_won       INT NOT NULL DEFAULT 0,
  chips_lost      INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- v2: add column to existing tables if migrating from older version
ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS total_withdrawn NUMERIC NOT NULL DEFAULT 0;

-- ============================================================
-- Raw events log (for debugging / replay)
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id              SERIAL PRIMARY KEY,
  event_name      VARCHAR(50) NOT NULL,
  block_number    INT NOT NULL,
  tx_hash         VARCHAR(66) NOT NULL,
  log_index       INT NOT NULL DEFAULT 0,
  contract        VARCHAR(42) NOT NULL,
  args            JSONB,
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_number);

-- ============================================================
-- Indexer cursor (tracks last processed block)
-- ============================================================
CREATE TABLE IF NOT EXISTS indexer_cursor (
  id              INT PRIMARY KEY DEFAULT 1,
  last_block      INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO indexer_cursor (id, last_block) VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;
`;

async function migrate() {
  console.log("Running indexer migration...");
  try {
    await db.query(migration);
    console.log("Indexer migration complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    db.pool.end();
  }
}

migrate();
