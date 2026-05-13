# ChipTap Solana indexer

Indexes Anchor program events into Postgres.  REST + WebSocket API
identical to the EVM indexer (so the frontend can swap one for the
other by flipping `VITE_INDEXER_URL`).

```
solana RPC ───logs/sigs───▶ eventListener ──┬──▶ eventHandler ──▶ Postgres
                                            │
                                            └──▶ wsBroadcast ──▶ browsers
```

## Quick start (dev)

```bash
# 1. Build the Anchor IDLs once (in chiptap-solana-programs/, from WSL2):
cd ../chiptap-solana-programs && anchor build

# 2. Copy IDLs into this project:
cp ../chiptap-solana-programs/target/idl/{battle_arena,chip_nft,treasury}.json ./idl/

# 3. Start Postgres:
docker compose up -d

# 4. Configure:
cp .env.example .env
# fill in CHIP_NFT_PROGRAM / BATTLE_ARENA_PROGRAM / TREASURY_PROGRAM from anchor deploy

# 5. Migrate + run:
npm install
npm run db:migrate
npm run dev
```

Verify:
- `http://localhost:3002/api/health` → `{status:"ok",...}`
- `http://localhost:3002/api/indexer/status` → cursor per program
- `http://localhost:3002/api/stats`

## Production (one-shot)

```bash
export CHIP_NFT_PROGRAM=...
export BATTLE_ARENA_PROGRAM=...
export TREASURY_PROGRAM=...
export SOLANA_RPC_PROD=https://your-rpc.helius-rpc.com/?api-key=...
export SOLANA_WS_PROD=wss://your-rpc.helius-rpc.com/?api-key=...

docker compose --profile prod up -d --build
docker compose ps        # all healthy
curl http://localhost:3002/api/health
```

The `prod` profile follows the same migrate-then-start pattern as the
EVM indexer (idempotent migration via `service_completed_successfully`).

## Schema differences vs EVM

| EVM (Polygon)        | Solana                 |
|----------------------|------------------------|
| `chips.token_id` PK  | `chips.asset` PK (Pubkey base58) — `token_id` is now a UNIQUE BIGINT |
| `VARCHAR(42)`        | `VARCHAR(44)`          |
| `chip_a` INT (FK)    | `chip_a` VARCHAR(44)   |
| `tx_hash`            | `signature` (88 chars) |
| `block_number`       | `slot`                 |
| `indexer_cursor.last_block` (single row) | per-program rows keyed by `program` |

REST API shape stays identical (we still expose `chip_a`, `payment_amount`,
etc. — same field names, just different value types).

## Source-of-truth diagram

```
chip-nft program
  • emits ChipMinted, MintPriceUpdated, BattleAuthorityUpdated
  • record_battle is a CPI from battle-arena (no event)

battle-arena program
  • emits Deposited, Withdrawn, BattleCreated/Joined/Decided/
    SettledPaid/SettledForfeited/Cancelled/Expired, VrfTimedOut

treasury program
  • emits BattleArenaUpdated, FeeRecorded, Withdrawn, TreasuryInitialized
```

The indexer subscribes to all three via `Connection.onLogs(programId)`,
reads `Program data: <base64>` log lines, decodes via `BorshEventCoder`
(IDL-driven), and dispatches to handlers.
