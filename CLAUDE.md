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
| Solana programs (devnet) | `treasury wGAqd…ESPp`, **`chip_nft 5opz7a9R…v3SFGT` (SEC-26)**, `battle_arena Ae65n…BU8`, **`marketplace 4xHdVGgR…fHxJ1P` (SEC-27 — NEW)** | chip_nft got a NEW id on the SEC-26 tier deploy (old `A8fqF…k5qQ` orphaned but still deployed — close later to reclaim ~2 SOL; its keypair backed up at `target/deploy/chip_nft-keypair.OLD-*.json`). treasury + battle_arena keypairs unchanged. |
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
- `wsl -d Ubuntu -u root -- bash -lc 'cd .../chiptap-solana-programs && node market-smoke.js'` — SEC-27 (P2P marketplace: mint → list → cancel → re-list → fill → withdraw_fees + 3 negative paths, 22 checks). **LOCALNET only and free** — no VRF, no Switchboard, no devnet SOL burned. Needs `start-validator.sh` + `deploy.sh` + `run-init.sh` first. Fastest full-stack smoke in the repo (~20 s).
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

### Active product backlog (2026-06-09, user-requested; re-confirmed 2026-07-25)

The four items below were explicitly added to "near-term tasks" by the user (after the i18n batches 2/3 shipped and battle #25 was unstuck).  Each will be its own SEC-* in a future cycle.  Order in this list is the user's stated order — not necessarily the right execution order; design discussions below in each item.  **Don't start coding any of them without confirming scope with the user first** — three of the four are architecture-shaping decisions that fork the codebase if picked wrong.

**2026-07-25 — user re-stated the queue.**  Item 2 (tier system) is CLOSED (shipped as SEC-26).  The three still-open items — **#3 P2P**, **#4 design / sound / animation**, **#1 referral** — are hereby confirmed as the active product queue.  Nothing about their scope changed; the design questions flagged in each item below are still unanswered and still gate the first line of code.  User has NOT stated an execution order among the three; the sequencing recommendation at the end of this section stands as a proposal only.

1. **Referral system** — UNBLOCKED (was DEFERRED 2026-05-29 "too early for announce", user reactivated 2026-06-09).  Design discussion already had it framed as a "closed club" — invites feel desirable + referrer earns from it.  Options floated (still no decision): econ reward = % of referee fee (lifetime) / % of winnings / milestone bounty / ticket-airdrop / compounding-rate; status = tier badges / Founder-NFT-chip on milestones / public invite-tree; scarcity = capped invites per user / invite-as-SPL-NFT / invite-only launch.  My recommendation on the table was **A+G+I** (lifetime fee-share + Founder NFT chip at 5/10/25 referrals + 5 lifetime invites unlocking more per tier).  **Pick the model BEFORE coding** (same discipline as the tournament ticket-vs-PDA decision).  On-chain shape options: (a) `Referral` PDA `[ref, referrer_pubkey]` storing total fee-share earned; (b) reuse `UserAccount.balance` as the credit ledger.  Indexer needs `referrals` table tracking referrer→referee + lifetime $ flow.

2. ~~**Tier system for chips (replace 5-rarity)**~~ → **DONE, shipped as SEC-26** (T0..T4, promotion by cumulative 1v1+BR wins, live on devnet 2026-07-04).  The design notes below are kept for archaeology — the final shape differs (T0..T4 not T1..T4, flat 0.02 SOL mint, permissionless `record_chip_win` instead of a CPI); read the SEC-26 section for what actually shipped.  Original notes: currently `Rarity = Common/Uncommon/Rare/Epic/Legendary` (5 levels, mint-time only, never changes after).  Replace with **Tier 1/2/3/4** with **progression** (chips level up).  Wide-blast-radius change:
   - **Programs**: `chip-nft::ChipData.rarity: u8` → `tier: u8` + new `level/xp/progress` fields.  Need a `level_up_chip` ix gated on some xp source (battle wins?  ticket burn?  SOL burn?).  `_reserved` padding from SEC-20 can absorb new fields without account migration if shape stays under 64 bytes — but `Rarity → Tier` rename IS a hard break, every existing chip on devnet has old layout.  Either (a) migration ix that reads old `rarity` and writes `tier=rarity/2+1` in place (cheapest), or (b) burn-and-reissue.
   - **Mint prices**: currently `[0.02, 0.1, 0.4, 1, 4]` for 5 rarities → needs new pricing curve for 4 tiers.
   - **Indexer**: `chips.rarity INT` → `chips.tier INT`; `chips.level` / `chips.xp` columns; migration script.
   - **Frontend**: `RARITIES` const → `TIERS` const (config); `ChipCard` colors/borders; MintPage rarity picker → tier picker.  Progression UI somewhere — chip detail panel? Inventory?
   - **i18n**: `rarity.{0..4}` keys → `tier.{1..4}` keys (en + 5 mirrored locales — touches BATCH 1 work but additive).
   - **NFT metadata**: `chiptap-nft-metadata/` SVG generators iterate over rarity ids — full rerun.
   - **Smoke regressions**: every `*-smoke.js` mints chips by rarity — update.
   - **Open design question (DECIDE FIRST)**: what's the progression source?  Battle wins (current `bumpChipStats` already counts these) feel natural but means PvE-less game = wins are zero-sum (someone else loses xp).  Ticket-burn means tickets become dual-use (tournament entry AND chip upgrade).  Free time-based (1 xp/day) feels Web2-ish.  **Don't start the program-side rename until this answer is locked.**

3. **Web2-friendly on/off-ramp + P2P system** — current barrier: new player needs Phantom + devnet SOL + the BootDiagnostics dance before they can mint anything.  Goal stated by user: "упростить вход для пользователей слабо понимающих в блокчейне, а именно ввод и вывод средств. P2p система".  Two intertwined problems:
   - **On-ramp** (fiat → SOL inside the game): MoonPay / Ramp / Transak SDKs all have Solana support but charge 2-5% + KYC.  Alternative: **sponsored wallet** — project pays gas + airdrops a tiny SOL reserve via `ensureUserAccount` + a one-shot `welcome_grant` ix on first interaction, recouped via fee on first win.  Or **embedded wallet** (Privy / Web3Auth — auth with Google/email, key custodied by their SDK, user never sees a seed phrase).  Privy has Solana support now.  Tradeoff: embedded wallet = 5 min onboarding but auth dependency + key custody risk; native Phantom = friction but pure self-custody (which is half the game's value prop given the "provably fair" pitch).
   - **P2P off-ramp** (SOL → fiat without going through a CEX): currently impossible inside the game.  Options: (a) integrate a P2P fiat marketplace (Binance P2P API, Coinbase P2P) — heavy KYC, jurisdiction issues; (b) **internal P2P marketplace** where users post buy/sell offers for chips/tickets in SOL, with escrow handled by an arena PDA — this turns chips into tradable assets and creates secondary market liquidity (also pairs with Tier system #2 — high-tier chips become tradable).  (c) ignore off-ramp entirely; users withdraw to wallet and DIY exit on a CEX.
   - **User likely means (b)**: a P2P chip/ticket marketplace inside the game.  Confirm before designing.  On-chain shape: `Listing` PDA per offer (`[listing, owner, asset]`), `make_listing / cancel_listing / fill_listing` ixs, fee on fill (% to treasury, like battle fee).
   - **My take**: solve **on-ramp via Privy embedded wallet FIRST** (single biggest funnel killer is "install Phantom + buy SOL on Binance + bridge to devnet"), then layer P2P marketplace.  Off-ramp can stay "withdraw to wallet → DIY" through alpha.

4. **Visual polish pass** — animations, sounds, menu rework.  Loose list, not yet scoped:
   - Battle animations (current state: status badges flip colors, no actual fight scene).  Even minimal VS-screen with chip art clashing + a 2-second "rolling dice" animation while waiting for VRF would massively change feel.
   - SFX: every retro game has them.  Pickable kit (8-bit), gated on user setting (mute by default — autoplay audio is hostile).  Hook points: CONNECT, MINT, JOIN, ROLL, WIN, LOSE, CLAIM.
   - Menu rework — what's currently a horizontal tab strip (`RetroHeader.tsx`) feels arcade-cabinet but cramped on mobile.  Consider a "start screen" / launcher concept.  User has prior screenshot review pending from SEC-24 — bundle this rework with that pass.
   - Performance budget: current JS bundle is 1 MB (300 KB gzip) — adding sound assets + sprite art could double it.  Lazy-load battle animations only on the BattlePage chunk.

**Concrete sequencing recommendation** (NOT a decision):
- **Now**: relayer on Fly.io (#0 blocker, in `Infrastructure / production blockers`) — without this, none of the above matter because the game still hangs.
- **Then**: Tier rework (#2) BEFORE Referral (#1) — because referral rewards will likely be expressed in "tier-N chip airdrops" or "X tickets" which depend on the chip model being finalized.
- **Then**: Web2 on-ramp via Privy (#3) — biggest funnel impact, can ship before referral if going public devnet.
- **Then**: Visual polish (#4) — last because every page will get reskinned during the above and you don't want to redo it.
- **Then**: Referral (#1) — once player flow is smooth enough that referees actually retain.
- **P2P marketplace** is its own multi-week project — defer past first public devnet wave.

## Tech-debt register (read-only audit, 2026-07-04)

Full sweep done at user request; nothing was changed. Ordered by severity. Numbers were measured, not guessed.

**🔴 HIGH — money/users at risk:**
1. **Tournament cancel does NOT refund entry fees** — the ONLY real `TODO` in the codebase and it's in a money path: `expire_tournament_registration` (battle-arena lib.rs ~1418) sets CANCELLED, players reclaim chips, but entry fees stay in `pool_amount` ("admin can do a manual refund script post-cancel"). **Same bug class as the SEC-24 CRITICAL BR cancel-refund** (which WAS fixed — `claim_chip_br` refunds stake on CANCELLED). The tournament equivalent was left out of MVP scope. Fix shape: mirror the BR fix — refund `entry_fee` to `player_user.balance` inside `claim_tournament_chip` when status==CANCELLED, gated per-slot by `chips_claimed_mask`. Est. 1-2h + smoke. **Close before friends-test.**
2. **Relayer on user's PC** — recurring outage (#20/#23/#25/#28 all hand-kicked). `fly.toml` ready. The friends-test blocker.
3. **Leaked secrets unrotated** — Neon password, Render WS_TOKEN, Fly token (in chat verbatim since May). Listed in "Credential hygiene" above; still open.

**🟠 MEDIUM — scale/maintainability:**
4. `record_chip_win` byte-parse couples chip_nft to battle-arena's FROZEN account layouts — any Battle/BattleRoyale struct change silently breaks tier progression. Known + smoked (tier-smoke.js), but every arena layout change must re-run that smoke.
5. No typed Anchor clients — **48 `as any`** in frontend; account/method typos surface only at wallet-popup time. Root cause = broken anchor IDL stage; fix = node-side type generator from our gen-idls JSONs.
6. Solana CI Programs job: **0 green runs in 26** — programs have no CI safety net; only devnet smokes (cost SOL, run rarely).
7. Test coverage: frontend **0 tests**, indexer 3 regression tests, programs e2e-smokes only (no unit tests for tier thresholds / fee math).
8. Watch pages poll RPC every 3s per client — the #1 future RPC cost driver; indexer WS topics already exist but aren't used for battle-state pushes.
9. Page monoliths + copy-paste: TournamentPage **1206** lines / BR 1022 / Battle 1013; the `ensureUserAccount+deposit(shortfall)` preIx chain duplicated 4+×, chip-picker 3× — fixes must be applied in 2-3 places every time (happened this session).
10. DB migration = one giant idempotent SQL blob, no versioning — bit us twice in one session (index-before-column order; backticks in comments terminating the JS template literal).
11. Duplicate Render service `chiptap-indexer` (Failed, Blueprint dup) next to the live `-re8t` — cost an hour of confusion; should be deleted in the dashboard.

**🟡 LOW — hygiene:**
- Dead config exports: `BATTLE_STATUS`, `RESOLUTION`, `T_STATUS`, `T_MATCH_STATUS`, `T_ROUND_LABEL`, `T_CANCEL_REASON`, `BR_CANCEL_REASON` — 0 uses outside config after the i18n migration.
- Dead i18n `rarity.*` keys ×6 locales; deprecated `rarity` DB column (intentional).
- 22 untranslated `notify()` strings + 4 pages = the known i18n Batches 4/5.
- NFT metadata URI is a placeholder (`https://chiptap.gg/metadata/tier-0.json`) — IPFS pinning from chiptap-nft-metadata never done.
- Orphaned old chip_nft program on devnet (~2 SOL reclaimable via `solana program close`, keypair backed up); junk `CHIP_NFT_PROGRAMA8fq…` env key on Render.
- GH Actions unpinned (@v4 not SHAs) + running on deprecated Node 20 runners (forced Node 24 since 2026-06-16; Node 20 removed from runners 2026-09-16 — bump before then).
- Untracked junk in programs/ working tree (`@switchboard-xyz/`, `package-lock.json`).
- Free-tier infra: Render sleeps after 15 min (~50s cold start for the first user), Neon free — fine for friends-test, not beyond.

**⚪ STRATEGIC:** the whole EVM stack (contracts/indexer/frontend) is maintained + CI'd but dormant — every CI run and doc page pays tax on a dead branch. Decide: archive or keep.

**Recommended order: #1 → #2 → #3; everything else can wait past friends-test.**

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

## SEC-26 — Tier system (replaces 5-rarity) — IN PROGRESS

**User decisions (2026-06-10/12, locked):**
- Tiers **T0..T4**; every chip mints at **T0**, flat **0.02 SOL** (no more rarity picker).
- Promotion by **cumulative wins**: T0→T1 at **100**, →T2 at **250**, →T3 at **550**, →T4 at **1550** (`TIER_THRESHOLDS` in chip-nft lib.rs).
- **XP sources: 1v1 + Battle Royale wins ONLY** (tournaments excluded). Social quests will add progress later (Phase 3).
- Progress is **per-chip** (user's wording: "прогресс фишек"). `ChipData` carries it; a leveled chip is a tradable asset (P2P synergy).
- Perks: **visual** (now) → **fee discount per tier** (Phase 2) → **invite codes per tier** (Phase 3, with referral system).
- Old devnet state: **wipe** — new program keypairs, fresh configs, no legacy airdrop, no mint limit.

**Mechanism — `chip_nft::record_chip_win` (PERMISSIONLESS, no CPI from arena):**
battle-arena is UNTOUCHED. Anyone (in practice the winner's client, bundled at claim time) submits the `Battle`/`BattleRoyale` account; chip-nft verifies: (1) account owner == `config.battle_arena_program` (set via new admin ix `set_battle_arena_program`, wired by init-programs.js), (2) 8-byte discriminator matches `Battle` [81,148,121,71,63,166,116,24] or `BattleRoyale` [236,95,128,245,19,52,28,163], (3) status DECIDED|SETTLED, (4) `chip_data.asset` == the WINNER's chip parsed from raw layout (Battle: player_a@16 chip_a@80 chip_b@112 status@145 winner@146; BR: status@16 num_joined@19 players@52+32i chips@308+32i winner@564), (5) `game.id > chip_data.last_game_id` (monotonic replay guard — valid because a chip is escrowed while playing, so its game ids strictly increase; 1v1+BR share the arena id counter). Emits `ChipWinRecorded{asset,game_id,wins,tier}` + `ChipPromoted{asset,old_tier,new_tier,wins}`. **Do NOT "simplify" this into a CPI from battle-arena — that's the SEC-9/SEC-10 BPF-stack grave.**

**Layout changes (devnet-wipe-only, NOT upgrade-safe):** `ChipData{asset,token_id,tier:u8,progression_wins:u32,last_game_id:u64,minted_at,bump,_reserved[16]}` (SPACE 86); `ChipNftConfig` gains `battle_arena_program:Pubkey`, arrays `mint_price/max_supply/minted_count` collapse to single u64s (SPACE 195). `mint_chip(name,uri)` — rarity arg GONE. `set_mint_price(u64)` / `set_max_supply(u64)` — rarity arg gone. Error 6003 = `InvalidRarityDeprecated` (slot kept); new 6010-6015 (`ArenaProgramNotSet/WrongGameProgram/BadGameAccount/GameNotDecided/NotWinnerChip/WinAlreadyRecorded`). Events: `ChipMinted.rarity→tier`, `MintPriceUpdated/MaxSupplyUpdated` lose rarity, new `BattleArenaProgramUpdated`.

**Status — code-complete, NOT deployed:**
- ✅ Program (chip_nft.so 306 KB) + gen-idls + init-programs wiring (`set_battle_arena_program`) + all 9 operator scripts' mintChip calls.
- ✅ Indexer: `chips` gains `tier`/`progression_wins` (idempotent ALTERs, `rarity` kept deprecated); `handleChipMinted` writes tier; new `handleChipWinRecorded`/`handleChipPromoted` (SET not increment — chip-nft already deduped); dispatch wired; `/chips?tier=` filter; new WS topics `chip:progress`/`chip:promoted`. node --check green.
- ✅ Frontend: `TIERS` + `TIER_THRESHOLDS` + `tierProgress()` in config (reuses `.rarity-*` colour ramp); `ChipCard` takes `tier` + `progressionWins` (renders T0..T4 badge + next-tier progress bar); `MintPage` single-button (rarity picker gone, tier-progression explainer panel); `record_chip_win` bundled as a best-effort preInstruction into 1v1 `claim()` and BR `claimWinnings()`; `IndexedChip.tier/progression_wins`; i18n `tier.{0..4}`="T0".."T4" + reworked `mint.*` ×6. tsc + vite build green, parity 293 keys ×6, Zpix 361 glyphs, boots clean in preview.
- ✅ **Localnet `record_chip_win` smoke PASSED** (`tier-smoke.js`, fresh validator + deploy + init): PART 1 (real DECIDED 1v1) proved the whole machinery + Battle byte-parse — GameNotDecided / NotWinnerChip / WinAlreadyRecorded all fire, happy-path sets progression_wins=1/tier=0/last_game_id; PART 2 cross-checked the BR offsets (players@52+32i, chips@308+32i, winner@564, status@16, num_joined@19) byte-for-byte against the Anchor decode of a real 2-player BR. The hand-computed offsets are CONFIRMED. (BR can't reach DECIDED on localnet — no Switchboard — so the BR win path is offset-verified read-side rather than end-to-end; the parse code is shared with the proven 1v1 path.)
- ✅ **Devnet deploy DONE — MINIMAL wipe (chip_nft only).** New chip_nft id `5opz7a9RhLLDtsqXsMxWsiuJp9Nnz71nUHkQFqv3SFGT`, deployed (`solana program deploy`, ~2.14 SOL) + initialized (`init-chip-nft-devnet.js`): mint_enabled, mint_price 0.02 SOL, next_token_id 1, battle_arena_program→Ae65… , battle_authority→chip_authority. **battle_arena + treasury UNTOUCHED** (full 3-program wipe was chosen by user but blocked: ~18.7 SOL rent vs 4.19 balance, devnet airdrop rate-limited — fell back to minimal). Consequence: chips fresh from token #1; battles/BR/tournaments keep their history (cosmetic on devnet); relayer needs NO change.
- ✅ **FULLY LIVE + verified on devnet (2026-07-04).** Vercel `VITE_CHIP_NFT_PROGRAM=5opz…` set + redeployed (bundle now only the new id). Render `chiptap-indexer-re8t` on new code, migrated, watching 5opz, indexing new mints with `tier`. End-to-end proof: minted token #4 on devnet → indexed by the live subscription in ~15 s with `tier:0, progression_wins:0`.
- **Deploy gotchas hit (all fixed — read before the next Render deploy):**
  1. **TWO Render services** — the LIVE one is `chiptap-indexer-re8t` (URL `chiptap-indexer-re8t.onrender.com`, in all configs); a second `chiptap-indexer` (Blueprint dup) sits Failed and is a red herring. Always edit `-re8t`.
  2. `render.yaml` hardcoded the OLD chip_nft id → bumped to 5opz (commit 18e351f), but the LIVE `-re8t` reads its env from the DASHBOARD, so the yaml change alone didn't fix it — the dashboard `CHIP_NFT_PROGRAM` had to be corrected (it also had a junk key `CHIP_NFT_PROGRAMA8fqF…` from a botched edit; harmless, left in place).
  3. **Render free tier has no preDeployCommand** → migrate never ran → baked `node src/db/migrate.js && exec node src/index.js` into the indexer Dockerfile CMD (migration is idempotent, runs every boot).
  4. **Migration ordering** — `CREATE INDEX idx_chips_tier` sat in the base DDL before the `ALTER … ADD COLUMN tier`; on an existing DB `CREATE TABLE IF NOT EXISTS` is a no-op so the index referenced a missing column (`ComputeIndexAttrs` error). Moved the index after the ALTER. Also: **don't use backticks in the migration SQL comments** — the whole `migration` is a JS template literal; backticks terminate it (`node --check` caught this).
  5. **`UNIQUE(token_id)` collides after program rotation** — new chip_nft restarts token_id at 1 but old rows hold 1..91; dropped the constraint (asset PK is the real id). New mints now index regardless of token_id reuse.
- **Optional cleanup (deferred):** old chips (old chip_nft) still sit in the indexer DB as tier-0 rows (cosmetic — frontend filters by owner). To wipe: `TRUNCATE chips` + reset the 5opz cursor via the Render Shell or the SQL snippet above. Old chip_nft `A8fqF…` program still deployed (orphaned) — `solana program close` with the backed-up keypair to reclaim ~2 SOL.
- Leftover housekeeping: old chip_nft `A8fqF…k5qQ` still deployed on devnet (orphaned) — `solana program close` it later with the backed-up keypair to reclaim ~2 SOL. Old `rarity.*` i18n keys dead (kept for parity). Full 3-program wipe still possible later once the wallet is funded (~16 more SOL via web faucet).

Gotcha found en route: `build-direct.sh` actually ran `anchor build` WITH IDL (contradicting its CLAUDE.md description) — worked only while no one rebuilt; fixed to `--no-idl`. WSL toolchain lives under **root** (`/root/.cargo`, `/root/.local/share/solana`); default-user `$HOME` has none of it — always `wsl -u root`. MSYS quoting eats `bash -c '... && ...'` chains through wsl.exe — use script FILES, not inline `-c` one-liners.

## SEC-27 — P2P chip marketplace — IN PROGRESS (program layer done, not deployed)

Track A1 of the product queue.  **Architecture picked: a SEPARATE `marketplace` program**, not new instructions on battle-arena.  Two measured reasons, both worth re-reading before anyone "simplifies" it back:
- **`ArenaConfig._reserved` is EXHAUSTED** — `battle-arena/src/lib.rs:1757` is literally `pub _reserved: [u8; 0]`.  SEC-21 carved 32 bytes for `vrf_program`, SEC-23 another 32 for `ticket_mint`.  Any new arena config field now needs the `realloc!` migration SEC-20 deferred, against live devnet state.  A fresh program gets fresh padding.
- battle-arena already needs `Box<Account<>>` on 7 Accounts structs just to fit the 4 KB BPF stack (SEC-23).  Don't add to it.

**Design decisions (locked):**
- **Direct wallet→wallet SOL**, NOT the arena's `UserAccount` internal ledger — the project must never custody user funds (see [[chiptap-positioning]] / the "Product positioning" note), and a purchase is a deliberate one-off unlike the per-battle popups the ledger exists to avoid.  Costs one wallet popup per fill; acceptable.
- **Escrow on `make_listing`** — chip moves seller → `market_authority` PDA.  Free bonus: "listed" and "in a battle" are **mutually exclusive automatically**, because mpl-core rejects a TransferV1 whose authority isn't the current owner.  battle-arena can't escrow a listed chip; we can't list a battling one.  **There is no missing cross-program check — don't add one.**
- **`fee_bps` snapshotted into each `Listing`** so a later `set_fee_bps` can't retroactively tax offers already published at a known net payout.  `MAX_FEE_BPS = 1000` (10 %) ceiling on both `initialize` and `set_fee_bps`.
- **Listing PDA = `[b"listing", asset]`** — one live listing per chip enforced by the seed itself.  Closed on cancel/fill (`close = seller`, so rent refunds to whoever paid it), which frees the seed for re-listing.
- **`cancel_listing` works even while paused** — never trap someone's asset behind an admin flag.  `make_listing` / `fill_listing` are pause-gated.
- **Fee sink = the marketplace's own `market_vault`**, owner-withdrawable — NOT treasury.  Reason: `treasury::record_fee` authenticates a SINGLE registered depositor (`require_keys_eq!(arena_vault, cfg.battle_arena)`), so treasury would need an upgrade first.  That upgrade is cheap whenever we want it — **`TreasuryConfig._reserved` is still the full `[u8; 64]`** (verified, `treasury/src/lib.rs:144`) so adding a `marketplace: Pubkey` depositor slot costs no migration — but it isn't a v1 prerequisite.
- `Listing` gets **no `_reserved` padding**, deliberately — same call as `Battle`: cheap, short-lived, so a future shape change ships as a new account type.

**Status:**
- ✅ Program written + **compiles** — `programs/marketplace/{Cargo.toml,src/lib.rs}`, `marketplace.so` 328 KB via `cargo build-sbf`.  7 ix (`initialize`, `set_paused`, `set_fee_bps`, `withdraw_fees`, `make_listing`, `cancel_listing`, `fill_listing`), 7 events, 10 errors (6000-6009).
- ✅ Program keypair generated: **`4xHdVGgRKnNu3bCSJY9CRz9fnrvxiJuZU2uc9kfHxJ1P`** (`target/deploy/marketplace-keypair.json`).  Registered in `Cargo.toml` workspace members + both `Anchor.toml` program tables.
- ✅ IDL hand-written in `gen-idls.js` (7 ix / 7 ev / 9 types) + `copy-idls.sh` extended to sync it; both indexer and frontend `idl/` trees have `marketplace.json`.
- ✅ **IDL verified against the Rust structs**: `BorshCoder` + `BorshEventCoder` construct clean, and encoded sizes match the Rust `SPACE` constants exactly — `MarketConfig` 134, `Listing` 99.  Round-trip decode confirmed.
- ✅ **LOCALNET DEPLOY + SMOKE PASSED (2026-07-25, first run, 22/22 checks).**  `market-smoke.js` walks mint → list → (buyer-cancel must fail) → cancel → re-list → (self-buy must fail) → fill → withdraw_fees → (non-owner withdraw must fail), asserting mpl-core asset ownership at every hop, the exact lamport split, Listing lifecycle and the config counters.  Proven properties worth knowing:
  - **Escrow ownership actually moves**: seller → `market_authority` on list, back to seller on cancel, to buyer on fill.  Asset owner read from the mpl-core layout (byte 0 = key, bytes 1..33 = owner — same trick `BattlePage.tsx` uses).
  - **Exact money math**: at 1 SOL / 250 bps the seller's delta is `price − fee + listing_rent` (the `close = seller` rent refund is real and must be included in any accounting assertion, ~0.00158 SOL) and the vault's delta is exactly the fee.  Seller signs nothing on fill, so they pay no tx fee.
  - **The `[b"listing", asset]` seed IS reusable** after `close` — re-listing the same chip works, which is what makes one-live-listing-per-asset safe rather than a one-shot.
  - All 3 negative paths reject with the intended error (`NotSeller`, `CannotBuyOwnListing`, `NotOwner`).
- Localnet PDAs (deterministic, same on any cluster): `market_authority` `EwTY9uHf61Vpb3VV8CSARF1eyCdGReZDQvAYB5e28aZz`, `market_vault` `3M3rCG2or2Kosh5w4t4e93fjk37f6ESESfHcABdURsAW`.
- ✅ **Indexer: VERIFIED END-TO-END against live Postgres + localnet (2026-07-25).**  Migration applied clean (`listings` + all 7 indexes incl. the partial one + `chips.listed`); indexer subscribed to the marketplace program (`live subscribed 4xHdVGgR subId=3`); two full smoke runs produced exactly 4 `ListingCreated` / 2 `ListingCancelled` / 2 `ListingFilled` claimed events with **no duplicates**, rows carrying the right `price` / `fee` 0.025 / `paid_to_seller` 0.975 / `fee_bps` 250 snapshot; **`chips.owner` followed the sale to the buyer** and `chips.listed` reset to false; REST `/listings?status=1`, `/listings/active`, `/listings/:id` all correct, with the `LEFT JOIN chips` supplying `token_id`/`tier`/`progression_wins` and `/listings/:id` not being shadowed by `/active`.  What landed:
  - `db/migrate.js` — new `listings` table (id PK from the marketplace's OWN `next_listing_id`; `asset` deliberately NOT unique since the PDA seed is reusable after close), 5 plain indexes + a **partial** `idx_listings_active_price ON listings(price) WHERE status = 0` for the market page's hot "active, cheapest first" query.  Plus `ALTER TABLE chips ADD COLUMN IF NOT EXISTS listed BOOLEAN`.  **Avoids the two SEC-26 migration traps by construction**: all `listings` columns are inline in the CREATE TABLE so no index references a not-yet-added column, and there are no backticks in the SQL comments.
  - `services/eventHandler.js` — `handleListingCreated` / `handleListingCancelled` / `handleListingFilled`, all `claimEvent`-gated and wrapped in BEGIN/COMMIT, registered in `DISPATCH`.  **`ListingFilled` updates `chips.owner` to the buyer** — the chip genuinely changed hands, and the frontend inventory reads `chips.owner` via `indexerApi.getChips(owner)`.
  - `config/index.js` — `MARKETPLACE_PROGRAM` is **OPTIONAL on purpose** (`process.env.… || ""`, not `required()`).  Making it required would hard-crash every existing deployment at boot the way SEC-4 crashed the frontend — Render reads env from the DASHBOARD, so a new required var is a live-outage trap.  `eventListener.getProgramIds()` filters blanks and warns loudly when unset.
  - `utils/idl.js` — loads `marketplace.json` + its `BorshEventCoder`.
  - `routes/api.js` — `GET /listings` (filters status/seller/buyer/asset), `/listings/active` (`?sort=price|newest`), `/listings/asset/:asset`, `/listings/:id`.  All LEFT JOIN `chips` so the grid gets tier/token_id in one round-trip.  **Route order matters** — `/active` and `/asset/:asset` are registered BEFORE `/:id` or Express would match them as an id.
  - WS topics: `market:listed`, `market:cancelled`, `market:filled`, plus `market:sold` targeted at the seller only.
  - `.env.example` documents the new var.
- 🟡 **Frontend: code-complete, compiles clean, NOT yet eyeballed in a browser.**  `tsc --noEmit` exit 0 and `vite build` exit 0 (5598 modules, bundle 1,049 KB / 308 KB gzip — unchanged from before), i18n parity **323 keys × 6 locales**, dev server boots with no transform errors.  What landed:
  - `config/index.ts` — `MARKETPLACE_PROGRAM` is **nullable on purpose**, NOT via `readProgramId` (which throws).  Vercel has no `VITE_MARKETPLACE_PROGRAM`, so a required var would take the whole bundle down on the next deploy — the exact SEC-4 failure.  Absent ⇒ `MARKET_ENABLED === false` ⇒ the MARKET tab never renders.  Present-but-malformed still throws, because that IS worth surfacing.
  - `lib/pda.ts` — `marketConfig` / `marketVault` / `marketAuthority` / `listing(asset)`; they throw a named error rather than deriving against the wrong program when the id is unset.
  - `lib/programs.ts` + `hooks/useMarketplaceProgram.ts`, `hooks/useIndexerListings.ts` (REST + `market:*` WS topics + 30 s poll fallback), `services/indexerApi.ts` (`IndexedListing`, 4 getters, `listed?` added to `IndexedChip`).
  - `pages/MarketPage.tsx` — BROWSE (buy) / SELL (list + cancel) views; reads the live `fee_bps` off `MarketConfig` to show "you receive X after fee"; chip picker filters out `listed` chips.  Wired into `App.tsx` + a `$`-icon tab in `RetroHeader.tsx` that is **conditionally present** on `MARKET_ENABLED`.
  - i18n: 28 `market.*` keys + `header.tabs.market` / `tabsShort.market` across all 6 locales, added by one script so the key sets cannot drift; parity asserted in the same run.
- ⚠️ **Zpix subset NOT re-run** — `C:/Temp/zpix/Zpix.ttf` (the source the script needs) is missing on this machine.  Consequence is cosmetic only: `index.css` falls through to `'Noto Sans SC'` for the new Chinese market strings, so they render cleanly but not in the pixel face.  Re-run `python3 scripts/subset-zpix.py` after fetching Zpix v3.1.11 to fix.
- ✅ **LIVE ON DEVNET (2026-07-26).**  Program `4xHdVGgRKnNu3bCSJY9CRz9fnrvxiJuZU2uc9kfHxJ1P`, 329 448 bytes (the slippage-FIXED binary — the vulnerable one was never deployed), upgrade authority `Dkq4Vi…CJ5s`, deploy sig `576TuHPm…F16J`.  Initialized with `fee_bps = 250` (2.5 %).  **`market-smoke.js` passes 23/23 against devnet**, including `PriceExceedsMax` proving the front-running guard works on the real deployed bytecode.  PDAs are cluster-independent: `market_authority EwTY9uHf…28aZz`, `market_vault 3M3rCG2o…URsAW`.
- ⬜ Tickets (SPL, fungible) deliberately out of v1 — chips only.
- ⬜ **Not yet wired into the hosted stack**: Render indexer needs `MARKETPLACE_PROGRAM` in its DASHBOARD env (the `-re8t` service — see the SEC-26 gotchas), and Vercel needs `VITE_MARKETPLACE_PROGRAM` **plus a redeploy** (Vite inlines it at build time).  Until both, the live site has no MARKET tab and listings are unindexed.

**Devnet deploy was painful — read before the next one:**
- `solana program deploy` from WSL **panics** with `PubsubError(ConnectionError(TimedOut))` — it tries the TPU/QUIC path directly to validators, which does not survive WSL's NAT.  **Always pass `--use-rpc`.**
- The public `api.devnet.solana.com` rate-limits the ~326 write-chunk transactions a 330 KB program needs; the first attempt died with `Max retries exceeded`.  `--max-sign-attempts 200` plus `--use-rpc` got it through, but expect 429 storms.  A paid RPC (Helius/QuickNode) would make this a non-event — and will matter more for `battle_arena`, which is 794 KB.
- **Every failed attempt strands a buffer holding the full rent (~2.29 SOL).**  Two attempts stranded 4.57 SOL total; `solana program close --buffers --url devnet` recovered all of it (authority is the deploy wallet).  Check `solana program show --buffers` after any failure — the SOL is NOT lost, but it is invisible until you look.
- Pre-flight the balance: rent for a 330 KB program is ~2.29 SOL and `--max-len` defaults to the exact binary size (no 2× headroom), so a later size-increasing upgrade needs `solana program extend`.
- **Localnet verification gotcha:** the Vite dev server binds **IPv6-only** (`[::1]:5173`) and, under the preview harness, is reachable *only* from the Browser pane — `curl`/`Invoke-WebRequest` from PowerShell get connection-refused even with the proxy bypassed.  So visual checks need the Browser pane actually displayed; don't waste time debugging the shell side.
- 🔴 **SECURITY BUG found in self-review after the first devnet deploy attempt — front-running the price (FIXED, needs redeploy).**  `fill_listing` originally took **no arguments**: the buyer signed a tx that paid whatever `listing.price` happened to be at execution time.  The Listing PDA is seeded by the **ASSET**, not the listing id, so the address survives a cancel+relist.  A malicious seller could therefore land `cancel_listing` + `make_listing` at a far higher price between the buyer signing and the tx executing, and the buyer's own signature would pay the new price.  **Wallet simulation does not protect** — it runs before signing, the swap lands after.  Fix: mandatory `max_price: u64` argument + `require!(price <= max_price, PriceExceedsMax)` (new error 6010), the frontend passes exactly the price the buyer was shown, and `market-smoke.js` gained a negative case asserting a ceiling below the listed price is rejected.  **Do not remove that argument** — the asset-seeded PDA makes it structural, not cosmetic.
- **Operational note for the frontend:** `MARKET_ENABLED` is resolved from `import.meta.env` at **build** time (Vite inlines it), so enabling the marketplace on Vercel means setting `VITE_MARKETPLACE_PROGRAM` **and then redeploying** — same shape as the SEC-26 Render gotcha where a dashboard env change alone did nothing.
- **Two gotchas from the verification run, both worth keeping:**
  1. `MarketConfig.total_volume` / `total_fees` are **lifetime accumulators**, so the first version of `market-smoke.js` asserted absolute values and passed only on a virgin config — it failed on the second run with `total_volume=2000000000`.  Fixed to snapshot-and-assert-delta, which is what makes the smoke **re-runnable** against an already-initialised marketplace.  Apply the same discipline to any future counter assertion.
  2. On localnet, `getSignaturesForAddress` backfill returned **0 sigs for every program** (including chip_nft, which definitely had txs) — the events were caught by the live `onLogs` subscription instead.  Not investigated, not caused by SEC-27; just don't rely on backfill to prove ingestion on a test-validator, start the indexer BEFORE the smoke.
- **Found en route (pre-existing, NOT caused by SEC-27, spawned as its own task):** the indexer **never updates `chips.owner` when a chip is forfeited** in a 1v1 — `handleBattleSettledForfeited` writes battles/player_stats/`bumpChipStats` but no ownership row.  Since inventory reads `chips.owner`, a forfeit leaves the lost chip visible to the loser and invisible to the winner.  `handleChipMinted` is the only writer of that column today.

**Gotcha found en route — IDL field casing (cost real debugging, don't rediscover):**
Anchor 0.30's **raw `BorshCoder`/`BorshEventCoder` use the IDL's literal field names, i.e. snake_case** (`fee_bps`, `created_at`, `paid_to_seller`).  Passing camelCase to `accounts.encode` does **not** throw — it silently encodes **0**.  Measured, not guessed.  This does NOT contradict the two existing camelCase gotchas in this file: `new anchor.Program(idl, provider)` converts the IDL to camelCase at construction, which is why SEC-23 saw `winner1StSlot` and why `.accounts({chipAuthority})` works.  So:
- **Indexer** (raw event coder) → **snake_case** event fields.  The existing handlers already hedge with `data.poolTier ?? data.pool_tier` — **follow that house pattern** for the marketplace handlers.
- **Frontend** (via `anchor.Program`) → **camelCase** (`feeBps`, `createdAt`, `paidToSeller`).

**Next steps, in order:** localnet deploy + init + a `market-smoke.js` (mint → list → cancel → list → fill, asserting fee split, escrow ownership at each stage, and that `fill_listing` by the seller is rejected) → indexer `listings` table + 3 handlers + REST/WS → frontend market page + hooks → devnet deploy.

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

## Where we are right now (2026-07-04)

Last full session shipped a LOT — all committed + pushed to `R34l1z3/chipcap` `main` (HEAD `c40eb64`). In order:

1. **SEC-25 i18n Batches 2 + 3** — BattlePage, BattleRoyalePage, TournamentPage all `t()`-ified across 6 langs (see SEC-25 section). Foundation + Batch 1 were prior. **Remaining i18n: Batch 4** (Inventory/Profile/Leaderboard/History) + **Batch 5** (BattleAuditPanel + `notify(...)` toasts) + final Zpix re-subset. The `notify(...)`/`notifyTxError(...)` strings across all pages are STILL English — that's Batch 5. `rarity.*` locale keys are now dead (SEC-26 replaced them with `tier.*`) but kept for parity — prune when convenient.
2. **PvP claim/pay UX fixes** (commit `a74e4fc`) — pay-ransom now auto-deposits the shortfall (loser who never used DEPOSIT was hitting InsufficientBalance/AccountNotInitialized); CLAIM panel hides once the winner's chip left escrow (reads mpl-core owner); pay window shows a live countdown and drops to forfeit-only after `decision_timeout`. `debug-battle-txs.cjs` / `debug-tx-ix.cjs` are the forensics helpers (no on-chain tx had actually failed — it was all client-side gating).
3. **CI repair** (commit `25eae41`) — EVM CI is now GREEN. Fixed the empty `public/` dir (`.gitkeep`), the anchor-CLI install (crates.io pin not avm-from-master), and WS_TOKEN scoping. **Solana CI still RED** on the `Programs (anchor build --no-idl)` job — never passed in 26 runs; a heavy integration job fighting the fragile anchor toolchain. Task #15 open. Not a regression; low priority vs. launch.
4. **SEC-26 tier system — DESIGNED, BUILT, LOCALNET-SMOKED, DEPLOYED, VERIFIED LIVE.** See the full SEC-26 section above. chip_nft got a NEW devnet id `5opz7a9RhLLDtsqXsMxWsiuJp9Nnz71nUHkQFqv3SFGT` (minimal wipe — battle_arena + treasury untouched). End-to-end verified (mint→index with tier). This ate most of the session incl. 4 Render redeploys chasing migration gotchas (all documented in the SEC-26 section — READ THEM before touching the Render indexer again).

**Live infra state at session end:**
- Frontend `chipcap.vercel.app` — tier system live (new chip_nft).
- Indexer `chiptap-indexer-re8t.onrender.com` — new code, migrated, indexing tier. (The OTHER Render service `chiptap-indexer` is a Failed Blueprint dup — ignore it.)
- **Relayer — status UNKNOWN / assume DEAD.** Still on the user's PC in WSL; dies on every reboot. **First thing next session if doing anything battle-related: check `wsl -u root pgrep -af "node.*relayer.*src/index"` and restart via a persistent `Start-Process wsl` window if dead.** Playbook + `kick-battle.js`/`kick-tournament.js` in the regression-suite section.

**Pending / next (nothing blocking, user to pick):**
- **Relayer on Fly.io** — THE friends-test blocker. `fly.toml` ready in `chiptap-solana-relayer/`. Needs user `flyctl login`. Recurring pain (battles hang every PC reboot — #20/#23/#25/#28 needed manual kicks).
- **Solana CI Programs job** (task #15) — still red; optional.
- Optional SEC-26 cleanups: `TRUNCATE chips` on Render to drop old rarity-era rows; `solana program close` the orphaned old chip_nft `A8fqF…` to reclaim ~2 SOL.

### Active product queue (confirmed by user 2026-07-25)

Three feature tracks, all from the "Active product backlog" section above — read the matching numbered item there for the full design discussion and the open questions BEFORE writing code.  All three are still **design-locked**: each has at least one unanswered architecture question that forks the codebase if guessed wrong.  Ask the user, don't pick for them.

| # | Track | Backlog ref | What must be decided first |
|---|---|---|---|
| A1 | **Internal P2P marketplace** (chips + tickets, on-chain escrow) | backlog #3b | **STARTED 2026-07-25 → now tracked as SEC-27** (see its own section below).  Scope answered: user wants BOTH the marketplace and a fiat on-ramp.  Architecture decided (separate `marketplace` program); program layer compiles + IDL verified; not yet deployed or smoked. |
| A2 | **Fiat on-ramp = outbound LINK + short tutorial** (not an SDK) | backlog #3a | **Scope narrowed by the user 2026-07-25: "просто ссылка на ресурс покупки и небольшой туториал как пользоваться".**  No widget, no SDK, no API key.  This is now a SMALL frontend + i18n task, actionable today — see the A2 subsection below.  Decisions left are editorial (which providers to list), not architectural. |
| B | **Design + sound + animation pass** | backlog #4, plus the deferred SEC-24 design pass | Needs the **wallet-connected screenshots** the user agreed to send (Lobby / Watch / BR / Tournament) — the Claude_Preview MCP renders at ~294px with no wallet extension, so these screens cannot be eyeballed in-tool.  Don't churn them blind.  Scope list: VS-screen + dice-roll animation while VRF is pending, 8-bit SFX kit (muted by default) on CONNECT/MINT/JOIN/ROLL/WIN/LOSE/CLAIM, menu rework away from the cramped horizontal tab strip.  Watch the perf budget: bundle is already 1 MB (300 KB gzip) — lazy-load animation + audio assets per-page. |
| C | **Referral system** | backlog #1 | The **econ model** (my proposal on the table: lifetime fee-share + Founder NFT chip at 5/10/25 referrals + 5 lifetime invites unlocking more per tier) and the **on-chain shape** (`Referral` PDA vs reusing `UserAccount.balance` as the credit ledger).  Same discipline as the tournament ticket-vs-PDA call: pick the model before touching Rust. |

**Sequencing note (proposal, not a decision):** the relayer-on-Fly blocker still outranks all three — battles hang without it, so a marketplace or a sound pass ships onto a broken game.  After that, B is the cheapest (frontend-only, no program change, no migration) and C is the most valuable-once-retention-exists; A1 is the biggest (new program surface + escrow + indexer tables + new UI) and worth splitting into its own multi-cycle project.  User has not picked an order — ask.

#### Product positioning (user-stated 2026-07-25 — treat as a constraint, not a preference)

- **Global market**, not region-specific.  Do NOT design around any single jurisdiction's payment rails.  (An earlier note in my memory about a RU-only payment stack — ЮKassa/Prodamus/54-ФЗ — belongs to the user's *other* project `prompt-upgrade-agent`.  It does NOT apply to ChipTap.  Don't carry it over again.)
- **Fully decentralized** — the project must never custody user fiat or user funds.  This has two concrete consequences that resolve open design questions below: it forces the **non-custodial widget** model for A2, and it argues for **direct wallet-to-wallet payment** in A1 rather than routing marketplace trades through the `UserAccount` internal-balance ledger.
  > ⚠️ **CONTESTED as of 2026-07-25.**  Later the same day the user said they want a **fiat↔SOL P2P exchange with the project holding users' SOL so it can arbitrate disputes** — which is the opposite of this constraint.  Asked to choose; the user chose **"don't build it yet, understand it first"**, so the constraint above still governs all code, but treat the decentralization stance as an OPEN product question, not settled.  See the A2-bis subsection.
- i18n (SEC-25, 6 languages) is the existing expression of the global-market stance — finishing Batches 4/5 is on the critical path for a global audience, not cosmetic.

#### A1 — Internal P2P marketplace: the architectural fork to decide

Chips are Metaplex Core assets (unique); tickets are SPL (fungible, decimals 0) — **different listing shapes; ship chips first, tickets later.**

The fork is **where the marketplace lives**, and one measured fact decides much of it:

> **`ArenaConfig._reserved` is EXHAUSTED — verified, `battle-arena/src/lib.rs:1757` is literally `pub _reserved: [u8; 0]`.**  SEC-20's 64-byte forward-compat trailer was fully consumed: 32 bytes by `vrf_program` (SEC-21) + 32 by `ticket_mint` (SEC-23).  So **any** new `ArenaConfig` field (`market_fee_bps`, a market authority, …) is no longer free — it needs the `realloc!` migration ix that SEC-20 said to "schedule when the padding runs out".  That bill is now due for whoever touches ArenaConfig next.  (`TreasuryConfig` and `ChipNftConfig` still have their full `[u8; 64]` — lines 1860 / 1963.)

- **Option A — inside `battle_arena`**: can debit/credit `UserAccount.balance` with no CPI.  Costs: the `realloc!` migration above, plus more `Accounts` structs in a program that already needed `Box<Account<>>` everywhere to survive the 4 KB BPF stack (SEC-23).
- **Option B — separate `marketplace` program (RECOMMENDED)**: own config account (fresh padding, no migration), keeps battle_arena untouched, and follows the pattern SEC-26 already proved — a separate program that reads arena account bytes permissionlessly instead of taking a CPI.  Payment is then direct wallet→wallet SOL, which is also what "fully decentralized / no custody" wants.  Trade-off: buyer signs a real wallet popup per purchase — acceptable, since a purchase is a deliberate one-off, unlike the per-battle popups the internal ledger exists to avoid.
- **Escrow on `make_listing`** (chip → a `market_authority` PDA) rather than verify-owner-at-fill: guarantees `fill_listing` can't fail on a stale listing, and reuses the escrow pattern battles already use with `chip_authority`.  Check it does not collide with the battle escrow — a listed chip must not be joinable into a battle, and vice versa.
- **SEC-26 synergy is real, not incidental**: `ChipData.progression_wins` / `tier` live per-chip and travel with the asset on transfer — the SEC-26 section calls this out as deliberate ("a leveled chip is a tradable asset (P2P synergy)").  A promoted T3/T4 chip is the thing that makes a secondary market worth having.
- Indexer needs a `listings` table + handlers + REST/WS topics; frontend needs a market page.  Fee on fill → treasury, mirroring the battle fee.

#### A2 — Fiat on-ramp as a LINK + tutorial (scope locked 2026-07-25)

User's words: *"просто ссылка на ресурс покупки и возможно небольшой туториал как пользоваться."*  **No embedded widget, no SDK, no partner API key.**  Just outbound links to existing on-ramp sites plus a couple of tutorial steps.

**This dissolves both blockers that parked the SDK version** — recorded here so nobody "upgrades" it back into an integration without re-reading them:
- *Provider KYB gating betting dApps* — irrelevant now.  We are not onboarding as a partner, so nobody reviews the project.  Linking to a public site needs no permission.
- *Ramps only deliver mainnet tokens* — no longer blocking, because there is nothing to test end-to-end.  It just means the on-ramp step is **mainnet-only content**, which the codebase already knows how to express (see below).  On devnet the answer stays the faucet.

**Implementation home: `HelpModal.tsx` — it is already exactly this component.**  SEC-24 built it cluster-aware: `isDevnet = CLUSTER !== "mainnet"` ([HelpModal.tsx:56](chiptap-solana-frontend/src/components/HelpModal.tsx:56)), and the devnet faucet step at [:104-115](chiptap-solana-frontend/src/components/HelpModal.tsx:104) is the **mirror-image template** for the new step — hardcoded URL constant, `retro-btn` anchor with `target="_blank" rel="noreferrer"`, wrapped in `{isDevnet && …}`.  The on-ramp step is the same thing under `{!isDevnet && …}`.

Nice side effect: the step-number shifting at [:61-65](chiptap-solana-frontend/src/components/HelpModal.tsx:61) (`sMint = isDevnet ? 3 : 2`, etc., there because mainnet has no faucet step) becomes **unnecessary** once mainnet gains a step-2 of its own — both clusters then have the same step count, so those four consts collapse to plain `3/4/5/6`.  Do that cleanup in the same pass instead of adding a second conditional on top.

**Editorial rules — get these right, they're the only real risk in an otherwise trivial task:**
1. **Plain links, NOT affiliate/referral links.**  Commission would turn a neutral pointer into a monetized recommendation, re-create the very partner relationship this approach avoids, and pull in disclosure duties.  Keep it unpaid.
2. **List several providers, not one.**  Coverage is wildly uneven per country and the product is explicitly global — a single MoonPay link is a dead end for a large share of users.  Either name 2-3 well-known ones or link a neutral comparison/aggregator, and say plainly that availability depends on country.
3. **Neutral framing, no endorsement, no financial advice.**  "Common ways to buy SOL — availability and fees vary by country; check for yourself."  Never imply the project vets or backs them.
4. **Hardcode the URLs** as constants (like `faucetUrl`) or in `config/` — never build them from user input, and keep `rel="noreferrer"`.  Show the bare domain in the copy too, so users learn the real domain and phishing lookalikes stand out.

**i18n is the actual bulk of the work, not the link.**  New `help.*` keys must be mirrored across all 6 locales and the Zpix subset re-run — follow the 4-step checklist in the SEC-25 section.  Shipping this English-only would break the mirrored-key discipline (parity was 293 keys × 6 at SEC-26).

**Off-ramp (SOL → fiat) is NOT covered by this** and needs no work: withdrawing to one's own wallet and exiting via a CEX is already the honest answer for a non-custodial app.  At most, one tutorial sentence saying so.

#### A2-bis — Operating a fiat↔SOL P2P exchange ourselves (raised 2026-07-25, PARKED by user)

User's ask, verbatim: *"мне нужен обмен P2P sol чтобы выступить в качестве регулятора я должен держать sol пользователей"*, clarified as **фиат → SOL**.  I.e. users trade fiat for SOL with each other, the project escrows the SOL and arbitrates disputes.  **User's decision after the trade-offs were laid out: DON'T BUILD YET — understand it first.**  Nothing here is scheduled.  Recorded so it isn't re-litigated or accidentally started.

**Why this is categorically different from everything else in this repo — the line is not "do we hold SOL", it is "who decides".**  `arena_vault` already holds player lamports, but *code* governs withdrawal; no human can redirect another person's funds.  The moment a human arbitrates who receives disputed money, that is custody of client funds plus transmission-on-decision — the licensed activity itself.

**The arbiter exists only because of the fiat leg.**  A chain cannot verify that a bank transfer arrived, so a human must confirm it, which is what creates disputes.  When both legs are on-chain the swap is **atomic** — nothing to dispute, no arbiter needed.  That is exactly why SEC-27 is built the way it is.

**What operating it would actually require** (so it can be priced honestly — this is a company, not a feature):
- Authorization per jurisdiction served: MiCA CASP in the EU, FinCEN MSB + state money-transmitter licences in the US, FCA registration in the UK, etc.  "Global" is the *hardest* answer — either authorization in every served market or hard geo-fencing.
- A real AML programme: KYC onboarding, sanctions screening, transaction monitoring, suspicious-activity reporting, a named compliance officer.
- Client-money safeguarding: segregated accounts, reconciliation, audits.
- Capital requirements, often a bond or insurance.
- A banking/payment partner willing to serve a crypto exchange — in practice the hardest step, and many refuse anything gambling-adjacent outright.
- The "arbiter" is a **staffed 24/7 support function**, not an instruction.
- Operating unlicensed where a licence is required is frequently criminal, not merely a fine.  And this would stack a second regulated activity on top of a real-money betting game.

**Three questions that must be answered before any design work** (in this order — nothing downstream is answerable without them): (1) legal entity + jurisdiction, and which users are served; (2) custodial or not — there is no technical trick that removes custody once a human decides disputes; (3) is the exchange inside the game or a separate product/entity?  Bundling an exchange with gambling multiplies regulatory surface and repels banking partners.

**The middle path worth exploring instead — most likely what actually serves the goal.**  If the motive is earning from the exchange rather than being the exchange: a **revenue-share / white-label arrangement with an already-licensed provider**, where the partner holds funds, does KYC and runs the dispute desk under their own licence, and we take a cut.  Keeps the licence off us.  Caveat: this reintroduces the provider-KYB gate from A2 (gambling adjacency may still get us refused), so probe a provider early.  Honest math for now: at friends-test scale, compliance + support cost dwarfs any spread — this only pays at real volume.

**Still open (backlog #3, separate from A2):** the wallet-onboarding half — embedded wallet (Privy/Web3Auth, Google/email auth, no seed phrase) and/or a sponsored `welcome_grant`.  Testable on devnet today, no provider dependency.  Honest tension to raise before picking it up: a custodial-key embedded wallet trades against the self-custody half of the decentralization stance — evaluate the non-custodial/embedded-key mode, not delegated custody.

**Friends-test is the near-term goal** (not public launch). Sequencing rec (not locked): Fly.io relayer → then Web2 onramp / referral / visual polish per user priority. Mainnet is far off, gated on audit + the legal reality of a real-money provably-fair betting game (flagged to user; external, non-technical blocker).

**Browser note:** user's default browser is Yandex; they installed **Google Chrome + the Claude extension** this session (used it to drive the Render dashboard). For future wallet-gated screenshots (design pass), the extension works but the user must be logged into the target site IN Chrome (their Render/Vercel sessions live in Yandex separately).
