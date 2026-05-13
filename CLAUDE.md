# ChipTap PvP — project memory

> **Read this first.** Single source of truth so the next session doesn't
> re-litigate decisions or re-discover gotchas. Edit when state changes.

## What it is

1v1 NFT battle game. Two players stake chips, on-chain RNG picks the winner,
loser pays ransom in native token (95% to winner, 5% to treasury) **or**
forfeits the chip.

## Recent hardening pass (cross-referenced as SEC-* in code comments)

Security + quality fixes landed in May 2026. **Don't undo these without
reading the matching SEC- comment in the source first.**

| Tag | What broke / what's fixed | Touched |
|---|---|---|
| SEC-1 | `pay_ransom` accepted any `winner` AccountInfo — loser could redirect 95 % payout to a sock-puppet. Now `address = battle.winner @ NotWinner` struct constraint + runtime `require_keys_eq!` defence in depth. | `battle-arena/src/lib.rs::PayRansom` |
| SEC-2 | `expire_join` accepted any `player: Signer` and routed player_a's chip to the caller. New struct `ExpireJoin` splits `caller: Signer` (any) from `player_a: AccountInfo` (`address = battle.player_a @ WrongPlayer`). | `lib.rs::ExpireJoin`, `gen-idls.js` |
| SEC-3 | `force_resolve` accepted any `player_a` / `player_b` AccountInfo and let observers steal both chips after VRF timeout. Added `address = battle.player_a/b @ WrongPlayer` struct constraints. | `lib.rs::ForceResolve` |
| SEC-4 | Frontend `config/index.ts` had placeholder pubkeys that didn't decode to 32 bytes — first time `.env` failed to load, the whole bundle crashed silently. Replaced with `readProgramId(envVar, name)` that throws a friendly `[config] Missing VITE_X` message. Wrapped in `ErrorBoundary` so users see the actual error. `BootDiagnostics` component prints a `console.table()` of RPC + 3 programs + wallet detection. | `frontend/src/config/index.ts`, `components/{ErrorBoundary,BootDiagnostics}.tsx`, `main.tsx` |
| SEC-5 | Indexer's `player_stats` doubled on every backfill replay (UPDATE … wins = wins + 1). Now `claimEvent()` atomically inserts into `events` and returns false on duplicate; every handler short-circuits. Two settle handlers wrapped in `BEGIN/COMMIT`. | `chiptap-solana-indexer/src/services/eventHandler.js`, regression test in `test/idempotency.test.js` |
| SEC-6 | PG `pool.on("error")` called `process.exit(1)` — Docker postgres bounces killed the indexer. Now logs + counter + `consecutiveErrors`; healthcheck returns 503 when degraded. `/api/health` does `SELECT 1` + surfaces pool stats. | `src/db/pool.js`, `src/index.js` |
| SEC-7 | `.env` files in 4 dirs, no top-level `.gitignore`. Created one with `**/.env` (+ unignore `!**/.env.example`), `**/id.json`, `**/*-keypair.json` (with deploy-keypair exception), node_modules / dist / target / .anchor / artifacts / cache / typechain-types / coverage / test-ledger / IDE junk. | `chiptap-full/.gitignore` |
| SEC-8 | `expire_decision` used `ForfeitChip` struct which required `loser: Signer` — defeats the "loser ghosted" premise; chips would lock forever. New `ExpireDecision` struct: `caller: Signer` (any), `loser`/`winner: AccountInfo` (`address`-bound). | `lib.rs::ExpireDecision` |
| SEC-9 | `chip_nft::record_battle` was dead code: battle-arena never called it (would blow BPF stack), so on-chain `chip.battle_count`/`win_count` were always 0. Removed both fields + the ix + the Accounts struct + the unused `record_battle_cpi` helper. Indexer's `bumpChipStats(client, asset, won)` now writes per-chip W/L into `chips.battle_count`/`win_count` from settle events. | `chip-nft/src/lib.rs`, `battle-arena/src/lib.rs`, `eventHandler.js`, `gen-idls.js` |
| SEC-10 | `pay_ransom` required winner's `UserAccount` PDA to pre-exist (`AccountNotInitialized` in real Phantom flows). New `ensure_user_account` ix any caller can use to bring up a PDA for any authority. Frontend `BattlePage::pay()` bundles it via `.preInstructions([...])` — one tx, one wallet popup. **Tried `init_if_needed` directly in `PayRansom` — blew the 4 KB BPF stack frame (Access violation in frame 5). Don't.** | `lib.rs::ensure_user_account`, `EnsureUserAccount`, `BattlePage.tsx` |
| SEC-11 | Indexer never recovered from validator restarts — `Connection.onLogs` subscription dies silently. Added watchdog (`connection.getSlot()` every 15 s, 2× fail → `triggerReconnect`); re-runs `start()` which resubscribes + backfills the gap from `indexer_cursor`. Verified by killing/restarting `solana-test-validator` mid-session. | `eventListener.js` |
| SEC-12 | `decodeEventsFromLogs()` used `indexOf("Program data: ")` — any benign `msg!("Program data: …")` in a tx was picked up as an event candidate and run through every coder. False-positive surface; potentially malicious-payload surface if a hostile program emits one shaped like our discriminator. Changed to `startsWith(PREFIX)` (Anchor's documented contract). Regression: `test/events-prefix.test.js`. | `chiptap-solana-indexer/src/utils/events.js` |
| SEC-13 | WS broadcast on `:3003` was open to the world: no auth, no rate-limit, no backpressure, no heartbeat. Added optional shared-token gate (`WS_TOKEN` env on indexer, `VITE_WS_TOKEN` on frontend → `?token=…` query param), hard `WS_MAX_CLIENTS` cap, `WS_MAX_BUFFERED_BYTES` per-socket drop threshold, and 30 s ping/terminate-on-missed-pong heartbeat. Empty token = anonymous (dev parity). Regression: `test/ws-auth.test.js`. | `wsBroadcast.js`, `config/index.js`, `frontend/services/wsClient.ts`, `.env.example` |
| SEC-14 | Solana CI installed CLI from `release.solana.com/v1.18.22/install` while the documented dev toolchain (CLAUDE.md) is Agave 3.1.14 from `release.anza.xyz`; CI was also running `anchor build` (broken on Rust ≥ 1.95) and feeding the indexer empty stub IDLs, so the boot-test passed against a silently broken pipeline. Fixed: `SOLANA_VERSION=3.1.14`, `release.anza.xyz` install URL, `anchor build --no-idl`, `node gen-idls.js`, real program-ID env vars in the indexer job, plus new CI steps for smoke / attack-smoke / idempotency / WS auth / events-prefix regressions. | `.github/workflows/solana-ci.yml` |
| SEC-15 | `(owner, token_id DESC)` composite index missing on `chips` — every inventory / profile page-load did a sort scan. Added `idx_chips_owner_token_id`. | `chiptap-solana-indexer/src/db/migrate.js` |
| SEC-16 | `events` table grew unbounded. Added `EVENTS_RETENTION_DAYS` (default 30) + `idx_events_indexed_at` + a periodic pruner (`eventsRetention.js`) that runs every 6h. Set the env to 0 to disable. | `eventsRetention.js`, `index.js`, `.env.example`, `migrate.js` |
| SEC-17 | `POSTGRES_PASSWORD: chiptap_secret` was hardcoded in `docker-compose.yml` — any `--profile prod` deployment shipped with the dev password. Moved to `${POSTGRES_PASSWORD:?required}` so the stack refuses to start without it. User / DB name / port also externalised, with safe dev defaults via `.env.example`. | `docker-compose.yml`, `.env.example` |
| SEC-18 | `useChipsByOwner` ran `toLowerCase()` on both the connected wallet and the broadcast event's owner before comparing — but Solana base58 IS case-sensitive (a single letter casing differs by bytes). The equality check silently never matched and the inventory page stopped updating until a manual reload. Removed the lower-case dance. | `chiptap-solana-frontend/src/hooks/useChipsByOwner.ts` |
| SEC-19 | Admin-only mutations (`set_paused`, `set_fee_bps`, `set_pool_amount`, `set_*_timeout`, `set_vrf_authority` on battle-arena; `set_mint_enabled`, `set_max_supply` on chip-nft) didn't emit events. Indexer could not reflect admin state changes in its history, and audits could not reconstruct the timeline. Now every setter emits its matching `*Updated` event. New events: `PausedUpdated`, `FeeBpsUpdated`, `PoolAmountUpdated`, `TimeoutUpdated{kind:0=decision/1=join/2=vrf}`, `VrfAuthorityUpdated`, `MintEnabledUpdated`, `MaxSupplyUpdated`. Also retired dead `chip_nft::NotBattleAuthority` error variant (kept slot 6001 as `NotBattleAuthorityDeprecated` so codes don't shift). Cleanup: removed one-shot `fix-seeds.sh` (its job is done). | `battle-arena/src/lib.rs`, `chip-nft/src/lib.rs`, `gen-idls.js` |
| SEC-20 | PDA configs weren't forward-compatible — any new field would re-shift byte offsets and corrupt existing accounts.  All 3 config structs (`ArenaConfig`, `ChipNftConfig`, `TreasuryConfig`) now end with a `_reserved: [u8; 64]` padding field.  New primitive fields go BEFORE the padding (shrink it to compensate), never appended after.  When the padding eventually runs out, schedule a `realloc!` migration ix.  **Adding/changing this field is a hard break — requires `solana-test-validator --reset` + redeploy + reinit on localnet.**  Per-game accounts (`Battle`, `ChipData`, `UserAccount`) intentionally have no padding — they're cheap to create and short-lived; future shape changes there should ship as a new account type rather than a migration. | All 3 program `lib.rs` + `gen-idls.js` |

Switchboard On-Demand VRF integration is documented but not yet performed —
see `chiptap-solana-programs/SWITCHBOARD.md` for the devnet checklist
and option-A (trusted-relayer interim) / option-B (full SDK with on-chain
verification) split.

Regression suites (run after any program change):
- `wsl -d Ubuntu -- bash /mnt/c/.../chiptap-solana-programs/run-smoke.sh` — happy path (SEC-10 winner-PDA-via-ensure_user_account)
- `wsl -d Ubuntu -- bash -lc 'cd .../chiptap-solana-programs && node attack-smoke.js'` — SEC-1/2/3/8
- From `chiptap-solana-indexer/`:
  - `node test/idempotency.test.js` — SEC-5 (needs Postgres up; verifies SEC-15 composite index + SEC-9 `bumpChipStats` along the way)
  - `node test/events-prefix.test.js` — SEC-12 (pure unit, no infra)
  - `WS_TOKEN=secret123 node src/index.js &  node test/ws-auth.test.js` — SEC-13

**Two parallel stacks.** Pick one for production:

|                | EVM (Polygon)               | Solana                            |
|----------------|-----------------------------|-----------------------------------|
| Status         | Production-ready, all CI green | MVP working on localnet, IDL hand-written |
| Contracts      | Solidity 0.8.24 + Hardhat   | Anchor 0.30.1 (Rust)              |
| Frontend       | wagmi + viem + RainbowKit   | wallet-adapter + @coral-xyz/anchor|
| NFT std        | ERC-721 (OpenZeppelin)      | Metaplex Core (Asset)             |
| RNG            | Chainlink VRF v2.5          | mock-VRF on localnet, Switchboard for mainnet (stub) |
| Pricing        | Chainlink price feed (USD)  | Fixed-SOL tiers (no oracle)       |
| Wallet         | MetaMask                    | Phantom / Solflare / Backpack     |

## Repo layout

```
chiptap-full/
├── README.md, CLAUDE.md (this)
├── .github/workflows/
│   ├── ci.yml             EVM CI (4 jobs + aggregate)
│   └── solana-ci.yml      Solana CI (Anchor build + indexer + frontend)
│
├── chiptap-contracts/             EVM — DONE, deployed locally, 44 tests green
├── chiptap-indexer/               EVM indexer — Docker, prod docker-compose
├── chiptap-pvp-frontend/          EVM frontend — Vite, nginx Dockerfile
├── chiptap-nft-metadata/          SVG + IPFS generators (shared)
│
├── chiptap-solana-programs/       Solana programs — see below
├── chiptap-solana-indexer/        Solana indexer — Connection.onLogs + Borsh
└── chiptap-solana-frontend/       Solana frontend — wallet-adapter
```

## EVM stack

### Quick run (assumes Docker Desktop)
```powershell
cd chiptap-contracts
npx hardhat node                              # one terminal
npm run deploy:local                          # another terminal — uses --network localhost

cd ../chiptap-indexer
docker compose up -d                          # postgres :5433
copy .env.example .env                        # update CHIP_NFT_ADDRESS / BATTLE_ARENA_ADDRESS
npm install && npm run db:migrate && npm run dev

cd ../chiptap-pvp-frontend
copy .env.example .env
npm install && npm run dev                    # :5173
```

### EVM key facts (don't re-discover)
- Hardhat config has both `hardhat` (in-process) and `localhost` (RPC :8545). `deploy:local` uses `--network localhost` so it actually hits the running node.
- ethers v6 live event handler receives a `ContractEventPayload` whose `.log` is the EventLog. Indexer's `eventListener.js` has a `normaliseLog()` helper. **Don't remove it.**
- `log.logIndex` → `log.index` in ethers v6.
- Frontend uses `wsClient` as **default + named** export — both forms used.
- `Treasury.receive()` enforces `depositors[msg.sender]`. BattleArena registers itself in `setBattleArena`.
- Frontend `nginx.conf` uses **`resolver 127.0.0.11` + variable proxy_pass** so nginx starts even if indexer is offline. Don't change to `upstream {}` blocks — they fail at config load when DNS doesn't resolve yet.

### EVM file map
| Path | Purpose |
|---|---|
| `chiptap-contracts/contracts/{ChipNFT,BattleArena,Treasury}.sol` | 3 contracts, v2 with security fixes |
| `chiptap-contracts/contracts/mocks/{MockVRFCoordinator,MockPriceFeed}.sol` | for hardhat test |
| `chiptap-contracts/scripts/deploy.js` | deploys 3 contracts + 2 mocks on chainId 31337 |
| `chiptap-contracts/scripts/{e2e-battle,smoke-live}.js` | e2e on in-process / live node |
| `chiptap-indexer/src/services/{eventListener,eventHandler,wsBroadcast}.js` | live + backfill |
| `chiptap-pvp-frontend/src/{config,lib,services,hooks,components,pages}/` | retro UI, mobile-adapted |

## Solana stack

### Toolchain (WSL2 Ubuntu — Windows BPF builds break)
| | Version | Reason |
|---|---|---|
| Rust | **stable 1.95+** for SBF / **1.79.0** for `cargo install anchor-cli` | edition2024 in transitive deps; anchor-cli 0.30 needs old Rust |
| Solana CLI | **3.1.14 (Agave)** via `release.anza.xyz/stable/install` | platform-tools v1.52, supports edition2024 |
| Anchor | **0.30.1** (installed via `RUSTUP_TOOLCHAIN=1.79.0 cargo install anchor-cli@0.30.1 --locked`) | 0.31+ has mpl-core/borsh hell |
| mpl-core | **0.7.2** with `features = ["anchor"]` | 0.12 conflicts with Anchor 0.31 borsh |
| Node | 20 | |

WSL helper scripts in `chiptap-solana-programs/`:
- `wsl-env.sh` — sourced by every other script, sets `$PATH`
- `install-{anchor,solana}.sh`, `setup-keypair.sh`, `gen-program-keys.sh`
- `start-validator.sh` (do NOT use `--bind-address 0.0.0.0` — gossip panics)
- `build-direct.sh` — runs `anchor build --no-idl` (full IDL build is broken on new Rust, see Gotchas)
- `deploy.sh`, `rebuild-and-upgrade.sh`, `run-init.sh`, `run-smoke.sh`
- `upgrade-all.sh` — in-place upgrades all 3 programs + regenerates IDLs + syncs them
- `copy-idls.sh` — sync `target/idl/*.json` into indexer + frontend trees (called by `upgrade-all`)
- `export-key.js` — base58 wallet keypair for Phantom "Import private key"

### Localnet program IDs (deterministic from keypairs in `target/deploy/`)
```
treasury      wGAqdvJJV2DTHUgkDxdMkWotTvg8Q7r5kz5NntWESPp
chip_nft      A8fqFHnTHAAq3B5t22S8RAix4neNTXTp7RaZ6aQbk5qQ
battle_arena  Ae65nkzg2DD4dFUttxUXPpVfZT7kMPX1L9Uk9GDxkBU8
chip_authority AGXCcKqchUyqHgw24CG6K39W2gvgtuxktR86vSmXcpdp  (PDA, never deployed)
mpl_core      CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d  (cloned from devnet)
```
Wallet on localnet: `Dkq4VizFkoouuxfo83ZyvUUwCwMdArbABtfNb48DCJ5s` at `~/.config/solana/id.json` (in WSL).

### Quick run on Solana
```bash
# In WSL (one terminal — keep open)
bash /mnt/c/.../chiptap-solana-programs/start-validator.sh

# In WSL (another terminal — sequence)
bash /mnt/c/.../chiptap-solana-programs/airdrop.sh                # 100 SOL (validator pre-funds 500M)
bash /mnt/c/.../chiptap-solana-programs/deploy.sh                 # anchor deploy --network localnet
bash /mnt/c/.../chiptap-solana-programs/run-init.sh               # init + cross-wire
bash /mnt/c/.../chiptap-solana-programs/run-smoke.sh              # full e2e — should print 🎉

# On Windows host
cd chiptap-solana-frontend && npm run dev                         # :5173
```

### Solana architecture (pinned — read `chiptap-solana-programs/ARCHITECTURE.md` for details)

**3 programs**:
- `treasury` — fee vault PDA, owner-withdrawable
- `chip_nft` — Metaplex Core mint + per-asset `ChipData` PDA (stats)
- `battle_arena` — game logic + `UserAccount` PDA internal-balance ledger

**Key PDAs** (seeds in lib/pda.ts):
| PDA | Seeds |
|---|---|
| `TreasuryConfig`/`vault` | `[treasury]`, `[treasury, vault]` |
| `ChipNftConfig`/`vault`  | `[chip_nft]`, `[chip_nft, vault]` |
| `ChipData`               | `[chip, asset_pubkey]` |
| `ArenaConfig`/`vault`/`chip_authority` | `[arena]`, `[arena, vault]`, `[arena, chip_authority]` |
| `UserAccount`            | `[user, authority_pubkey]` |
| `Battle`                 | `[battle, id_le_bytes_8]` |

**SOL flow** (UserAccount ledger model):
- `deposit(amount)` → SOL from wallet → arena_vault, `user.balance += amount`
- battle creation/join: only chip transfer to `chip_authority`; **no SOL movement**
- `pay_ransom`: `loser.balance -= pool`, `winner.balance += pool - fee`, `arena_vault → treasury_vault` (fee only)
- `withdraw(amount)` → from arena_vault, `user.balance -= amount`
- Per-battle popups: 3 (create, join, finish); was 5-6 in EVM

**Pool tiers (lamports, fixed)**: `0.05 / 0.1 / 0.25 / 0.5 / 1 / 5 SOL`
**Mint prices (lamports, fixed)**: `0.02 / 0.1 / 0.4 / 1 / 4 SOL` for Common/Uncommon/Rare/Epic/Legendary

**Error codes** (battle_arena, hand-mapped in `gen-idls.js`):
`0=NotOwner, 1=Paused, 2=WrongStatus, 3=CannotJoinOwnBattle, 4=NotYourBattle, 5=NotWinner, 6=NotLoser, 7=DecisionPeriodExpired, 8=DecisionPeriodActive, 9=JoinPeriodNotExpired, 10=VrfNotTimedOut, 11=NotVrfAuthority, 12=InvalidTier, 13=InvalidTimeout, 14=FeeTooHigh, 15=InsufficientBalance, 16=ZeroAmount, 17=WrongChip, 18=WrongPlayer, 19=MathOverflow`

**Admin event audit trail** (SEC-19): every `set_*` mutation emits a matching `*Updated` event so the indexer can replay admin actions. New ones since SEC-19: `PausedUpdated`, `FeeBpsUpdated`, `PoolAmountUpdated`, `TimeoutUpdated{kind, seconds}` (kind 0=decision / 1=join / 2=vrf), `VrfAuthorityUpdated`, `MintEnabledUpdated`, `MaxSupplyUpdated`. `set_battle_arena` and `set_mint_price` already emitted theirs.

### Solana file map
| Path | Purpose |
|---|---|
| `chiptap-solana-programs/programs/{treasury,chip-nft,battle-arena}/src/lib.rs` | Anchor programs |
| `chiptap-solana-programs/gen-idls.js` | Hand-written IDL generator (replaces broken `anchor build` IDL stage) |
| `chiptap-solana-programs/init-programs.js`, `smoke.js`, `attack-smoke.js` | TS scripts using Anchor TS client. attack-smoke validates SEC-1/2/3/8 stay closed. |
| `chiptap-solana-programs/target/idl/*.json` | Generated IDLs (also copied to indexer + frontend by `copy-idls.sh`) |
| `chiptap-solana-indexer/src/utils/{idl,events}.js` | `BorshEventCoder`, parses `Program data:` log lines |
| `chiptap-solana-indexer/test/idempotency.test.js` | Regression for SEC-5 (5× replay must not double stats) |
| `chiptap-solana-frontend/src/lib/{pda,programs,format,mpl,notifications}.ts` | Anchor TS client wrappers |
| `chiptap-solana-frontend/src/idl/*.json` | Frontend IDLs (synced by `copy-idls.sh` from programs/target/idl after rebuild) |
| `chiptap-solana-frontend/src/components/{ErrorBoundary,BootDiagnostics}.tsx` | SEC-4 — visible error display + boot-time probes (RPC, programs, wallet) |

## Gotchas — DO NOT re-discover

### EVM
- `--network hardhat` ≠ `--network localhost`. The first uses ephemeral in-process net.
- ethers v6 `WebSocketProvider` throws unhandled `'error'` event when RPC dies. Indexer attaches `provider.websocket.on('error', ...)` early. Don't remove.
- `frontend dist/assets/index-*.js` size > 500 KB — warning is benign; don't fight it.

### Solana — known limitations of the current setup
- **`anchor build` (with IDL) is broken** on Rust ≥ 1.95: `proc_macro::SourceFile` was removed from std, `proc-macro2` 1.0.86's nightly path can't compile. Workaround: build with `--no-idl`, generate IDL JSONs via `gen-idls.js`. Don't try to "fix" this — pinning Rust to 1.79 makes `cargo build-sbf` fail on edition2024 in `block-buffer` 0.12 (no escape).
- **Avoid `pay_ransom` accumulating CPIs**. Solana BPF has 4 KB per stack frame; the original `pay_ransom` had 5 nested CPIs and overflowed. Current shape: only `forward_fee_to_treasury` + `return_chip_to(loser)`. Winner's chip return is via separate `claim_winner_chip`. Chip win/loss stats are computed by **the indexer** from `BattleSettledPaid` event, not on-chain. **Helpers must stay `#[inline(never)]`.**
- **Do NOT add `init_if_needed` to `PayRansom`** — the implicit `create_account` CPI from system program pushes the stack past frame 5. SEC-10 used a dedicated `ensure_user_account` ix bundled via `.preInstructions([...])` in the frontend instead. One signature popup; no winner involvement.
- **Anchor IDL JSON discriminator format**: 8 bytes from sha256(`event:Foo` / `account:Foo` / `global:foo_bar`). Computed in `gen-idls.js`.
- **`new anchor.Program(idl, provider)`** — 2-arg form (program ID lives in `idl.address`). The 3-arg form was Anchor 0.29 and earlier.
- **`solana-test-validator --bind-address 0.0.0.0`** crashes (gossip panics on unspecified IP). Use default 127.0.0.1.
- **Account name camelCase mapping**: snake_case in Rust IDL → camelCase in Anchor TS client. `chip_authority` → `chipAuthority` etc. (`init-programs.js` learned this the hard way.)
- **Anchor seeds must be uniform-typed**. `seeds = [b"x", b"yz"]` fails ("array of size 2 vs 5"). Use `[b"x".as_ref(), b"yz".as_ref()]`. `gen-program-keys.sh` and `fix-seeds.sh` already cleaned all of them.
- **Anchor's `[toolchain]` block** in Anchor.toml asks Anchor to switch toolchain via avm and breaks if the requested versions aren't installed. Removed.
- **Wallet adapter JSX type incompat with React 19**: `ConnectionProvider`, `WalletProvider`, `WalletModalProvider` cast to `React.FC<any>` in `main.tsx`. Don't remove.

## Mobile UI rules

Already adapted (don't redo):
- Tabs scroll horizontally on phones, icon-only on `<sm:`
- `grid-cols-2 sm:grid-cols-4` for stat cards
- `flex-col sm:flex-row` for two-pane pages (Mint preview, Inventory grid+detail)
- Toast bus full-width on mobile, pinned right on `sm:+`
- Leaderboard hides B/L columns on mobile (info merged into player row)
- Tap target `min-height: 32px` baked into `.retro-btn`

## What's NOT done

### EVM
- Multisig owner (Gnosis Safe)
- Timelock on owner functions
- USD-denominated mint prices via Chainlink (would mirror battle pool model)
- Slither / npm audit in CI

### Solana
- Switchboard On-Demand VRF (currently mock — `vrf_authority` is owner)
- Anchor `target/types/*.ts` — no typed Program (we cast IDL to `anchor.Idl`)
- Frontend not battle-tested with real Phantom on localnet
- `chiptap-solana-frontend` Dockerfile + nginx exists but never pushed through `docker compose --profile prod up` for Solana
- Compressed NFTs alternative
- `target/types` generation needs Anchor IDL stage which is broken — would need separate node-side type generator
- WS broadcast on `:3003` open without auth / no backpressure (review item #13) — fine for localnet, must not ship to prod as-is
- Solana CI on `release.solana.com/v1.18.22` while dev is on Agave 3.1.14 via `release.anza.xyz` (review item #14)
- ~~`set_vrf_authority` / admin ix don't emit events~~ → closed by SEC-19
- ~~`events` table grows unbounded~~ → closed by SEC-16 (30-day default TTL)
- ~~`POSTGRES_PASSWORD` hardcoded in `docker-compose.yml`~~ → closed by SEC-17
- ~~Frontend `useChipsByOwner` lower-cases base58~~ → closed by SEC-18
- ~~Composite `(owner, token_id DESC)` index missing~~ → closed by SEC-15
- ~~PDA accounts are not versioned~~ → partial fix in SEC-20: the three `*Config` structs got a 64-byte `_reserved` trailer; per-battle / per-chip / per-user PDAs still don't have padding and any schema change there is a hard break.  When `_reserved` runs out on the configs, write a `realloc!`-constraint migration ix.
- WalletConnect project ID in the EVM frontend's Dockerfile defaults to a placeholder
- GitHub Actions are pinned to `@v4`/`@stable` not to SHAs (supply-chain drift risk — Dependabot or `pin-github-action` should land before any real release)

## How to resume

1. **Read this file first.** Don't read every program/test/page unless touching it.
2. EVM is stable — only touch if explicitly asked.
3. For Solana work:
   - Always run scripts via `wsl.exe -d Ubuntu -- bash /mnt/c/...` with `MSYS_NO_PATHCONV=1`. Direct path expansion fails on Windows-side `Program Files (x86)` parens.
   - Use `wsl-env.sh` as the first source line in any new script.
   - If validator died, `--reset` wipes the ledger; redeploy + reinit (idempotent).
   - If you change a program: `rebuild-and-upgrade.sh` upgrades in place (program ID stays the same; declare_id! must match).
   - Regenerate IDLs and **always copy them into both** `chiptap-solana-indexer/idl/` and `chiptap-solana-frontend/src/idl/`.
4. Don't fight the Anchor IDL toolchain — `gen-idls.js` is the answer.
5. Mobile-first is already done; new pages should follow the patterns in
   `LeaderboardPage.tsx` (tablet table → card on mobile) and
   `ProfilePage.tsx` (`grid-cols-2 sm:grid-cols-4`).

## Useful one-liners

```bash
# EVM smoke
cd chiptap-contracts && npx hardhat run scripts/smoke-live.js --network localhost

# Solana smoke
wsl -d Ubuntu -- bash /mnt/c/.../chiptap-solana-programs/run-smoke.sh

# Validator log
wsl -d Ubuntu -- tail -f /tmp/test-ledger/validator.log

# Reset Solana DB (when indexer is running)
docker exec -i chiptap-solana-db psql -U chiptap -d chiptap_pvp_db \
  -c "TRUNCATE chips, battles, player_stats, events RESTART IDENTITY; \
      UPDATE indexer_cursor SET last_signature=NULL, last_slot=0;"

# Frontend health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/
curl -s http://localhost:3002/api/health
```

## Decisions taken (don't relitigate without strong reason)

- **Solana over EVM** is just an option — both stacks live in the repo
- **Internal balance (UserAccount PDA)** — not custodial off-chain; on-chain ledger inside arena program (Pattern C from earlier discussion)
- **Fixed-SOL pricing on Solana** (no Pyth) — simpler, accept market drift; owner can re-set via setters
- **Metaplex Core** for NFT (not Token Metadata, not cNFTs) — cheap and one-account
- **Mock-VRF on localnet, Switchboard interface ready** for mainnet
- **Hand-written IDLs** (instead of fighting Anchor's broken IDL build pipeline)
- **No on-chain stat counters anywhere** — SEC-9 removed `chip.battle_count`/`win_count` entirely; per-chip and per-player W/L live only in the indexer's `chips` / `player_stats` tables, populated by `bumpChipStats` + the two settle handlers
- **`expire_join`/`expire_decision` are open-callable** with a separate `caller: Signer` slot (any wallet pays the gas) and address-bound `player_a`/`loser`/`winner` AccountInfos — anyone may unstick a ghosted battle, but chips always go to the right wallet (SEC-2, SEC-8)
- **`ensure_user_account` is the canonical "create PDA for X" ix** — payer signs, authority is just an AccountInfo. Use it bundled via `.preInstructions([...])` when the caller's tx will touch a UserAccount that may not exist yet (the only consumer today is `pay_ransom`'s `winner_user`).
- **`/api/health` returns HTTP 503 when degraded** — Docker `depends_on: service_healthy` must check this, not just port 3002 being open
- **WSL2 for Solana toolchain**, never native Windows
