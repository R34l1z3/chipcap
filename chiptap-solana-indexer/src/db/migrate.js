import db from "./pool.js";

// On Solana an "address" (wallet) and an "asset" (NFT mint) are both
// 32-byte ed25519 pubkeys, base58-encoded → max 44 chars.
const migration = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Indexed chips
-- ============================================================
CREATE TABLE IF NOT EXISTS chips (
  asset           VARCHAR(44) PRIMARY KEY,
  token_id        BIGINT      NOT NULL,
  owner           VARCHAR(44) NOT NULL,
  rarity          SMALLINT    NOT NULL DEFAULT 0,
  battle_count    INT         NOT NULL DEFAULT 0,
  win_count       INT         NOT NULL DEFAULT 0,
  minted_at       TIMESTAMPTZ,
  mint_tx         VARCHAR(88),
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token_id)
);

CREATE INDEX IF NOT EXISTS idx_chips_owner          ON chips(owner);
CREATE INDEX IF NOT EXISTS idx_chips_rarity         ON chips(rarity);
-- SEC-15: composite for "list owner's chips newest-first" — the
-- inventory / profile pages hit this on every page load.
CREATE INDEX IF NOT EXISTS idx_chips_owner_token_id ON chips(owner, token_id DESC);

-- ============================================================
-- Indexed battles
-- ============================================================
CREATE TABLE IF NOT EXISTS battles (
  id              BIGINT       PRIMARY KEY,
  player_a        VARCHAR(44)  NOT NULL,
  player_b        VARCHAR(44),
  chip_a          VARCHAR(44)  NOT NULL,
  chip_b          VARCHAR(44),
  pool_tier       SMALLINT     NOT NULL,
  pool_lamports   BIGINT       NOT NULL DEFAULT 0,
  status          SMALLINT     NOT NULL DEFAULT 0,
  winner          VARCHAR(44),
  loser           VARCHAR(44),
  random_seed     TEXT,
  resolution      SMALLINT     NOT NULL DEFAULT 0,
  payment_amount  NUMERIC      DEFAULT 0,   -- in SOL
  fee_amount      NUMERIC      DEFAULT 0,   -- in SOL
  created_at      TIMESTAMPTZ,
  decided_at      TIMESTAMPTZ,
  settled_at      TIMESTAMPTZ,
  create_tx       VARCHAR(88),
  join_tx         VARCHAR(88),
  decide_tx       VARCHAR(88),
  settle_tx       VARCHAR(88),
  indexed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_battles_status   ON battles(status);
CREATE INDEX IF NOT EXISTS idx_battles_player_a ON battles(player_a);
CREATE INDEX IF NOT EXISTS idx_battles_player_b ON battles(player_b);
CREATE INDEX IF NOT EXISTS idx_battles_winner   ON battles(winner);
CREATE INDEX IF NOT EXISTS idx_battles_created  ON battles(created_at DESC);

-- ============================================================
-- Player stats (aggregated)
-- ============================================================
CREATE TABLE IF NOT EXISTS player_stats (
  address         VARCHAR(44) PRIMARY KEY,
  total_battles   INT         NOT NULL DEFAULT 0,
  wins            INT         NOT NULL DEFAULT 0,
  losses          INT         NOT NULL DEFAULT 0,
  total_earned    NUMERIC     NOT NULL DEFAULT 0,   -- SOL
  total_paid      NUMERIC     NOT NULL DEFAULT 0,
  total_withdrawn NUMERIC     NOT NULL DEFAULT 0,
  chips_won       INT         NOT NULL DEFAULT 0,
  chips_lost      INT         NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Raw events log (for debugging / replay)
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id              BIGSERIAL    PRIMARY KEY,
  event_name      VARCHAR(64)  NOT NULL,
  slot            BIGINT       NOT NULL,
  signature       VARCHAR(88)  NOT NULL,
  log_index       INT          NOT NULL DEFAULT 0,
  program         VARCHAR(44)  NOT NULL,
  args            JSONB,
  indexed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (signature, log_index, event_name)
);

CREATE INDEX IF NOT EXISTS idx_events_name       ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_slot       ON events(slot);
-- SEC-16: retention support -- indexed_at index for the prune
-- query that drops rows older than the configured TTL.
CREATE INDEX IF NOT EXISTS idx_events_indexed_at ON events(indexed_at);

-- ============================================================
-- Indexer cursor — last processed signature per program
-- (Solana doesn't have monotonic block-numbers like EVM.)
-- ============================================================
CREATE TABLE IF NOT EXISTS indexer_cursor (
  program         VARCHAR(44) PRIMARY KEY,
  last_signature  VARCHAR(88),
  last_slot       BIGINT      NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function migrate() {
  console.log("Running indexer migration (Solana schema)...");
  try {
    await db.query(migration);
    console.log("Migration complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    db.pool.end();
  }
}

migrate();
