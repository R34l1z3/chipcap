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
| SEC-21 | **Switchboard On-Demand VRF — Option B (full on-chain verification).** Replaces interim Option A (trusted-relayer slothash). New `fulfill_random_words_switchboard` ix — manual layout parsing (NO `Randomness::try_deserialize` because borsh resolves to `()`). Verifies `randomness_account.owner == config.vrf_program` + 8-byte discriminator + `reveal_slot > seed_slot` (proof that oracle revealed AFTER commit), then reads seed from `data[152..160]`. New admin ix `set_vrf_program` (sets the trusted Switchboard program ID — devnet `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2`, mainnet `SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv`). `vrf_program: Pubkey` field carved out of `ArenaConfig._reserved` (so SEC-20's padding shrunk by 32 bytes, no migration needed). Devnet queue: `EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7`. **Relayer SDK pitfalls (all hit and fixed)**: `loadProgramFromConnection` uses a dummy wallet → `getNodePayer` returns undefined → crashes (use `loadProgramFromProvider` with `new Wallet(payer)` instead); SDK's `commitAndReveal` calls `asV0TxWithComputeIxs({connection, ixs})` with no `payer` field → "Payer not provided" (build reveal+fulfill atomic tx manually with retry loop, 3s × 25 attempts because reveal window is slot-dependent); `Randomness.createAndCommitIxs` returns `[randomness, accountKeypair, [createIx, commitIx]]` not `[randomness, ixs, accountKeypair]`; `@coral-xyz/anchor` is CJS-only — must import via `import pkg from "@coral-xyz/anchor"; const { BN, ... } = pkg;`. Indexer: new `BattleSwitchboardVerified` event handler overrides `battles.vrf_method = 'switchboard'` and stores `randomness_account`; `BattleDecided` uses `COALESCE` to default `'slothash'` without downgrading switchboard rows. Frontend: green "✓ VERIFIED BY SWITCHBOARD" badge in `BattleAuditPanel.tsx` with solscan link to randomness account + Switchboard program; "RECOMPUTE LOCALLY" button hidden for switchboard rows (only makes sense for slothash). End-to-end verified on devnet: battle #13, seed `3263297841133832218`, seed%2=0 → player_a won ✓. | `battle-arena/src/lib.rs`, `chiptap-solana-relayer/src/switchboard.js`, `chiptap-solana-indexer/src/services/eventHandler.js`, `chiptap-solana-indexer/src/db/migrate.js`, `chiptap-solana-frontend/src/components/BattleAuditPanel.tsx`, `SWITCHBOARD.md` |
| SEC-22 | **Battle Royale Phase 1 (on-chain only) — 8-player single-VRF mode.** New `BattleRoyale` account (758 bytes — supports up to MAX_PLAYERS=8 with room for future expansion via per-account padding). 7 new ix: `create_battle_royale(pool_tier, max_players)`, `join_battle_royale` (deposits chip + stake from internal balance), `fulfill_random_words_br_switchboard` (atomic reveal+fulfill, sets status=DECIDED, picks `winner = players[seed % max_players]`), `claim_chip_br` (any player reclaims their chip after DECIDED — chips are membership tokens, always returned), `claim_winnings_br` (winner pulls `pool - fee` to internal balance, fee → treasury), `expire_battle_royale_join` (refund-on-cancel if not full before timeout — cancels and returns all chips), `force_resolve_battle_royale` (admin escape hatch if VRF reveal hangs > vrf_timeout). Helpers: `try_settle_br` (transitions DECIDED → SETTLED when chips_claimed_mask == (1<<max_players)-1 AND prize_claimed), `cancel_br` (returns all chips + refunds stakes on cancellation). 6 new events: `BattleRoyaleCreated`, `BattleRoyaleJoined`, `BattleRoyaleRolling`, `BattleRoyaleDecided`, `BattleRoyaleChipClaimed`, `BattleRoyaleWinningsClaimed`, `BattleRoyaleCancelled`, `BattleRoyaleSwitchboardVerified`. 7 new errors (codes 6023-6028 for BR-specific; `MathOverflow` shifted to 6029). **End-to-end smoke `br-smoke.js` validates the full flow on devnet**: 8 throwaway players funded, mint chips × 8, deposit stakes × 8, create, join × 8, Switchboard cycle, all 8 claim chips, winner claims winnings — verifies `winner == players[seed % 8]`, final status=SETTLED, chips_claimed_mask=255. Phase 2-5 (relayer event handler / indexer table+handlers / frontend BR lobby + watch view / deploy) — **all DONE end-of-cycle**: relayer dispatches `BattleRoyaleRolling` to `fulfill_random_words_br_switchboard` via shared `runSwitchboardCycle({ buildFulfillIx })` driver; indexer has `battle_royales` table + 6 handlers + 4 REST endpoints + WS `br:*` topics; frontend `BattleRoyalePage.tsx` (Lobby/Create/Watch) ships behind `[%] ROYALE` tab.  Public devnet validation: Tournament #16 played end-to-end via `chipcap.vercel.app` → owner won the 4-player royale, claimed 0.19 SOL + chip. | `battle-arena/src/lib.rs`, `gen-idls.js`, `br-smoke.js`, `fill-br.js`, `chiptap-solana-relayer/src/{index,switchboard}.js`, `chiptap-solana-indexer/src/{db/migrate,services/eventHandler,routes/api}.js`, `chiptap-solana-frontend/src/pages/BattleRoyalePage.tsx`, `hooks/useIndexerBattleRoyales.ts` |
| SEC-23 | **Tournament system — 8-player single-elim + 3rd-place playoff with SPL ticket gating.** New `Tournament` account (~1133 bytes) carrying `players[8]`, `chips[8]`, `matches[8]` (R0×4 quarters idx 0-3, R1×2 semis idx 4-5, R2 final idx 6, R2 3rd-place idx 7), `prize_claimed_mask:u16` + `chips_claimed_mask:u16`, `winner_1st/2nd/3rd_slot:u8`, `entry_fee:u64`, `current_round`, `status` (0=REGISTERING / 1=ACTIVE / 2=COMPLETED / 3=CANCELLED).  10 new ix: `init_ticket_mint` (admin one-shot — creates global SPL ticket mint PDA `[b"ticket_mint"]` with `ticket_authority` PDA as mint+freeze auth, stores pubkey in `ArenaConfig.ticket_mint` carved from `_reserved`), `buy_ticket(qty)` (mints `qty` TICKETs to buyer ATA at 0.01 SOL each → arena_vault), `create_tournament(entry_fee)`, `register_for_tournament` (burns 1 ticket + escrows chip + deducts entry_fee from internal balance; lobby fills, no auto-start), `start_tournament` (anyone pokes — `t_apply_prize_split` splits pool 60/25/10 + 5% fee, seeds R0 matches `0v1, 2v3, 4v5, 6v7`, emits `TournamentStarted` + 4× `TournamentMatchRolling`), `advance_match_switchboard(match_idx)` (per-match VRF; on round completion `t_advance_round` cascades — seeds next round's slot_a/b and emits `MatchRolling` events for the new cells), `claim_tournament_prize(rank)` (1st/2nd/3rd pulls share to internal balance, fee → treasury via CPI), `claim_tournament_chip`, `expire_tournament_registration` + `force_resolve_tournament`.  Constants: `TICKET_PRICE_LAMPORTS = 10_000_000` (0.01 SOL hardcoded); `T_PRIZE_1ST_BPS=6000 / _2ND_BPS=2500 / _3RD_BPS=1000`; `T_FEE_BPS=500`.  11 new events incl. `TicketsPurchased`, `TournamentMatchRolling { id, round, match_idx, slot_a, slot_b }` (relayer signal), `TournamentMatchDecided`, `TournamentCompleted { id, winner_1st/2nd/3rd: Pubkey }`.  9 new errors (`TicketMintAlreadyInitialized`, `WrongTicketMint`, `InsufficientTicketBalance`, `TournamentRegistrationClosed`, `TournamentNotActive`, `TournamentMatchNotPending`, `WrongTournamentRound`, `TournamentAlreadyCompleted`, `NoPrize`).  **BPF stack-frame fix** required for 7 tournament `Accounts` structs — `Tournament` is 1133 bytes alone which pushed `try_accounts()` past the 4 KB BPF stack limit; wrapped `Tournament`, `ArenaConfig`, `Mint`, `TokenAccount`, `UserAccount` in `Box<Account<>>` to heap-allocate.  **Bracket bug** caught by smoke: initial `t_advance_round` indexed `matches[cur_off + j*2]` for both branches; when `next_round==2 && j==1` this read R2 cells that didn't exist yet (slot_b ended up 0xFF, hung the bracket).  Fixed by special-casing R2 — reads `matches[cur_off+0..2]` (the actual semis) for BOTH final (winners) and 3rd-place (losers).  **Anchor camelCase quirk**: `winner_1st_slot` → `winner1StSlot` (capital S after digit boundary, NOT `winner1stSlot`); only affects on-chain reads from Anchor JS client — indexer/REST returns use snake-case PG column names so frontend reads via REST are unaffected.  `tournament-smoke.js` validates the full pipeline (8 throwaways → buy_ticket × 8 → register × 8 → start → 4 R0 + 2 R1 + 2 R2 Switchboard cycles → claim_prize × 3 → claim_chip × 8 → status=COMPLETED).  **Public devnet validation via UI**: Tournament #20 created from `chipcap.vercel.app/`, filled by `fill-tournament.js` (7 throwaways + auto-`start_tournament`), all 8 matches fulfilled by Switchboard, owner placed 2nd via Watch view → claimed 0.04 SOL silver prize + chip.  Devnet ticket_mint PDA = `EVYUGWnAJ2f1pKuT7p7SFb93n459DrZWbS9N6yqFfixR`. | `battle-arena/src/lib.rs`, `init-ticket-mint.js`, `tournament-smoke.js`, `fill-tournament.js`, `kick-tournament.js` (relayer-down recovery helper), all 3 IDL copies, `chiptap-solana-relayer/src/index.js`, `chiptap-solana-indexer/src/{db/migrate,services/eventHandler,routes/api}.js`, `chiptap-solana-frontend/src/pages/TournamentPage.tsx`, hooks `useIndexerTournaments.ts` + `useTicketBalance.ts`, `lib/pda.ts`, `config/index.ts`, `services/indexerApi.ts`, `App.tsx`, `components/RetroHeader.tsx` |

| SEC-24 | **Post-launch code-review hardening + UX pass** (game modes + tutorial + design).  After SEC-22/23 shipped, a high-effort `/code-review` of the diff surfaced 15 findings; 12 fixed, 3 LOW accepted.  **Two CRITICAL money bugs** (both deployed + proven on devnet): (1) `cancel_br` set status=CANCELLED but NEVER refunded the staked SOL — the `claim_stake_refund_br` ix named in the code comment did not exist, so every cancelled BR stranded up to (max−1)×tier SOL in arena_vault while CLAUDE.md + the UI promised "refund all".  Fix: `claim_chip_br` now credits `player_user.balance += stake` when status==CANCELLED, atomically with the chip return (both cancel paths leave chips_claimed_mask==0, so each player's first claim returns chip+stake; per-slot bitmask guards double-refund; gated on CANCELLED so DECIDED/SETTLED still pay the pool to the winner).  Added `player_user` to `ClaimChipBattleRoyale` (Boxed alongside config+royale for the 4 KB BPF stack — BattleRoyale is 758 B).  (2) `cancel_br` never emitted `BattleRoyaleCancelled` → indexer never flipped the row out of the open-lobby list.  Fix: `cancel_br` takes a `reason` byte (0=join / 1=vrf timeout) and emits.  **Verified**: `cancel-refund-smoke.js` (new) sets join_timeout→300s, 2 joins, expire→CANCELLED, each `claim_chip_br` refunds exactly the 0.05 SOL stake (0.0020→0.0520), restores timeout to 1800; `br-smoke.js` confirms the new `player_user` account doesn't regress the DECIDED path.  **Other fixes**: indexer defaults BR/Tournament `vrf_method='switchboard'` (not 'slothash' — those modes are Switchboard-only, the wrong default showed a false "Option A / legacy" audit badge during the SwitchboardVerified ingestion gap); `BattleAuditPanel` is now mode-aware (`mode: battle|royale|tournament` → routes to `/api/{battles,battle-royales,tournaments}/:id`, was always hitting `/battles/:id` → 404 for BR/Tournament → blank tx rows); RECOMPUTE-LOCALLY button gated on `mode==='battle'` (the helper is the 1v1 slothash formula); cancelled BR no longer feeds `winner=Pubkey::default()` (the all-1s literal) to the audit panel; tournament bracket `cell()` merges authoritative on-chain match state (slot_a/b for R1/R2 — the indexer never back-fills next-round slots — + seed + randomness_account, keeping the indexer's ROLLING(1) status which is an indexer-only animation since on-chain a match is only PENDING(0)/DECIDED(2)); BR Watch gains a `force_resolve` button for ROLLING-stuck royales (countdown to vrf_timeout); cancel-eligibility boundary uses `>=` to match the on-chain strict `>`; `forceTick` 1Hz interval only runs while WAITING/ROLLING; `setData(null)` on audit-panel mode/id change kills the stale-row flash.  **3 LOW accepted (not fixed)**: dead-code `m.randomness_account ?? null` fallback (harmless null), `try_settle_br` never flips CANCELLED→SETTLED (CANCELLED is terminal), no top-level `randomness_account` column on `tournaments` (badge still works, per-match links live in cells).  **Tutorial**: new `HelpModal.tsx` — auto-opens once on first visit (localStorage `chiptap_help_seen_v1`) + a header "?" button; 6 devnet-aware steps reading prices from config; faucet step auto-drops on mainnet.  **Design pass**: removed the marquee ticker and fixed the brand-truncation in `RetroHeader` (brand now `flex-shrink-0`, "ChipTap" + dim-gold "PvP").  Deeper Lobby/Watch CTA-density tuning DEFERRED — those screens are wallet-gated, awaiting user screenshots of connected state (the Claude_Preview MCP renders at ~294px and has no wallet extension). | `battle-arena/src/lib.rs` (deploy sig `domrF5a…`), `gen-idls.js`, `br-smoke.js`, `cancel-refund-smoke.js`, all 3 IDL copies, `chiptap-solana-indexer/src/services/eventHandler.js`, `chiptap-solana-frontend/src/components/{BattleAuditPanel,HelpModal,RetroHeader}.tsx`, `pages/{BattleRoyalePage,TournamentPage}.tsx`, `App.tsx` |

Switchboard On-Demand VRF Option B is **live on devnet** (SEC-21). See
`chiptap-solana-programs/SWITCHBOARD.md` for the layout dump (`sb-debug.js`)
and the option-A → option-B migration notes.

Squads multisig setup (pre-devnet) is documented but not yet executed —
see `chiptap-solana-programs/SQUADS_SETUP.md`.  Cold backup keypair is
already generated (HOT `Dkq4Vi…CJ5s` + COLD `DMJJSE…RsLd`).  Move the
cold `cold-backup.json` to a USB / password manager before mainnet
and `shred -u` the on-disk copy.

End-to-end UX validation on localnet (May 14) — full play-through with
real Backpack wallet + 2 separate keypairs went through: connect →
mint → create → join → VRF → claim → deposit → pay_ransom (one popup,
SEC-10) → withdraw.  Confirms all 20 SEC fixes work under real
wallet-popup conditions, not just programmatic smoke.

End-to-end **devnet** validation (May 24, post SEC-21) — battle #13
through public `https://chipcap.vercel.app/`, indexer on Render,
Switchboard On-Demand fulfilled randomness, frontend showed "✓ VERIFIED
BY SWITCHBOARD" badge with working solscan deeplinks.  Battle Royale
smoke (`br-smoke.js`) also passed on devnet — 8 players, winner picked
by Switchboard, all 8 chips claimed back, prize claimed.

## Public deployment (devnet)

| Surface | URL / ID | Notes |
|---|---|---|
| Frontend | https://chipcap.vercel.app | Vercel free, auto-deploy from `main` |
| Indexer API + WS | https://chiptap-indexer-re8t.onrender.com (`/api/...`, `/ws`) | Render free (cold-start ~30s after idle); `WS_ATTACH_HTTP=1` so WS rides the same port |
| Postgres | Neon: `ep-curly-morning-alcler5g-pooler.c-3.eu-central-1.aws.neon.tech/chiptap_pvp_db` | Serverless, free tier. **ROTATE the leaked password before mainnet** |
| Relayer | Local on user's PC (WSL) | Listens to BattleJoined → commits + reveals Switchboard cycle. Needs hosting before "public" launch |
| GitHub | https://github.com/R34l1z3/chipcap | Public; unlocked devnet faucet |
| Solana programs (devnet) | `treasury wGAqd…ESPp`, `chip_nft A8fqF…k5qQ`, `battle_arena Ae65n…BU8` | Same keypairs as localnet (deterministic IDs) |
| Switchboard On-Demand | devnet PID `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2`, queue `EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7` | Stored in `ArenaConfig.vrf_program` (set via `set_vrf_program` admin ix) |
| Squads multisig | NOT YET (cold backup `DMJJSE…RsLd` generated, hot `Dkq4Vi…CJ5s` is the operator wallet) | Documented in `SQUADS_SETUP.md`; execute before mainnet |

**Credential hygiene reminders (carried over from chat — DO before mainnet)**:
- Rotate the Neon DB password — was shared in chat verbatim
- `fly tokens revoke` the Fly.io API token shared in chat (Fly.io was abandoned in favour of Render — token never used in production)
- Reset `WS_TOKEN` in Render Environment — also shared in chat
- Move `~/.config/solana/multisig/cold-backup.json` to USB / password manager, `shred -u` the on-disk copy

Regression suites (run after any program change):
- `wsl -d Ubuntu -- bash /mnt/c/.../chiptap-solana-programs/run-smoke.sh` — happy path (SEC-10 winner-PDA-via-ensure_user_account)
- `wsl -d Ubuntu -- bash -lc 'cd .../chiptap-solana-programs && node attack-smoke.js'` — SEC-1/2/3/8
- `wsl -d Ubuntu -- bash -lc 'cd .../chiptap-solana-programs && SOLANA_RPC=https://api.devnet.solana.com node sb-smoke.js'` — SEC-21 (Switchboard 1v1 end-to-end, **devnet only** — uses real Switchboard On-Demand)
- `wsl -d Ubuntu -- bash -lc 'cd .../chiptap-solana-programs && SOLANA_RPC=https://api.devnet.solana.com node br-smoke.js'` — SEC-22 (Battle Royale 8-player end-to-end, **devnet only** — fund + mint + deposit + create + join × 8 + Switchboard + claim chips + claim winnings). Burns ~0.8+ SOL of throwaway funding; run sparingly. Also the SEC-24 regression for the `claim_chip_br` + `player_user` account layout.
- `wsl -d Ubuntu -- bash -lc 'cd .../chiptap-solana-programs && SOLANA_RPC=https://api.devnet.solana.com node tournament-smoke.js'` — SEC-23 (8-player bracket: buy_ticket × 8 → register × 8 → start → 8 Switchboard cycles → claim_prize × 3 → claim_chip × 8). ~6 min.
- `wsl -d Ubuntu -- bash -lc 'cd .../chiptap-solana-programs && SOLANA_RPC=https://api.devnet.solana.com node cancel-refund-smoke.js'` — SEC-24 (proves BR cancel→stake-refund: temporarily sets join_timeout→300s, 2 joins, expire→CANCELLED, asserts each claim_chip_br refunds the stake, restores timeout to 1800). ~6 min; mutates devnet config briefly (restored even on failure).
- Operator helpers (not tests): `fill-br.js` / `fill-tournament.js` (fund N throwaways + join + auto-start, for filling a lobby created via the UI), `kick-tournament.js` (manually run Switchboard cycles for a tournament whose relayer missed the MatchRolling events — e.g. relayer was down at start_tournament), `kick-battle.js` (same idea for a 1v1 battle stuck in ROLLING — `B_ID=N node kick-battle.js`).

**Playbook — "battle/BR/tournament stuck in ROLLING > 30 min"** (recurring while the relayer lives on the user's PC):
1. Hit `/api/battles?status=rolling` (or `/battle-royales`, `/tournaments`) on the indexer to confirm `decide_tx: null` and which row(s) are stuck.
2. Run the matching `kick-*.js` helper from `chiptap-solana-programs/` via WSL **as root** (the relayer keypair is at `/root/.config/solana/id.json`):
   - 1v1:        `wsl -d Ubuntu -u root -- bash -lc 'cd /mnt/c/.../chiptap-solana-programs && B_ID=N node kick-battle.js'`
   - Tournament: `wsl -d Ubuntu -u root -- bash -lc 'cd /mnt/c/.../chiptap-solana-programs && T_ID=N node kick-tournament.js'`
   - Battle Royale: no dedicated kick yet — fastest is restarting the relayer (next step) and letting it re-fulfill from the live subscription. Force-cancel button in the Watch UI is the user-facing fallback after vrf_timeout.
3. Restart the relayer itself so it lives until the next PC reboot. The relayer process **dies when its parent wsl.exe call exits** — do NOT launch it via a one-shot `Bash`/`wsl -- nohup` tool call from here, that returns and the kernel reaps the process. The user must run it from a persistent WSL shell on their PC:
   ```bash
   sudo bash -c 'cd /mnt/c/.../chiptap-solana-relayer && nohup node src/index.js > /tmp/relayer.log 2>&1 & disown'
   ```
   then `sudo pgrep -af "node.*relayer.*src/index"` to confirm.
4. The proper fix (already on the roadmap, blocker for friends-test) is hosting it — `fly.toml` is already in `chiptap-solana-relayer/`. Until then, treat every PC reboot as "battles will hang until relayer is re-started or kick-* is run".

Recurrences so far (kept for pattern-matching, not exhaustive): T #20, T #23 needed `kick-tournament.js`; battle #25 needed `kick-battle.js` (2026-06-09, ~41h stuck — winner DAdhXgv…CmqR, seed 10263788496616174800, decide_tx 4ZEKsAi…UZ58m).
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
| `BattleRoyale` (SEC-22)  | `[royale, id_le_bytes_8]` (id from `arena.next_battle_id`, shared counter) |

**SOL flow** (UserAccount ledger model):
- `deposit(amount)` → SOL from wallet → arena_vault, `user.balance += amount`
- battle creation/join: only chip transfer to `chip_authority`; **no SOL movement**
- `pay_ransom`: `loser.balance -= pool`, `winner.balance += pool - fee`, `arena_vault → treasury_vault` (fee only)
- `withdraw(amount)` → from arena_vault, `user.balance -= amount`
- Per-battle popups: 3 (create, join, finish); was 5-6 in EVM

**Pool tiers (lamports, fixed)**: `0.05 / 0.1 / 0.25 / 0.5 / 1 / 5 SOL`
**Mint prices (lamports, fixed)**: `0.02 / 0.1 / 0.4 / 1 / 4 SOL` for Common/Uncommon/Rare/Epic/Legendary

**Battle Royale (SEC-22, on-chain Phase 1)**:
- Same pool tiers as 1v1 (max 8 players → pool = 8 × tier; fee = `pool * fee_bps / 10_000`)
- Stake comes from internal `UserAccount.balance` (NOT a fresh deposit), same as 1v1
- Chips are MEMBERSHIP TOKENS — always returned to original owner after DECIDED (no chip-loss mechanic; only stake is at risk)
- Single VRF call decides winner: `winner = players[seed_u64 % max_players]`. Same Switchboard On-Demand path as 1v1 (SEC-21).
- Lifecycle: `WAITING → ROLLING (full lobby) → DECIDED (VRF returned) → SETTLED (all chips claimed AND winner claimed prize)` OR `CANCELLED (timeout before full)`
- `chips_claimed_mask` is a bitmask — `(1 << max_players) - 1` means everyone got their chip back
- Anyone can be the `caller: Signer` for `fulfill_random_words_br_switchboard`, `expire_battle_royale_join`, `claim_winnings_br`, `claim_chip_br` (player-scoped only by `address` constraint on `player_a/b`-style fields)

**Error codes** (battle_arena, hand-mapped in `gen-idls.js`):
`0=NotOwner, 1=Paused, 2=WrongStatus, 3=CannotJoinOwnBattle, 4=NotYourBattle, 5=NotWinner, 6=NotLoser, 7=DecisionPeriodExpired, 8=DecisionPeriodActive, 9=JoinPeriodNotExpired, 10=VrfNotTimedOut, 11=NotVrfAuthority, 12=InvalidTier, 13=InvalidTimeout, 14=FeeTooHigh, 15=InsufficientBalance, 16=ZeroAmount, 17=WrongChip, 18=WrongPlayer, 19=InvalidRandomnessAccount, 20=RandomnessNotRevealed, 21=RandomnessTooOld, 22=WrongVrfProgram` + **SEC-22 Battle Royale**: `23=InvalidMaxPlayers, 24=BattleRoyaleFull, 25=AlreadyJoined, 26=NotABattleRoyalePlayer, 27=ChipAlreadyClaimed, 28=PrizeAlreadyClaimed, 29=MathOverflow`

**Admin event audit trail** (SEC-19): every `set_*` mutation emits a matching `*Updated` event so the indexer can replay admin actions. New ones since SEC-19: `PausedUpdated`, `FeeBpsUpdated`, `PoolAmountUpdated`, `TimeoutUpdated{kind, seconds}` (kind 0=decision / 1=join / 2=vrf), `VrfAuthorityUpdated`, `MintEnabledUpdated`, `MaxSupplyUpdated`. `set_battle_arena` and `set_mint_price` already emitted theirs.

### Solana file map
| Path | Purpose |
|---|---|
| `chiptap-solana-programs/programs/{treasury,chip-nft,battle-arena}/src/lib.rs` | Anchor programs |
| `chiptap-solana-programs/gen-idls.js` | Hand-written IDL generator (replaces broken `anchor build` IDL stage) |
| `chiptap-solana-programs/init-programs.js`, `smoke.js`, `attack-smoke.js` | TS scripts using Anchor TS client. attack-smoke validates SEC-1/2/3/8 stay closed. |
| `chiptap-solana-programs/sb-smoke.js`, `sb-debug.js` | SEC-21 — Switchboard Option B end-to-end smoke + raw account layout dumper (`sb-debug.js` was how we found that `value` is at offset 152..160, not 112) |
| `chiptap-solana-programs/br-smoke.js` | SEC-22 — Battle Royale full 8-player smoke (fund → mint → deposit → create → join × 8 → Switchboard cycle → claim_chip × 8 → claim_winnings). Asserts winner = seed % 8 and final status = SETTLED. |
| `chiptap-solana-programs/target/idl/*.json` | Generated IDLs (also copied to indexer + frontend by `copy-idls.sh`) |
| `chiptap-solana-programs/SWITCHBOARD.md`, `SQUADS_SETUP.md`, `DEPLOY.md` | Operator runbooks |
| `chiptap-solana-relayer/src/switchboard.js` | SEC-21 — Switchboard Option B driver (commit + reveal + fulfill atomic tx with retry loop). NOT used in Option A path. |
| `chiptap-solana-indexer/src/utils/{idl,events}.js` | `BorshEventCoder`, parses `Program data:` log lines |
| `chiptap-solana-indexer/test/idempotency.test.js` | Regression for SEC-5 (5× replay must not double stats) |
| `chiptap-solana-frontend/src/lib/{pda,programs,format,mpl,notifications}.ts` | Anchor TS client wrappers |
| `chiptap-solana-frontend/src/idl/*.json` | Frontend IDLs (synced by `copy-idls.sh` from programs/target/idl after rebuild) |
| `chiptap-solana-frontend/src/components/{ErrorBoundary,BootDiagnostics}.tsx` | SEC-4 — visible error display + boot-time probes (RPC, programs, wallet) |
| `chiptap-solana-frontend/src/components/BattleAuditPanel.tsx` | SEC-21 — three-state VRF method badge (switchboard / slothash / legacy), RECOMPUTE LOCALLY button (slothash only), solscan deep-links for randomness account |
| `chiptap-solana-frontend/vercel.json` | Vite SPA rewrite rule (`/(.*) → /index.html`) so deep-links don't 404 |
| `chiptap-solana-indexer/render.yaml` | Render Blueprint (free tier, WS_ATTACH_HTTP=1) |

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
- ~~Switchboard On-Demand VRF (currently mock)~~ → closed by SEC-21 (live on devnet, Option B with on-chain proof verification)
- Anchor `target/types/*.ts` — no typed Program (we cast IDL to `anchor.Idl`)
- ~~Frontend not battle-tested with real Phantom on localnet~~ → closed (devnet validation May 24)
- `chiptap-solana-frontend` Dockerfile + nginx exists but never pushed through `docker compose --profile prod up` for Solana
- Compressed NFTs alternative
- `target/types` generation needs Anchor IDL stage which is broken — would need separate node-side type generator
- ~~WS broadcast on `:3003` open without auth / no backpressure~~ → closed by SEC-13
- ~~Solana CI on `release.solana.com/v1.18.22`~~ → closed by SEC-14
- ~~`set_vrf_authority` / admin ix don't emit events~~ → closed by SEC-19
- ~~`events` table grows unbounded~~ → closed by SEC-16 (30-day default TTL)
- ~~`POSTGRES_PASSWORD` hardcoded in `docker-compose.yml`~~ → closed by SEC-17
- ~~Frontend `useChipsByOwner` lower-cases base58~~ → closed by SEC-18
- ~~Composite `(owner, token_id DESC)` index missing~~ → closed by SEC-15
- ~~PDA accounts are not versioned~~ → partial fix in SEC-20: the three `*Config` structs got a 64-byte `_reserved` trailer; per-battle / per-chip / per-user PDAs still don't have padding and any schema change there is a hard break.  When `_reserved` runs out on the configs, write a `realloc!`-constraint migration ix.
- WalletConnect project ID in the EVM frontend's Dockerfile defaults to a placeholder
- GitHub Actions are pinned to `@v4`/`@stable` not to SHAs (supply-chain drift risk — Dependabot or `pin-github-action` should land before any real release)

### Closed in this cycle (kept for archaeology)
- ~~**Battle Royale Phase 2/3/4/5**~~ → SEC-22 fully shipped (relayer dispatch + battle_royales table + BattleRoyalePage UI + devnet deploy).  Validated end-to-end via BR #16 (owner won 0.19 SOL, claimed chip).
- ~~**Tournament system (ticket-based SPL)**~~ → SEC-23 fully shipped.  Validated via T #20 — owner placed 2nd, claimed 0.04 SOL silver + chip back.  See SEC-23 row in the hardening table for the design choices (60/25/10 split, single-elim + 3rd-place, Box<Account<>> stack fix, R2-branch fix, `winner1StSlot` camelCase).
- ~~**Game-mode polish**~~ → SEC-24.  Audit panel mode-aware, BR force-cancel button, bracket on-chain merge, tournament ticket auto-buy, + the 2 CRITICAL cancel-refund bugs caught by code review (now deployed + proven via `cancel-refund-smoke.js`).  **NOTE: the unified `/games/:id` route is NOT done** — deferred, needs `react-router` (the app is tab-state routed, no router).
- ~~**In-game tutorial**~~ → SEC-24.  `HelpModal.tsx` (first-run auto-open + "?" button), 6 devnet-aware steps.
- ~~**Design pass (partial)**~~ → SEC-24.  Header chrome stripped (ticker removed, brand no longer truncates).  Lobby/Watch CTA-density tuning STILL OPEN (see below).

### Roadmap — what's next

**Design pass — remaining half (IN PROGRESS, awaiting user input)**
- Header chrome done.  The remaining ask is Lobby/Watch density + "one obvious CTA per screen".  These screens are **wallet-gated** — the Claude_Preview MCP can't connect a wallet (renders at ~294px, no extension), so they can't be eyeballed in-tool.  **Plan agreed with user: they connect at `chipcap.vercel.app`, screenshot Battle Lobby + Watch (and ideally BR/Tournament), send them; then do targeted edits against the real render.**  Don't churn these screens blind.  When the screenshots arrive, look for: redundant nested panels (panel-in-panel doubles border+padding), duplicate titles (page `<h1>BATTLE ARENA</h1>` + panel `BATTLE #N`), secondary buttons (REFRESH) competing with the primary CTA (CREATE/JOIN), mobile cramping.

**Infrastructure / production blockers**
- **Relayer on hosting** — currently runs on user's PC in WSL.  PC reboot = battles/tournaments hang in ROLLING (the relayer's live subscription only catches events from boot onwards; the poll backfill window is ~50 sigs which evicts older events fast on a busy program).  Discovered the hard way during T #20 — fixed via `kick-tournament.js` helper, but the right answer is putting the relayer on Fly.io / Railway / tiny VPS.  **Blocker for any public devnet announcement.**
- **Ротация утёкших секретов** — Neon DB password, Render `WS_TOKEN`, Fly.io API token (all shared verbatim in chat).  Do BEFORE the public announcement, not after.
- **Verifiable build** for solscan (`solana-verify`) — proves the deployed bytecode matches the GitHub source.  Needed before any mainnet announcement so an auditor can byte-compare the .so.
- **Squads multisig execution** on devnet (rehearsal) then mainnet — runbook in `SQUADS_SETUP.md`, both keypairs already generated.  Locks upgrade-authority to 2-of-2 (cold + hot).
- **Public devnet announcement** — once relayer hosting + secret rotation land.
- **Mainnet deploy** with capped pool tiers — start with the cheapest tier only, lift cap after a week of clean operation.

**Product / UX work**
- **Unified `/games/:id` route** — shareable deep-link that auto-resolves to the right mode.  Needs `react-router` (not yet a dep).  Deferred from SEC-24.
- **Referral system** — DEFERRED by user (2026-05-29: "too early for announce, no player-acquisition need yet, testing with friends").  When revisited: design discussion already had it framed as a "closed club" — user wants invites to feel desirable + referrer earns from it.  Options floated (no decision): econ reward = % of referee fee (lifetime) / % of winnings / milestone bounty / ticket-airdrop / compounding-rate; status = tier badges / Founder-NFT-chip on milestones / public invite-tree; scarcity = capped invites per user / invite-as-SPL-NFT / invite-only launch.  My recommendation on the table was **A+G+I** (lifetime fee-share + Founder NFT chip at 5/10/25 referrals + 5 lifetime invites unlocking more per tier).  Pick the model BEFORE coding (same discipline as the tournament ticket-vs-PDA decision).

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
6. **Frontend visual checks via the Claude_Preview MCP**: `.claude/launch.json`
   lives at the repo PARENT (`C:\Users\User\Desktop\project\chipchip\.claude\`,
   one level above the git root `chiptap-full`) — it runs
   `npm --prefix chiptap-full/chiptap-solana-frontend run dev` on :5173.
   `preview_start` → `preview_screenshot` / `preview_inspect` / `preview_eval`.
   **Caveats**: the screenshot renders at a fixed ~294px-wide column (good
   for mobile checks, useless for desktop layout); and there's **no wallet
   extension** in that browser, so every wallet-gated page (Battle/BR/
   Tournament Lobby+Watch, Profile, Inventory) shows only the "CONNECT
   WALLET" prompt — you cannot eyeball connected states.  Pages you CAN
   see: header/footer chrome, BootDiagnostics, MintPage, HelpModal, the
   connect prompts.  For connected screens, ask the user for screenshots.
7. **Devnet program is upgraded in place** (id `Ae65n…BU8`) — no `declare_id!`
   change across SEC-21/22/23/24.  Deploy = `solana program deploy
   --program-id target/deploy/battle_arena-keypair.json target/deploy/battle_arena.so`.
   The deploy wallet (`Dkq4Vi…CJ5s`) needs ~5.7 SOL free for a redeploy;
   devnet faucet rate-limits hard — if `solana airdrop` fails, use
   https://faucet.solana.com manually.  `init-ticket-mint.js` was a
   one-shot (ticket_mint already live at `EVYUGWnAJ2f1pKuT7p7SFb93n459DrZWbS9N6yqFfixR`).

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

## SEC-25 — i18n (multi-language) — IN PROGRESS

6 languages: **en** (base/fallback) + **zh** Chinese, **ru** Russian, **hi** Hindi, **es** Spanish, **pt** Portuguese.  Stack: `react-i18next` + `i18next` + `i18next-browser-languagedetector`.

**Architecture (all in `chiptap-solana-frontend/`):**
- `src/i18n/index.ts` — init; detects from localStorage key `chiptap_lang` then navigator; `fallbackLng: en`; `load: "languageOnly"` (en-US→en); exports `LANGS` array; syncs `<html lang>` on change.
- `src/i18n/locales/{en,zh,ru,hi,es,pt}.json` — one flat-nested object per lang, mirrored key sets.  Interpolation `{{var}}` for dynamic values (prices, cluster, ids) so copy can't drift from config.
- `src/components/LanguageSwitcher.tsx` — native `<select>` in the header (each lang in its own script).
- `main.tsx` imports `./i18n` before render.

**Per-script pixel fonts (the hard part — Press Start 2P / VT323 are Latin-only):**
- `index.html` loads Pixelify Sans (ru, pixel Cyrillic) + Noto Sans SC (zh fallback) + Noto Sans Devanagari (hi) from Google Fonts.
- `index.css` has `@font-face Zpix` (pixel CJK) + `html[lang="ru|zh|hi"] .font-pixel{…}` overrides that APPEND the script font after Press Start 2P — so digits/"SOL"/punctuation stay pixel, only script glyphs use the script font.  Verified working in preview (zh renders in Zpix pixel font, ru in Pixelify Sans).
- **Zpix is 7 MB → subsetted** to only the glyphs in `zh.json` via `scripts/subset-zpix.py` → `public/fonts/zpix-subset.woff2` (~12 KB).  **RE-RUN `python3 scripts/subset-zpix.py` whenever you add Chinese strings** (needs the Zpix.ttf source at `C:/Temp/zpix/Zpix.ttf` — download from GitHub release v3.1.11 if missing).

**To translate a new page (the established pattern):**
1. Add a section to `en.json` (e.g. `"battle": { … }`), keys grouped by page; use `{{var}}` for interpolated bits.
2. Mirror that exact section into the other 5 locale files with translations.
3. In the page: `import { useTranslation }`, `const { t } = useTranslation();`, replace hardcoded strings with `t("battle.key")` / `t("battle.key", { var })`.  **Gotcha**: if a `.map((t) => …)` shadows the translate fn, rename the loop var (did this in RetroHeader → `tb`).
4. Re-run the Zpix subset; `tsc --noEmit` + `vite build`; commit.

**Done so far:** foundation (header/tabs/footer/common/help-tutorial — all 6 langs, verified) + Batch 1 (MintPage, BootDiagnostics user-facing, rarity names).  Shared sections already in locales: `lang, header, footer, common, help, boot, rarity, mint`.

**Remaining batches (each = add locale section ×6 + refactor page + re-subset + commit):**
- **Batch 2 — BattlePage** (~70 strings): DepositWithdrawBanner (INTERNAL BALANCE / Free / Locked / DEPOSIT / WITHDRAW), Lobby (BATTLE LOBBY, REFRESH, CREATE, YOUR ACTIVE BATTLES, OPEN BATTLES, ROLLING, chip-picker, FIGHT/JOIN/CANCEL), CreateBattle (SELECT POOL / SELECT YOUR CHIP / CONFIRM IN WALLET), WatchBattle (VS, ROLLING, FORCE RESOLVE, YOU WON/LOST, CLAIM CHIP, PAY TO KEEP CHIP / FORFEIT CHIP, VICTORY/DEFEAT, resolution labels), main (BATTLE ARENA, CONNECT WALLET TO BATTLE).  **Add shared `status` (WAITING/ROLLING/DECIDED/SETTLED/CANCELLED) + `resolution` (PAID/FORFEITED/EXPIRED) sections here — reused by BR + Tournament.**
- **Batch 3 — BattleRoyalePage + TournamentPage** (~90): lobbies, create, watch, seat cards, podium, bracket cell labels (QUARTERS/SEMIS/FINAL/GOLD/BRONZE), ticket banner, claim buttons.
- **Batch 4 — InventoryPage + ProfilePage + LeaderboardPage + HistoryPage** (~60): stat labels, table headers, MY/ALL toggle, empty states.
- **Batch 5 — BattleAuditPanel + `notify(...)` toast messages** (~40): audit row labels, VRF badges, the scattered `notify("type", "…")` strings (translate the static part; many are template literals with sig/id).
- **Batch 6 — final**: re-subset Zpix against the complete zh.json, full `vite build`, smoke the language switch on every page, commit.

## Where we are right now (2026-05-29)

Last work: SEC-24 (code-review hardening + tutorial + design-pass header).  All committed + pushed to `R34l1z3/chipcap` `main` (HEAD ~ `803c653`).  Program redeployed to devnet with the cancel→refund fix.

**Pending user / ops actions (NOT code):**
- **Render manual deploy of the indexer** — the SEC-24 `vrf_method` default change is committed but Render doesn't auto-deploy; until the user clicks Manual Deploy, freshly-decided BR/Tournament rows briefly show the wrong VRF badge.  Not data-corrupting; SwitchboardVerified still corrects it.
- **Relayer is still on the user's PC (WSL)** — restarted this session (it had died on a reboot; that's how T #20 needed `kick-tournament.js`).  Putting it on a VPS is the next infra task.

**Next agreed step:** finish the **design pass** — user will connect a wallet at `chipcap.vercel.app`, screenshot the Battle Lobby + Watch (and ideally BR/Tournament), and send them so the Lobby/Watch density + CTA-hierarchy can be tuned against the real render (can't be eyeballed in-tool — wallet-gated).  After that: **relayer on VPS** (last infra blocker before friends-test), then secret rotation / verifiable build / Squads / mainnet.

**Friends-test is the near-term goal** (not public launch).  Referral system explicitly deferred until after friends-test.
