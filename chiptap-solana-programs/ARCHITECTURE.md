# ChipTap on Solana — Architecture

> Single source of truth for design decisions. Read this before changing any
> program or account layout — accounts are forward-incompatible without a
> migration.

## Goals

1. Preserve the EVM v2 game loop:
   `mint → create battle → join → VRF → claim/forfeit/pay-ransom → withdraw winnings`.
2. Trustless: every state transition is on-chain. No off-chain ledger, no
   custodial vault held by a server.
3. Smooth UX on mobile: minimise wallet popups during a session by holding
   per-user balances in a PDA, so SOL doesn't physically move on every action.
4. Marketplace-compatible chips (Metaplex Core).

## Programs (Anchor 0.30, Solana 1.18)

```
┌─────────────┐   mint Asset    ┌──────────────┐
│ chip_nft    │────────────────▶│ Metaplex Core│
│             │                 └──────────────┘
│  • mint()   │
│  • record() │  battle stats
└─────┬───────┘
      │ CPI: stats update
      ▼
┌──────────────────────────────────┐
│ battle_arena                     │
│                                  │
│  PDAs:                           │
│   • Battle (one per battle)      │
│   • UserAccount (one per player) │
│   • ArenaConfig (singleton)      │
│   • EscrowVault (program-owned)  │
│                                  │
│  RPC:                            │
│   create_battle / join_battle    │
│   fulfill_vrf (mock or sb-cpi)   │
│   claim_winner_chip              │
│   pay_ransom                     │
│   forfeit_chip                   │
│   force_resolve                  │
│   expire_decision / expire_join  │
│   deposit / withdraw             │
└─────────┬────────────────────────┘
          │ CPI: fee transfer
          ▼
┌──────────────────────────────────┐
│ treasury                         │
│  • PDA vault collects 5% of pots │
│  • owner withdraw                │
└──────────────────────────────────┘
```

## Account model (key decisions)

### `UserAccount` PDA — the heart of the UX win
Seeds: `[b"user", authority.key()]`

```
pub struct UserAccount {
    pub authority: Pubkey,    // wallet that owns this account
    pub balance:   u64,       // free lamports the user can spend
    pub locked:    u64,       // lamports locked in active battles
    pub bump:      u8,
}
```

* `deposit(amount)` — moves SOL from `authority` into the program's
  `EscrowVault` PDA, increments `balance`.
* `withdraw(amount)` — decrements `balance`, transfers from vault back to
  `authority`. (Cannot drop below `locked`.)
* Battle entry: deducts from `balance` into `locked` — **no SOL movement**.
* Battle settle:
  * Loser pays ransom: ransom is moved from loser.locked → winner.balance.
    Treasury 5% from loser.locked. Both via `u64` arithmetic on PDAs;
    no actual SOL transfer until `withdraw`.
  * Forfeit: `locked` is released back to `balance` for both (no SOL movement).
* Net effect: **3 popups** per battle (create, join, finish-action) instead of
  5–6 with full on-chain SOL transfers. Trust model unchanged.

### `Battle` PDA
Seeds: `[b"battle", arena_config.next_battle_id.to_le_bytes()]`

Mirrors the EVM struct closely, but `chip_a` / `chip_b` are now `Pubkey` of
Metaplex Core Asset accounts (not uint256).

### `EscrowVault` PDA (singleton, program-owned)
Seeds: `[b"vault"]`

Holds **all** deposited SOL in one account. Deposits/withdrawals go through it.
Internal balances tracked per-user in `UserAccount`. This is cheaper rent-wise
than per-user SOL accounts.

### `ChipMintRegistry` PDA (per-chip-asset metadata)
Seeds: `[b"chip", asset.key()]`

```
pub struct ChipData {
    pub rarity:        u8,
    pub minted_at:     i64,
    pub battle_count:  u32,
    pub win_count:     u32,
    pub bump:          u8,
}
```

We keep stats off-Asset so we don't bloat Metaplex Core data and don't pay
the higher rent for plugins. Stats live in our own program.

## Pricing

**Fixed lamport amounts** for both mint prices and battle pool tiers — no
oracle dependency. Owner-configurable via setter instructions.

Default pool tiers (1 SOL = 1_000_000_000 lamports):

| Tier      | Lamports        | SOL  |
|-----------|-----------------|------|
| POOL_05   | 50_000_000      | 0.05 |
| POOL_10   | 100_000_000     | 0.1  |
| POOL_25   | 250_000_000     | 0.25 |
| POOL_50   | 500_000_000     | 0.5  |
| POOL_100  | 1_000_000_000   | 1.0  |
| POOL_500  | 5_000_000_000   | 5.0  |

Default mint prices (mirrors EVM tier ratios 2/10/40/100/400):

| Rarity     | Lamports        | SOL  |
|------------|-----------------|------|
| Common     | 20_000_000      | 0.02 |
| Uncommon   | 100_000_000     | 0.1  |
| Rare       | 400_000_000     | 0.4  |
| Epic       | 1_000_000_000   | 1.0  |
| Legendary  | 4_000_000_000   | 4.0  |

Why no oracle: Pyth integration adds 1-2 days of work (CPI to receiver-program,
stale-feed checks, devnet/mainnet feed key wrangling) for marginal benefit on
this game. If SOL price swings substantially, owner updates the constants via
`set_pool_amount` / `set_mint_price`.

## Randomness

Two backends behind a feature flag in `battle_arena`:

* `mock-vrf` (default for localnet/devnet smoke):
  * `fulfill_random_words(request_id, [u64])` callable by anyone in tests
  * mirrors current `MockVRFCoordinator.fulfillRandomWords` API
* `switchboard` (mainnet):
  * Switchboard On-Demand Randomness — pull-based, two-tx commit/reveal
  * Same `fulfill_random_words` callback signature; the dispatcher just
    swaps the trusted authority

This way the game logic and tests stay identical; only the entry point to
fulfillment changes per env.

## Security parity with EVM v2

| EVM fix | Solana port |
|---|---|
| FIX-1 VRF timeout (`forceResolve`) | `force_resolve(battle_id)` — same idea, anyone can call after `vrf_timeout`. Both `chip_a` and `chip_b` Asset transfers refunded; users' `locked` lamports released. |
| FIX-2 Pull-payment | Built into the `UserAccount` model: ransom credits `winner.balance` (not push). `withdraw()` is the only path SOL leaves the vault. |
| FIX-3 Minimal VRF callback | `fulfill_vrf` only writes `random_seed`, `winner`, `loser` to `Battle`. NFT transfer happens in `claim_winner_chip`. |

Plus Solana-native concerns:

* PDA-only signing for `EscrowVault` — no one can drain it.
* `#[derive(Accounts)]` `has_one` constraints on `authority` everywhere.
* Reentrancy not a concern (Solana has no reentrancy in CPI).
* Unique-by-address `UserAccount`/`Battle` PDAs — can't be spoofed.

## Cost model on mainnet

| Action | Tx | Rent | Total (~$160 SOL) |
|---|---|---|---|
| First `deposit` (creates `UserAccount`) | 5000 lamports | ~0.0024 SOL | $0.40 |
| `mint_chip` (creates Asset + `ChipData`) | 5000 | ~0.0035 + 0.001 | $0.74 |
| `create_battle` | 5000 | 0.002 | $0.32 |
| `join_battle` | 5000 | 0 | $0.0008 |
| `claim_winner_chip` | 5000 | 0 | $0.0008 |
| `withdraw` | 5000 | 0 | $0.0008 |

**Per-battle marginal cost (after onboarding): ~$0.32 once for the Battle PDA,
then $0.003 per subsequent battle if Battle PDAs are reaped.** Acceptable.

## What is NOT in v1

* Switchboard VRF integration (stub for mainnet)
* Compressed NFTs
* Cross-program upgrades / Squads multisig owner
* Session keys (delegated authority) — would cut popups further but adds
  complexity. Defer to v2.
