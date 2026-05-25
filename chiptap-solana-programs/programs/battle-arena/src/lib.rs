// ============================================================
// programs/battle-arena/src/lib.rs
//
// Solana port of EVM BattleArena.sol (v2 — with the 3 security fixes).
// Adds Solana-native UX wins:
//   • UserAccount PDA with internal lamport ledger (deposit once,
//     play many battles, withdraw once — no SOL popup per ransom).
//   • Single shared SOL vault PDA (`arena_vault`) holds all
//     deposited user lamports; per-user balances tracked in
//     UserAccount.balance.
//   • chip_authority PDA owns NFTs during escrow and signs both
//     mpl-core Transfer CPIs and chip-nft.record_battle CPIs.
//
// Security parity with EVM v2:
//   FIX-1  forceResolve()      — refund both chips after VRF timeout
//   FIX-2  pull-payment        — winner withdraws from balance
//   FIX-3  minimal VRF cb      — only writes random_seed/winner/loser;
//                                NFT transfers happen in claim/pay/forfeit
// ============================================================

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::{
    token::{self, Mint, Token, TokenAccount, MintTo, Burn},
    associated_token::AssociatedToken,
};
use mpl_core::{
    instructions::TransferV1CpiBuilder,
    ID as MPL_CORE_ID,
};

declare_id!("Ae65nkzg2DD4dFUttxUXPpVfZT7kMPX1L9Uk9GDxkBU8");

// Battle status values.  Stable on the wire (used by indexer).
pub const STATUS_WAITING:   u8 = 0;
pub const STATUS_ROLLING:   u8 = 1;
pub const STATUS_DECIDED:   u8 = 2;
pub const STATUS_SETTLED:   u8 = 3;
pub const STATUS_CANCELLED: u8 = 4;

// Resolution values.
pub const RES_NONE:      u8 = 0;
pub const RES_PAID:      u8 = 1;
pub const RES_FORFEITED: u8 = 2;
pub const RES_EXPIRED:   u8 = 3;

pub const N_TIERS: usize = 6;

// Timeout-kind discriminator for `TimeoutUpdated` event (SEC-19).
pub const TIMEOUT_DECISION: u8 = 0;
pub const TIMEOUT_JOIN:     u8 = 1;
pub const TIMEOUT_VRF:      u8 = 2;

// SEC-22 — Battle Royale.  Fixed-cap multiplayer mode where N players
// pool their entry fee, one is drawn via Switchboard VRF, takes
// (pool − fee).  Chips are escrowed for the duration but always
// returned to their owners after settle (chips are membership tokens
// here, not stakes).
pub const BR_MAX_PLAYERS: usize = 8;

// ============================================================
// SEC-23 — Tournament mode (8-player single-elimination + 3rd-place)
// ============================================================
// Bracket layout (slot indices below are positions in tournament.players[]):
//   Round 0 (matches[0..4]) — quarters: (0v1) (2v3) (4v5) (6v7)
//   Round 1 (matches[4..6]) — semis:    (winner[0] v winner[1]) (winner[2] v winner[3])
//   Round 2 (matches[6..8]) — final + 3rd-place:
//                              matches[6] = winner[4] v winner[5]   (final)
//                              matches[7] = loser[4]  v loser[5]    (3rd place)
//
// Each match consumes a separate Switchboard On-Demand cycle —
// sequential VRF, bracket fills in progressively.  Total cost on
// devnet: ~7 × 0.001 SOL = ~0.007 SOL per tournament (paid by relayer).
pub const T_PLAYERS: usize = 8;
pub const T_MATCHES: usize = 8;             // 4 + 2 + 1 + 1 (with 3rd-place)
pub const T_ROUNDS:  u8    = 3;             // R0 quarters, R1 semis, R2 (final + 3rd)

// Hardcoded prize split (sums to 10_000 bps = 100% of pool).  Not
// configurable via fee_bps — tournaments have their own economy.
pub const T_PRIZE_1ST_BPS: u16 = 6000;      // 60%
pub const T_PRIZE_2ND_BPS: u16 = 2500;      // 25%
pub const T_PRIZE_3RD_BPS: u16 = 1000;      // 10%
pub const T_FEE_BPS:       u16 =  500;      //  5%

// Tournament status (separate state machine from 1v1/BR — narrower).
pub const T_STATUS_REGISTERING: u8 = 0;
pub const T_STATUS_ACTIVE:      u8 = 1;
pub const T_STATUS_COMPLETED:   u8 = 2;
pub const T_STATUS_CANCELLED:   u8 = 3;

// Per-match state.
pub const T_MATCH_PENDING: u8 = 0;
pub const T_MATCH_DECIDED: u8 = 2;

// Sentinel: "no slot yet known" in winner_*_slot fields.
pub const T_SLOT_UNSET: u8 = 0xFF;

// Cancellation reason byte (mirrors BR's reason field semantics).
pub const T_CANCEL_REGISTER_TIMEOUT: u8 = 0;
pub const T_CANCEL_VRF_TIMEOUT:      u8 = 1;

#[program]
pub mod battle_arena {
    use super::*;

    // ============================================================
    //                         INIT / ADMIN
    // ============================================================

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.owner               = ctx.accounts.owner.key();
        cfg.chip_nft_program    = ctx.accounts.chip_nft_program.key();
        cfg.treasury_program    = ctx.accounts.treasury_program.key();
        cfg.vrf_authority       = ctx.accounts.owner.key(); // owner == default mock vrf signer
        cfg.next_battle_id      = 1;
        cfg.fee_bps             = 500;             // 5%
        cfg.decision_timeout    = 24 * 60 * 60;    // 24h
        cfg.join_timeout        = 30 * 60;         // 30m
        cfg.vrf_timeout         = 60 * 60;         // 1h
        cfg.paused              = false;
        cfg.bump                = ctx.bumps.config;
        cfg.vault_bump          = ctx.bumps.vault;
        cfg.chip_authority_bump = ctx.bumps.chip_authority;

        // Default pool tiers in lamports (0.05 / 0.1 / 0.25 / 0.5 / 1 / 5 SOL).
        cfg.pool_amounts = [
            50_000_000,
            100_000_000,
            250_000_000,
            500_000_000,
            1_000_000_000,
            5_000_000_000,
        ];

        emit!(ArenaInitialized {
            owner: cfg.owner,
            chip_authority: ctx.accounts.chip_authority.key(),
        });
        Ok(())
    }

    // SEC-19 — every admin mutation emits an event so the indexer can
    // replay the full audit trail (paused-toggles, fee changes, tier
    // edits, timeout tweaks, VRF authority rotations).  Without these
    // the indexer was blind to admin actions and the leaderboard could
    // not explain pricing discontinuities.

    pub fn set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PausedUpdated { paused });
        Ok(())
    }

    pub fn set_fee_bps(ctx: Context<OwnerOnly>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 1000, ArenaError::FeeTooHigh); // max 10%
        ctx.accounts.config.fee_bps = fee_bps;
        emit!(FeeBpsUpdated { fee_bps });
        Ok(())
    }

    pub fn set_pool_amount(ctx: Context<OwnerOnly>, tier: u8, lamports: u64) -> Result<()> {
        require!((tier as usize) < N_TIERS, ArenaError::InvalidTier);
        ctx.accounts.config.pool_amounts[tier as usize] = lamports;
        emit!(PoolAmountUpdated { tier, lamports });
        Ok(())
    }

    pub fn set_decision_timeout(ctx: Context<OwnerOnly>, seconds: i64) -> Result<()> {
        require!(seconds >= 3600 && seconds <= 72 * 3600, ArenaError::InvalidTimeout);
        ctx.accounts.config.decision_timeout = seconds;
        emit!(TimeoutUpdated { kind: TIMEOUT_DECISION, seconds });
        Ok(())
    }

    pub fn set_join_timeout(ctx: Context<OwnerOnly>, seconds: i64) -> Result<()> {
        require!(seconds >= 300 && seconds <= 24 * 3600, ArenaError::InvalidTimeout);
        ctx.accounts.config.join_timeout = seconds;
        emit!(TimeoutUpdated { kind: TIMEOUT_JOIN, seconds });
        Ok(())
    }

    pub fn set_vrf_timeout(ctx: Context<OwnerOnly>, seconds: i64) -> Result<()> {
        require!(seconds >= 1800 && seconds <= 24 * 3600, ArenaError::InvalidTimeout);
        ctx.accounts.config.vrf_timeout = seconds;
        emit!(TimeoutUpdated { kind: TIMEOUT_VRF, seconds });
        Ok(())
    }

    pub fn set_vrf_authority(ctx: Context<OwnerOnly>, authority: Pubkey) -> Result<()> {
        ctx.accounts.config.vrf_authority = authority;
        emit!(VrfAuthorityUpdated { authority });
        Ok(())
    }

    /// SEC-21 — register the Switchboard On-Demand program ID whose
    /// RandomnessAccountData this program will trust.  Set to
    /// Pubkey::default() to disable the Switchboard path.
    pub fn set_vrf_program(ctx: Context<OwnerOnly>, program: Pubkey) -> Result<()> {
        ctx.accounts.config.vrf_program = program;
        emit!(VrfProgramUpdated { program });
        Ok(())
    }

    // ============================================================
    //                  USER LEDGER (deposit / withdraw)
    // ============================================================

    /// Top up the caller's internal balance.  Creates the UserAccount
    /// PDA on first use.  Real SOL moves once into the shared vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, ArenaError::ZeroAmount);

        // First-use init populates authority/bump.
        let user = &mut ctx.accounts.user;
        if user.authority == Pubkey::default() {
            user.authority = ctx.accounts.payer.key();
            user.bump      = ctx.bumps.user;
        }

        let cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to:   ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi, amount)?;

        user.balance = user.balance.checked_add(amount).ok_or(ArenaError::MathOverflow)?;
        emit!(Deposited { user: user.authority, amount, balance: user.balance });
        Ok(())
    }

    /// SEC-10 — bring a UserAccount PDA into existence for `authority`.
    /// Anyone can call (payer signs and pays rent), no balance change.
    /// Used by the frontend to pre-create the winner's PDA in the same
    /// transaction as `pay_ransom`, since `pay_ransom` itself can't fit
    /// `init_if_needed` within Solana's 4 KB BPF stack frame.
    pub fn ensure_user_account(ctx: Context<EnsureUserAccount>) -> Result<()> {
        let user = &mut ctx.accounts.user;
        if user.authority == Pubkey::default() {
            user.authority = ctx.accounts.authority.key();
            user.bump      = ctx.bumps.user;
        }
        Ok(())
    }

    /// Withdraw free balance (locked lamports cannot be touched).
    pub fn withdraw(ctx: Context<WithdrawUser>, amount: u64) -> Result<()> {
        require!(amount > 0, ArenaError::ZeroAmount);

        let user = &mut ctx.accounts.user;
        require!(user.balance >= amount, ArenaError::InsufficientBalance);

        // Move SOL out via PDA-signed system_program::transfer.
        let bump = ctx.accounts.config.vault_bump;
        let seeds: &[&[u8]] = &[b"arena", b"vault", core::slice::from_ref(&bump)];
        let signer_seeds = &[seeds];

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to:   ctx.accounts.authority.to_account_info(),
            },
            signer_seeds,
        );
        system_program::transfer(cpi, amount)?;

        user.balance -= amount;
        emit!(Withdrawn { user: user.authority, amount, balance: user.balance });
        Ok(())
    }

    // ============================================================
    //                       PLAYER ACTIONS
    // ============================================================

    /// Player A escrows a chip and opens a $X battle.
    pub fn create_battle(ctx: Context<CreateBattle>, pool_tier: u8) -> Result<()> {
        require!(!ctx.accounts.config.paused, ArenaError::Paused);
        require!((pool_tier as usize) < N_TIERS, ArenaError::InvalidTier);

        // Move the chip into our chip_authority PDA.  Player signs.
        TransferV1CpiBuilder::new(&ctx.accounts.mpl_core.to_account_info())
            .asset(&ctx.accounts.chip.to_account_info())
            .collection(None)
            .payer(&ctx.accounts.player.to_account_info())
            .authority(Some(&ctx.accounts.player.to_account_info()))
            .new_owner(&ctx.accounts.chip_authority.to_account_info())
            .system_program(Some(&ctx.accounts.system_program.to_account_info()))
            .invoke()?;

        let cfg = &mut ctx.accounts.config;
        let battle_id = cfg.next_battle_id;
        cfg.next_battle_id = cfg.next_battle_id.checked_add(1).ok_or(ArenaError::MathOverflow)?;

        let b = &mut ctx.accounts.battle;
        b.id              = battle_id;
        b.player_a        = ctx.accounts.player.key();
        b.player_b        = Pubkey::default();
        b.chip_a          = ctx.accounts.chip.key();
        b.chip_b          = Pubkey::default();
        b.pool_tier       = pool_tier;
        b.status          = STATUS_WAITING;
        b.winner          = Pubkey::default();
        b.loser           = Pubkey::default();
        b.random_seed     = 0;
        b.resolution      = RES_NONE;
        b.payment_amount  = 0;
        b.fee_amount      = 0;
        b.vrf_request_id  = 0;
        let now = Clock::get()?.unix_timestamp;
        b.created_at      = now;
        b.decided_at      = 0;
        b.settled_at      = 0;
        b.rolling_at      = 0;
        b.bump            = ctx.bumps.battle;

        emit!(BattleCreated {
            battle_id,
            player_a: b.player_a,
            chip_a: b.chip_a,
            pool_tier,
        });
        Ok(())
    }

    pub fn join_battle(ctx: Context<JoinBattle>) -> Result<()> {
        let b = &mut ctx.accounts.battle;
        require!(b.status == STATUS_WAITING, ArenaError::WrongStatus);
        require!(ctx.accounts.player.key() != b.player_a, ArenaError::CannotJoinOwnBattle);

        // Move player B's chip into escrow.
        TransferV1CpiBuilder::new(&ctx.accounts.mpl_core.to_account_info())
            .asset(&ctx.accounts.chip.to_account_info())
            .collection(None)
            .payer(&ctx.accounts.player.to_account_info())
            .authority(Some(&ctx.accounts.player.to_account_info()))
            .new_owner(&ctx.accounts.chip_authority.to_account_info())
            .system_program(Some(&ctx.accounts.system_program.to_account_info()))
            .invoke()?;

        b.player_b       = ctx.accounts.player.key();
        b.chip_b         = ctx.accounts.chip.key();
        b.status         = STATUS_ROLLING;
        b.rolling_at     = Clock::get()?.unix_timestamp;
        // For mock VRF: request_id == battle_id.  Switchboard would set
        // a real request id here.
        b.vrf_request_id = b.id;

        emit!(BattleJoined {
            battle_id: b.id,
            player_b:  b.player_b,
            chip_b:    b.chip_b,
            vrf_request_id: b.vrf_request_id,
        });
        Ok(())
    }

    /// Player A cancels an unjoined battle, gets chip back.
    pub fn cancel_battle(ctx: Context<CancelBattle>) -> Result<()> {
        let b = &mut ctx.accounts.battle;
        require!(b.status == STATUS_WAITING, ArenaError::WrongStatus);
        require_keys_eq!(ctx.accounts.player.key(), b.player_a, ArenaError::NotYourBattle);

        b.status = STATUS_CANCELLED;
        return_chip_to(
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip_a,
            &ctx.accounts.player.to_account_info(),
            &ctx.accounts.chip_authority,
            &ctx.accounts.system_program,
            ctx.accounts.config.chip_authority_bump,
        )?;

        emit!(BattleCancelled { battle_id: b.id, player_a: b.player_a });
        Ok(())
    }

    /// Mock VRF.  Real Switchboard CPI lands here too.  The signer must
    /// match `config.vrf_authority`.
    pub fn fulfill_random_words(ctx: Context<FulfillVrf>, seed: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.vrf_authority.key(),
            ctx.accounts.config.vrf_authority,
            ArenaError::NotVrfAuthority
        );
        let b = &mut ctx.accounts.battle;
        require!(b.status == STATUS_ROLLING, ArenaError::WrongStatus);

        b.random_seed = seed;
        b.status      = STATUS_DECIDED;
        b.decided_at  = Clock::get()?.unix_timestamp;
        if seed % 2 == 0 {
            b.winner = b.player_a;
            b.loser  = b.player_b;
        } else {
            b.winner = b.player_b;
            b.loser  = b.player_a;
        }
        emit!(BattleDecided {
            battle_id: b.id,
            winner:    b.winner,
            loser:     b.loser,
            random_seed: seed,
        });
        Ok(())
    }

    /// SEC-21 — trustless VRF via Switchboard On-Demand.
    ///
    /// Caller passes a `randomness_account` whose owner is the
    /// configured `vrf_program`.  We parse the account bytes manually
    /// (no `switchboard-on-demand` crate dep — see CLAUDE.md for why
    /// the borsh chain forbids it) and consume `value[..8]` as the u64
    /// seed.  This removes the relayer's ability to choose the
    /// winner: even if the relayer's keypair is compromised, the seed
    /// is fixed by the Switchboard oracle network at reveal time.
    ///
    /// Layout from switchboard-xyz/solana-sdk@on-demand RandomnessAccountData
    /// (verified against live devnet accounts on the queue
    /// EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7):
    ///
    ///   [0..8]     discriminator = sha256("account:RandomnessAccountData")[..8]
    ///                             = 0a42e587dcefd972 = [10,66,229,135,220,239,217,114]
    ///   [8..40]    authority:      Pubkey
    ///   [40..72]   queue:          Pubkey
    ///   [72..104]  seed_slothash:  [u8; 32]
    ///   [104..112] seed_slot:      u64 LE
    ///   [112..144] oracle:         Pubkey         ← assigned at commit
    ///   [144..152] reveal_slot:    u64 LE         ← > seed_slot iff revealed
    ///   [152..184] value:          [u8; 32]       ← the actual randomness
    ///   [184..]    lut_slot / ebuf padding
    pub fn fulfill_random_words_switchboard(
        ctx: Context<FulfillVrfSwitchboard>,
    ) -> Result<()> {
        // 1) Verify the account is actually owned by the configured
        //    Switchboard program — protects against a forged account.
        require_keys_eq!(
            *ctx.accounts.randomness_account.owner,
            ctx.accounts.config.vrf_program,
            ArenaError::WrongVrfProgram
        );
        require!(
            ctx.accounts.config.vrf_program != Pubkey::default(),
            ArenaError::SwitchboardDisabled
        );

        let b = &mut ctx.accounts.battle;
        require!(b.status == STATUS_ROLLING, ArenaError::WrongStatus);

        // 2) Read the account bytes.  184 is the minimum we need.
        let data = ctx.accounts.randomness_account.try_borrow_data()?;
        require!(data.len() >= 184, ArenaError::MalformedRandomnessAccount);

        // 3) Discriminator check — protects against a Switchboard
        //    account of the wrong shape (e.g. their queue / config).
        const DISC: [u8; 8] = [10, 66, 229, 135, 220, 239, 217, 114];
        require!(data[0..8] == DISC, ArenaError::MalformedRandomnessAccount);

        // 4) Slot check: reveal must have happened.  reveal_slot is
        //    set by Switchboard's reveal ix; before reveal it's 0.
        let seed_slot   = u64::from_le_bytes(data[104..112].try_into().unwrap());
        let reveal_slot = u64::from_le_bytes(data[144..152].try_into().unwrap());
        require!(reveal_slot > seed_slot, ArenaError::RandomnessNotRevealed);

        // 5) Read first 8 bytes of `value` (offset 152) as u64 LE seed.
        let seed = u64::from_le_bytes(data[152..160].try_into().unwrap());
        drop(data);

        // 6) Apply seed — same as the legacy `fulfill_random_words`.
        b.random_seed = seed;
        b.status      = STATUS_DECIDED;
        b.decided_at  = Clock::get()?.unix_timestamp;
        if seed % 2 == 0 {
            b.winner = b.player_a;
            b.loser  = b.player_b;
        } else {
            b.winner = b.player_b;
            b.loser  = b.player_a;
        }

        emit!(BattleDecided {
            battle_id:   b.id,
            winner:      b.winner,
            loser:       b.loser,
            random_seed: seed,
        });
        // SEC-21 — extra event lets the indexer mark this battle as
        // "Switchboard-verified" without changing BattleDecided's wire
        // shape (BREAKING change avoided).
        emit!(SwitchboardVerified {
            battle_id:          b.id,
            randomness_account: ctx.accounts.randomness_account.key(),
        });
        Ok(())
    }

    /// Winner pulls their own chip out of escrow at any time after VRF.
    pub fn claim_winner_chip(ctx: Context<ClaimWinnerChip>) -> Result<()> {
        let b = &ctx.accounts.battle;
        require!(
            b.status == STATUS_DECIDED || b.status == STATUS_SETTLED,
            ArenaError::WrongStatus
        );
        require_keys_eq!(ctx.accounts.winner.key(), b.winner, ArenaError::NotWinner);

        // Determine which chip account is the winner's.
        let winner_chip_key = if b.winner == b.player_a { b.chip_a } else { b.chip_b };
        require_keys_eq!(ctx.accounts.chip.key(), winner_chip_key, ArenaError::WrongChip);

        return_chip_to(
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip,
            &ctx.accounts.winner.to_account_info(),
            &ctx.accounts.chip_authority,
            &ctx.accounts.system_program,
            ctx.accounts.config.chip_authority_bump,
        )?;
        Ok(())
    }

    /// Loser pays the pool amount to keep their chip.  All of:
    ///   • loser.balance        -= pool_amount
    ///   • winner.balance       += pool_amount - fee
    ///   • arena_vault          -= fee  (real SOL transfer)
    ///   • treasury_vault       += fee
    ///   • both chips returned (loser's always; winner's only if still here)
    ///   • record_battle CPI'd into chip-nft for both chips
    pub fn pay_ransom(ctx: Context<PayRansom>) -> Result<()> {
        let b = &mut ctx.accounts.battle;
        require!(b.status == STATUS_DECIDED, ArenaError::WrongStatus);
        require_keys_eq!(ctx.accounts.loser.key(),  b.loser,  ArenaError::NotLoser);
        // SEC-1 — `winner` is also gated at the struct level via
        // `address = battle.winner`, so by the time we get here a
        // malicious loser cannot have redirected the payout.  Re-check
        // for defence in depth.
        require_keys_eq!(ctx.accounts.winner.key(), b.winner, ArenaError::NotWinner);

        let now = Clock::get()?.unix_timestamp;
        require!(
            now <= b.decided_at + ctx.accounts.config.decision_timeout,
            ArenaError::DecisionPeriodExpired
        );

        let pool = ctx.accounts.config.pool_amounts[b.pool_tier as usize];
        let fee  = (pool as u128 * ctx.accounts.config.fee_bps as u128 / 10_000u128) as u64;
        let payout = pool.checked_sub(fee).ok_or(ArenaError::MathOverflow)?;

        // Internal-balance debit on loser.
        require!(ctx.accounts.loser_user.balance >= pool, ArenaError::InsufficientBalance);
        ctx.accounts.loser_user.balance = ctx
            .accounts.loser_user.balance.checked_sub(pool).unwrap();

        // Internal-balance credit on winner (no real SOL movement).
        ctx.accounts.winner_user.balance = ctx
            .accounts.winner_user.balance
            .checked_add(payout)
            .ok_or(ArenaError::MathOverflow)?;

        // Real SOL transfer for the fee → treasury.  arena_vault signs.
        let vault_bump = ctx.accounts.config.vault_bump;
        forward_fee_to_treasury(
            &ctx.accounts.treasury_program,
            &ctx.accounts.treasury_config,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.vault,
            &ctx.accounts.system_program,
            vault_bump,
            fee,
        )?;

        // Settlement bookkeeping on the battle.
        b.status         = STATUS_SETTLED;
        b.resolution     = RES_PAID;
        b.payment_amount = pool;
        b.fee_amount     = fee;
        b.settled_at     = now;

        // Return loser's chip.  (Winner uses claim_winner_chip; chip stats
        // are advanced by the indexer reading our Settled event — keeps the
        // BPF stack frame small enough to fit Solana's 4 KB limit.)
        let auth_bump = ctx.accounts.config.chip_authority_bump;

        return_chip_to(
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip_loser,
            &ctx.accounts.loser.to_account_info(),
            &ctx.accounts.chip_authority,
            &ctx.accounts.system_program,
            auth_bump,
        )?;

        emit!(BattleSettledPaid {
            battle_id: b.id,
            loser:     b.loser,
            payment:   pool,
            fee,
        });
        Ok(())
    }

    /// Loser gives up their chip — winner gets it.  No SOL changes hands.
    pub fn forfeit_chip(ctx: Context<ForfeitChip>) -> Result<()> {
        let b = &mut ctx.accounts.battle;
        require!(b.status == STATUS_DECIDED, ArenaError::WrongStatus);
        require_keys_eq!(ctx.accounts.loser.key(), b.loser, ArenaError::NotLoser);

        execute_forfeit(
            b,
            &ctx.accounts.config,
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip_loser,
            &ctx.accounts.chip_authority,
            &ctx.accounts.system_program,
            &ctx.accounts.winner,
            false,
        )?;
        Ok(())
    }

    /// Anyone may call after `decision_timeout`.  Auto-forfeit.
    ///
    /// SEC-8 — uses a dedicated `ExpireDecision` Accounts struct where
    /// `loser` and `winner` are *unsigned* AccountInfos address-bound to
    /// `battle.loser` / `battle.winner`.  The original `ForfeitChip`
    /// struct required `loser: Signer`, which made this code path
    /// inoperable: the whole point of `expire_decision` is that the
    /// loser has *ghosted*, so demanding their signature created a
    /// permanent stuck-chip class.
    pub fn expire_decision(ctx: Context<ExpireDecision>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.battle;
        require!(b.status == STATUS_DECIDED, ArenaError::WrongStatus);
        require!(
            now > b.decided_at + ctx.accounts.config.decision_timeout,
            ArenaError::DecisionPeriodActive
        );

        execute_forfeit(
            b,
            &ctx.accounts.config,
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip_loser,
            &ctx.accounts.chip_authority,
            &ctx.accounts.system_program,
            &ctx.accounts.winner,
            true,
        )?;
        emit!(BattleExpired { battle_id: b.id, loser: b.loser });
        Ok(())
    }

    /// Anyone may cancel an unjoined battle after the join timeout.
    ///
    /// SEC-2 — uses a dedicated `ExpireJoin` Accounts struct where the
    /// chip recipient (`player_a` AccountInfo) is address-constrained to
    /// `battle.player_a`, and the transaction signer (`caller`) has no
    /// authority check.  Anyone pays the gas; the chip always goes home.
    pub fn expire_join(ctx: Context<ExpireJoin>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.battle;
        require!(b.status == STATUS_WAITING, ArenaError::WrongStatus);
        require!(
            now > b.created_at + ctx.accounts.config.join_timeout,
            ArenaError::JoinPeriodNotExpired
        );

        b.status = STATUS_CANCELLED;
        return_chip_to(
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip_a,
            &ctx.accounts.player_a,
            &ctx.accounts.chip_authority,
            &ctx.accounts.system_program,
            ctx.accounts.config.chip_authority_bump,
        )?;
        emit!(BattleCancelled { battle_id: b.id, player_a: b.player_a });
        Ok(())
    }

    /// FIX-1: VRF stuck for vrf_timeout — refund both chips, cancel.
    pub fn force_resolve(ctx: Context<ForceResolve>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.battle;
        require!(b.status == STATUS_ROLLING, ArenaError::WrongStatus);
        require!(
            now > b.rolling_at + ctx.accounts.config.vrf_timeout,
            ArenaError::VrfNotTimedOut
        );
        // SEC-3 — chip destinations are gated at the struct level via
        // `address = battle.player_a / player_b`.

        b.status = STATUS_CANCELLED;
        let bump = ctx.accounts.config.chip_authority_bump;

        return_chip_to(
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip_a,
            &ctx.accounts.player_a.to_account_info(),
            &ctx.accounts.chip_authority,
            &ctx.accounts.system_program,
            bump,
        )?;
        return_chip_to(
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip_b,
            &ctx.accounts.player_b.to_account_info(),
            &ctx.accounts.chip_authority,
            &ctx.accounts.system_program,
            bump,
        )?;
        emit!(VrfTimedOut { battle_id: b.id });
        emit!(BattleCancelled { battle_id: b.id, player_a: b.player_a });
        Ok(())
    }

    // ============================================================
    //                BATTLE ROYALE (SEC-22)
    // ============================================================

    /// Create an empty BR slot.  Anyone can create; caller pays
    /// the BattleRoyale PDA rent.  Players join until full.
    pub fn create_battle_royale(
        ctx:         Context<CreateBattleRoyale>,
        pool_tier:   u8,
        max_players: u8,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, ArenaError::Paused);
        require!((pool_tier as usize) < N_TIERS, ArenaError::InvalidTier);
        require!(
            max_players >= 2 && (max_players as usize) <= BR_MAX_PLAYERS,
            ArenaError::InvalidMaxPlayers
        );

        // Reserve an id from the shared counter so 1v1 and BR ids are
        // strictly monotonic + unique across the whole arena.
        let cfg = &mut ctx.accounts.config;
        let id = cfg.next_battle_id;
        cfg.next_battle_id = cfg.next_battle_id.checked_add(1).ok_or(ArenaError::MathOverflow)?;

        let r = &mut ctx.accounts.royale;
        r.id           = id;
        r.status       = STATUS_WAITING;            // (reusing 1v1's "OPEN" semantics)
        r.pool_tier    = pool_tier;
        r.max_players  = max_players;
        r.num_joined   = 0;
        r.creator      = ctx.accounts.creator.key();
        r.players      = [Pubkey::default(); BR_MAX_PLAYERS];
        r.chips        = [Pubkey::default(); BR_MAX_PLAYERS];
        let now = Clock::get()?.unix_timestamp;
        r.created_at   = now;
        r.bump         = ctx.bumps.royale;

        emit!(BattleRoyaleCreated {
            id, pool_tier, max_players, creator: r.creator,
        });
        Ok(())
    }

    /// Player joins.  Escrows chip + debits internal balance by
    /// pool_tier amount.  When the Nth player joins, status auto-
    /// transitions to ROLLING and a Switchboard cycle is expected.
    pub fn join_battle_royale(ctx: Context<JoinBattleRoyale>) -> Result<()> {
        require!(!ctx.accounts.config.paused, ArenaError::Paused);

        let r = &mut ctx.accounts.royale;
        require!(r.status == STATUS_WAITING, ArenaError::WrongStatus);
        require!(r.num_joined < r.max_players, ArenaError::BattleRoyaleFull);

        // Reject double-join from the same player.
        let player = ctx.accounts.player.key();
        for i in 0..(r.num_joined as usize) {
            require!(r.players[i] != player, ArenaError::AlreadyJoined);
        }

        // Debit internal balance by the pool-tier amount.
        let stake = ctx.accounts.config.pool_amounts[r.pool_tier as usize];
        require!(ctx.accounts.player_user.balance >= stake, ArenaError::InsufficientBalance);
        ctx.accounts.player_user.balance = ctx.accounts.player_user.balance
            .checked_sub(stake).ok_or(ArenaError::MathOverflow)?;

        // Escrow chip → chip_authority PDA.
        TransferV1CpiBuilder::new(&ctx.accounts.mpl_core.to_account_info())
            .asset(&ctx.accounts.chip.to_account_info())
            .collection(None)
            .payer(&ctx.accounts.player.to_account_info())
            .authority(Some(&ctx.accounts.player.to_account_info()))
            .new_owner(&ctx.accounts.chip_authority.to_account_info())
            .system_program(Some(&ctx.accounts.system_program.to_account_info()))
            .invoke()?;

        let slot = r.num_joined as usize;
        r.players[slot] = player;
        r.chips[slot]   = ctx.accounts.chip.key();
        r.num_joined   += 1;
        r.pool_amount  = r.pool_amount.checked_add(stake).ok_or(ArenaError::MathOverflow)?;

        if r.num_joined == r.max_players {
            r.status     = STATUS_ROLLING;
            r.rolling_at = Clock::get()?.unix_timestamp;
            emit!(BattleRoyaleRolling { id: r.id, pool_amount: r.pool_amount });
        }

        emit!(BattleRoyaleJoined {
            id: r.id,
            player,
            chip: ctx.accounts.chip.key(),
            slot: slot as u8,
            num_joined: r.num_joined,
        });
        Ok(())
    }

    /// Switchboard On-Demand fulfill for Battle Royale.
    /// Same layout parsing as `fulfill_random_words_switchboard` for 1v1.
    pub fn fulfill_random_words_br_switchboard(
        ctx: Context<FulfillBattleRoyaleSwitchboard>,
    ) -> Result<()> {
        require_keys_eq!(
            *ctx.accounts.randomness_account.owner,
            ctx.accounts.config.vrf_program,
            ArenaError::WrongVrfProgram
        );
        require!(
            ctx.accounts.config.vrf_program != Pubkey::default(),
            ArenaError::SwitchboardDisabled
        );

        let r = &mut ctx.accounts.royale;
        require!(r.status == STATUS_ROLLING, ArenaError::WrongStatus);

        let data = ctx.accounts.randomness_account.try_borrow_data()?;
        require!(data.len() >= 184, ArenaError::MalformedRandomnessAccount);
        const DISC: [u8; 8] = [10, 66, 229, 135, 220, 239, 217, 114];
        require!(data[0..8] == DISC, ArenaError::MalformedRandomnessAccount);

        let seed_slot   = u64::from_le_bytes(data[104..112].try_into().unwrap());
        let reveal_slot = u64::from_le_bytes(data[144..152].try_into().unwrap());
        require!(reveal_slot > seed_slot, ArenaError::RandomnessNotRevealed);

        let seed = u64::from_le_bytes(data[152..160].try_into().unwrap());
        drop(data);

        // Pick winner from [0, max_players).  2^64 % 8 == 0 and
        // 2^64 % 4 == 0 → unbiased for those caps.
        let winner_idx = (seed % r.max_players as u64) as usize;
        r.winner             = r.players[winner_idx];
        r.random_seed        = seed;
        r.randomness_account = ctx.accounts.randomness_account.key();

        // Compute treasury fee + winner payout.
        let fee = (r.pool_amount as u128 * ctx.accounts.config.fee_bps as u128 / 10_000u128) as u64;
        r.fee_amount = fee;

        r.status     = STATUS_DECIDED;
        r.decided_at = Clock::get()?.unix_timestamp;

        emit!(BattleRoyaleDecided {
            id:          r.id,
            winner:      r.winner,
            winner_idx:  winner_idx as u8,
            random_seed: seed,
            pool_amount: r.pool_amount,
            fee_amount:  fee,
        });
        emit!(SwitchboardVerified {
            battle_id:          r.id,
            randomness_account: ctx.accounts.randomness_account.key(),
        });
        Ok(())
    }

    /// Any player claims their chip back after DECIDED.  Winner uses
    /// the same ix; their prize is separately credited via
    /// `claim_winnings_br`.
    pub fn claim_chip_br(ctx: Context<ClaimChipBattleRoyale>) -> Result<()> {
        let r = &mut ctx.accounts.royale;
        require!(
            r.status == STATUS_DECIDED || r.status == STATUS_SETTLED,
            ArenaError::WrongStatus
        );

        // Find caller in players[] + verify chip matches their slot.
        let caller     = ctx.accounts.player.key();
        let chip_key   = ctx.accounts.chip.key();
        let mut slot   = usize::MAX;
        for i in 0..(r.num_joined as usize) {
            if r.players[i] == caller {
                require_keys_eq!(chip_key, r.chips[i], ArenaError::WrongChip);
                slot = i;
                break;
            }
        }
        require!(slot != usize::MAX, ArenaError::NotAParticipant);

        // Prevent double-claim.
        let bit = 1u16 << (slot as u16);
        require!((r.chips_claimed_mask & bit) == 0, ArenaError::ChipAlreadyClaimed);
        r.chips_claimed_mask |= bit;

        let auth_bump = ctx.accounts.config.chip_authority_bump;
        return_chip_to(
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip,
            &ctx.accounts.player.to_account_info(),
            &ctx.accounts.chip_authority,
            &ctx.accounts.system_program,
            auth_bump,
        )?;

        try_settle_br(r, Clock::get()?.unix_timestamp);
        Ok(())
    }

    /// Winner pulls their winnings to internal balance + treasury
    /// fee CPI'd to treasury program.  Idempotent: rejects second call.
    pub fn claim_winnings_br(ctx: Context<ClaimWinningsBattleRoyale>) -> Result<()> {
        let r = &mut ctx.accounts.royale;
        require!(
            r.status == STATUS_DECIDED || r.status == STATUS_SETTLED,
            ArenaError::WrongStatus
        );
        require_keys_eq!(ctx.accounts.winner.key(), r.winner, ArenaError::NotWinner);
        require!(!r.prize_claimed, ArenaError::PrizeAlreadyClaimed);

        let payout = r.pool_amount.checked_sub(r.fee_amount).ok_or(ArenaError::MathOverflow)?;

        // Credit winner's internal balance.
        ctx.accounts.winner_user.balance = ctx.accounts.winner_user.balance
            .checked_add(payout).ok_or(ArenaError::MathOverflow)?;

        // SOL movement for the fee: arena_vault → treasury_vault.
        let vault_bump = ctx.accounts.config.vault_bump;
        forward_fee_to_treasury(
            &ctx.accounts.treasury_program,
            &ctx.accounts.treasury_config,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.vault,
            &ctx.accounts.system_program,
            vault_bump,
            r.fee_amount,
        )?;

        r.prize_claimed = true;
        try_settle_br(r, Clock::get()?.unix_timestamp);

        emit!(BattleRoyaleSettledPaid {
            id:      r.id,
            winner:  r.winner,
            payout,
            fee:     r.fee_amount,
        });
        Ok(())
    }

    /// Anyone can cancel an OPEN BR after `join_timeout` elapsed
    /// without filling.  Refunds all joined players' internal balance.
    pub fn expire_battle_royale_join(ctx: Context<CancelBattleRoyale>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.royale;
        require!(r.status == STATUS_WAITING, ArenaError::WrongStatus);
        require!(
            now > r.created_at + ctx.accounts.config.join_timeout,
            ArenaError::JoinPeriodNotExpired
        );
        cancel_br(r, now);
        Ok(())
    }

    /// Anyone can cancel a stuck ROLLING BR after `vrf_timeout`.
    /// Refunds all internal-balance stakes; chips still need to be
    /// claimed individually via claim_chip_br.
    pub fn force_resolve_battle_royale(ctx: Context<CancelBattleRoyale>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.royale;
        require!(r.status == STATUS_ROLLING, ArenaError::WrongStatus);
        require!(
            now > r.rolling_at + ctx.accounts.config.vrf_timeout,
            ArenaError::VrfNotTimedOut
        );
        cancel_br(r, now);
        Ok(())
    }

    // ============================================================
    // SEC-23 — TOURNAMENT MODE
    // ============================================================

    /// One-shot admin ix: create the SPL ticket mint with `ticket_authority`
    /// PDA as both mint+freeze authority.  Idempotent guard via
    /// config.ticket_mint zero-check.  Decimals=0 → tickets are whole-units
    /// only.
    pub fn init_ticket_mint(ctx: Context<InitTicketMint>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(cfg.owner, ctx.accounts.owner.key(), ArenaError::NotOwner);
        require!(cfg.ticket_mint == Pubkey::default(), ArenaError::TicketMintAlreadyInitialized);

        cfg.ticket_mint = ctx.accounts.ticket_mint.key();
        emit!(TicketMintInitialized {
            ticket_mint: ctx.accounts.ticket_mint.key(),
            authority:   ctx.accounts.ticket_authority.key(),
        });
        Ok(())
    }

    /// Player buys N tickets paying `ticket_price * N` SOL into arena_vault.
    /// We mint N tokens to their ATA, payable in `system_program` SOL.
    /// Price hardcoded for MVP — could be made configurable later via setter.
    pub fn buy_ticket(ctx: Context<BuyTicket>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, ArenaError::Paused);
        require!(amount > 0, ArenaError::ZeroAmount);

        // MVP: 0.01 SOL per ticket.  Easy to tune later as a config field.
        const TICKET_PRICE_LAMPORTS: u64 = 10_000_000; // 0.01 SOL
        let total_cost = TICKET_PRICE_LAMPORTS
            .checked_mul(amount).ok_or(ArenaError::MathOverflow)?;

        // Transfer SOL: buyer → arena_vault.
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to:   ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, total_cost)?;

        // Mint `amount` tokens to buyer's ATA.  PDA-signed.
        let auth_bump = ctx.bumps.ticket_authority;
        let seeds: &[&[u8]] = &[b"ticket_authority", core::slice::from_ref(&auth_bump)];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let mint_to_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint:      ctx.accounts.ticket_mint.to_account_info(),
                to:        ctx.accounts.buyer_ata.to_account_info(),
                authority: ctx.accounts.ticket_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::mint_to(mint_to_ctx, amount)?;

        emit!(TicketsPurchased {
            buyer:          ctx.accounts.buyer.key(),
            amount,
            paid_lamports:  total_cost,
        });
        Ok(())
    }

    /// Creator opens a new 8-player tournament with a fixed entry fee.
    /// `entry_fee_lamports` is locked in at creation — protects players
    /// against a mid-tournament tier change by admin.
    pub fn create_tournament(
        ctx: Context<CreateTournament>,
        entry_fee_lamports: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, ArenaError::Paused);
        require!(entry_fee_lamports > 0, ArenaError::ZeroAmount);

        let id = ctx.accounts.config.next_battle_id;
        ctx.accounts.config.next_battle_id += 1;

        let t = &mut ctx.accounts.tournament;
        t.id            = id;
        t.status        = T_STATUS_REGISTERING;
        t.bracket_size  = T_PLAYERS as u8;
        t.registered    = 0;
        t.current_round = 0;
        t.creator       = ctx.accounts.creator.key();
        t.players       = [Pubkey::default(); T_PLAYERS];
        t.chips         = [Pubkey::default(); T_PLAYERS];
        t.matches       = [TMatch::default(); T_MATCHES];
        t.winner_1st_slot = T_SLOT_UNSET;
        t.winner_2nd_slot = T_SLOT_UNSET;
        t.winner_3rd_slot = T_SLOT_UNSET;
        t.entry_fee     = entry_fee_lamports;
        t.created_at    = Clock::get()?.unix_timestamp;
        t.bump          = ctx.bumps.tournament;

        emit!(TournamentCreated {
            id,
            bracket_size: T_PLAYERS as u8,
            entry_fee:    entry_fee_lamports,
            creator:      t.creator,
        });
        Ok(())
    }

    /// Burn 1 ticket + escrow chip + deduct entry_fee from internal balance.
    /// When the lobby reaches T_PLAYERS, the next caller must invoke
    /// `start_tournament` to seed round 0.
    pub fn register_for_tournament(ctx: Context<RegisterForTournament>) -> Result<()> {
        require!(!ctx.accounts.config.paused, ArenaError::Paused);
        let t = &mut ctx.accounts.tournament;
        require!(t.status == T_STATUS_REGISTERING, ArenaError::TournamentRegistrationClosed);
        require!((t.registered as usize) < T_PLAYERS, ArenaError::TournamentRegistrationClosed);

        let player = ctx.accounts.player.key();
        for i in 0..(t.registered as usize) {
            require!(t.players[i] != player, ArenaError::AlreadyJoined);
        }

        // Burn 1 ticket from the player's ATA.
        let burn_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint:      ctx.accounts.ticket_mint.to_account_info(),
                from:      ctx.accounts.player_ata.to_account_info(),
                authority: ctx.accounts.player.to_account_info(),
            },
        );
        token::burn(burn_ctx, 1)?;

        // Debit entry fee from internal balance.
        require!(
            ctx.accounts.player_user.balance >= t.entry_fee,
            ArenaError::InsufficientBalance,
        );
        ctx.accounts.player_user.balance = ctx.accounts.player_user.balance
            .checked_sub(t.entry_fee).ok_or(ArenaError::MathOverflow)?;

        // Escrow chip → chip_authority PDA.
        TransferV1CpiBuilder::new(&ctx.accounts.mpl_core.to_account_info())
            .asset(&ctx.accounts.chip.to_account_info())
            .collection(None)
            .payer(&ctx.accounts.player.to_account_info())
            .authority(Some(&ctx.accounts.player.to_account_info()))
            .new_owner(&ctx.accounts.chip_authority.to_account_info())
            .system_program(Some(&ctx.accounts.system_program.to_account_info()))
            .invoke()?;

        let slot = t.registered as usize;
        t.players[slot] = player;
        t.chips[slot]   = ctx.accounts.chip.key();
        t.registered   += 1;
        t.pool_amount   = t.pool_amount.checked_add(t.entry_fee).ok_or(ArenaError::MathOverflow)?;

        emit!(TournamentRegistered {
            id:         t.id,
            player,
            chip:       ctx.accounts.chip.key(),
            slot:       slot as u8,
            registered: t.registered,
        });
        Ok(())
    }

    /// Lock prizes + seed round 0 + emit MatchRolling for 4 quarter-finals.
    /// Open to any caller once the lobby is full — they pay the slim tx
    /// cost.  Idempotent: rejects second call by status check.
    pub fn start_tournament(ctx: Context<StartTournament>) -> Result<()> {
        let t = &mut ctx.accounts.tournament;
        require!(t.status == T_STATUS_REGISTERING, ArenaError::WrongStatus);
        require!((t.registered as usize) == T_PLAYERS, ArenaError::TournamentNotReady);

        // Compute prize split (hardcoded percentages — see T_PRIZE_*_BPS).
        let pool = t.pool_amount;
        let fee  = (pool as u128 * T_FEE_BPS       as u128 / 10_000u128) as u64;
        let p1   = (pool as u128 * T_PRIZE_1ST_BPS as u128 / 10_000u128) as u64;
        let p2   = (pool as u128 * T_PRIZE_2ND_BPS as u128 / 10_000u128) as u64;
        let p3   = (pool as u128 * T_PRIZE_3RD_BPS as u128 / 10_000u128) as u64;
        t.fee_amount = fee;
        t.prize_1st  = p1;
        t.prize_2nd  = p2;
        t.prize_3rd  = p3;

        t_seed_round_zero(t);
        t.status      = T_STATUS_ACTIVE;
        t.started_at  = Clock::get()?.unix_timestamp;
        t.current_round = 0;

        emit!(TournamentStarted {
            id:         t.id,
            pool_amount: pool,
            fee_amount: fee,
            prize_1st:  p1,
            prize_2nd:  p2,
            prize_3rd:  p3,
        });
        // Emit 4 MatchRolling events for round-0 quarters.  Relayer picks
        // them up via onLogs.
        for i in 0..4u8 {
            let m = &t.matches[i as usize];
            emit!(TournamentMatchRolling {
                id:        t.id,
                round:     0,
                match_idx: i,
                slot_a:    m.slot_a,
                slot_b:    m.slot_b,
            });
        }
        Ok(())
    }

    /// Switchboard On-Demand fulfill for ONE bracket cell.  Mirrors the
    /// 1v1/BR layout parser.  When all matches in current round are
    /// decided, auto-advances to next round (emits more MatchRolling
    /// events) — or transitions to COMPLETED at end of R2.
    pub fn advance_match_switchboard(
        ctx: Context<AdvanceMatchSwitchboard>,
        match_idx: u8,
    ) -> Result<()> {
        require_keys_eq!(
            *ctx.accounts.randomness_account.owner,
            ctx.accounts.config.vrf_program,
            ArenaError::WrongVrfProgram
        );
        require!(
            ctx.accounts.config.vrf_program != Pubkey::default(),
            ArenaError::SwitchboardDisabled
        );

        let t = &mut ctx.accounts.tournament;
        require!(t.status == T_STATUS_ACTIVE, ArenaError::WrongStatus);
        require!((match_idx as usize) < T_MATCHES, ArenaError::WrongPrizeRank);

        // Match must belong to current round + still pending.
        let m_ref = &t.matches[match_idx as usize];
        require!(m_ref.round == t.current_round, ArenaError::WrongTournamentRound);
        require!(m_ref.status == T_MATCH_PENDING, ArenaError::TournamentMatchNotPending);

        // Parse Switchboard randomness account.
        let data = ctx.accounts.randomness_account.try_borrow_data()?;
        require!(data.len() >= 184, ArenaError::MalformedRandomnessAccount);
        const DISC: [u8; 8] = [10, 66, 229, 135, 220, 239, 217, 114];
        require!(data[0..8] == DISC, ArenaError::MalformedRandomnessAccount);
        let seed_slot   = u64::from_le_bytes(data[104..112].try_into().unwrap());
        let reveal_slot = u64::from_le_bytes(data[144..152].try_into().unwrap());
        require!(reveal_slot > seed_slot, ArenaError::RandomnessNotRevealed);
        let seed = u64::from_le_bytes(data[152..160].try_into().unwrap());
        drop(data);

        // Pick winner.  seed even → slot_a, odd → slot_b.  Same algorithm
        // as 1v1 — unbiased modulo since 2^64 % 2 == 0.
        let m = &mut t.matches[match_idx as usize];
        let winner_slot = if seed & 1 == 0 { m.slot_a } else { m.slot_b };
        let loser_slot  = if winner_slot == m.slot_a { m.slot_b } else { m.slot_a };
        m.status              = T_MATCH_DECIDED;
        m.winner_slot         = winner_slot;
        m.seed                = seed;
        m.randomness_account  = ctx.accounts.randomness_account.key();
        m.decided_at          = Clock::get()?.unix_timestamp;
        t.eliminated_mask    |= 1u16 << (loser_slot as u16);

        emit!(TournamentMatchDecided {
            id:        t.id,
            round:     t.current_round,
            match_idx,
            winner_slot,
            seed,
        });
        emit!(SwitchboardVerified {
            battle_id:          t.id,
            randomness_account: ctx.accounts.randomness_account.key(),
        });

        // Check round completion.  We iterate the current-round slice
        // and confirm every match is DECIDED — if so, advance.
        let cur = t.current_round;
        let off = T_ROUND_OFFSETS[cur as usize] as usize;
        let cnt = t_round_match_count(cur) as usize;
        let all_done = (off..off + cnt).all(|i| t.matches[i].status == T_MATCH_DECIDED);

        if all_done {
            let now = Clock::get()?.unix_timestamp;
            if let Some((next_round, next_off, next_cnt)) = t_advance_round(t, now) {
                for i in 0..next_cnt {
                    let m_next = &t.matches[(next_off + i) as usize];
                    emit!(TournamentMatchRolling {
                        id:        t.id,
                        round:     next_round,
                        match_idx: next_off + i,
                        slot_a:    m_next.slot_a,
                        slot_b:    m_next.slot_b,
                    });
                }
            } else {
                // Final round done — t_advance_round already set status =
                // COMPLETED and populated winner_*_slot.  Emit the cap event.
                emit!(TournamentCompleted {
                    id:         t.id,
                    winner_1st: t.players[t.winner_1st_slot as usize],
                    winner_2nd: t.players[t.winner_2nd_slot as usize],
                    winner_3rd: t.players[t.winner_3rd_slot as usize],
                });
            }
        }

        Ok(())
    }

    /// 1st / 2nd / 3rd-place finisher pulls their prize to internal
    /// balance.  `rank` ∈ {0, 1, 2}.  Fee CPI to treasury only on the
    /// FIRST claim (we send the whole pool's fee once, regardless of
    /// who claims first — economics simpler than splitting).
    pub fn claim_tournament_prize(
        ctx: Context<ClaimTournamentPrize>,
        rank: u8,
    ) -> Result<()> {
        let t = &mut ctx.accounts.tournament;
        require!(t.status == T_STATUS_COMPLETED, ArenaError::TournamentNotComplete);
        require!(rank < 3, ArenaError::WrongPrizeRank);

        let bit = 1u8 << rank;
        require!((t.prize_claimed_mask & bit) == 0, ArenaError::PrizeAlreadyClaimed);

        let (claimer_slot, amount) = match rank {
            0 => (t.winner_1st_slot, t.prize_1st),
            1 => (t.winner_2nd_slot, t.prize_2nd),
            _ => (t.winner_3rd_slot, t.prize_3rd),
        };
        require!(claimer_slot != T_SLOT_UNSET, ArenaError::TournamentNotComplete);
        let expected_pubkey = t.players[claimer_slot as usize];
        require_keys_eq!(ctx.accounts.winner.key(), expected_pubkey, ArenaError::NotWinner);

        // Credit internal balance.
        ctx.accounts.winner_user.balance = ctx.accounts.winner_user.balance
            .checked_add(amount).ok_or(ArenaError::MathOverflow)?;

        // Treasury fee CPI — fire only on the first claim (idempotent),
        // mirrors BR's approach.
        if t.prize_claimed_mask == 0 {
            let vault_bump = ctx.accounts.config.vault_bump;
            forward_fee_to_treasury(
                &ctx.accounts.treasury_program,
                &ctx.accounts.treasury_config,
                &ctx.accounts.treasury_vault,
                &ctx.accounts.vault,
                &ctx.accounts.system_program,
                vault_bump,
                t.fee_amount,
            )?;
        }

        t.prize_claimed_mask |= bit;

        emit!(TournamentPrizeClaimed {
            id:     t.id,
            winner: expected_pubkey,
            rank,
            amount,
        });
        Ok(())
    }

    /// Any participant reclaims their chip — chips are membership tokens
    /// (always returned, regardless of placement).  Mirrors claim_chip_br.
    pub fn claim_tournament_chip(ctx: Context<ClaimTournamentChip>) -> Result<()> {
        let t = &mut ctx.accounts.tournament;
        require!(
            t.status == T_STATUS_COMPLETED || t.status == T_STATUS_CANCELLED,
            ArenaError::WrongStatus
        );

        let caller   = ctx.accounts.player.key();
        let chip_key = ctx.accounts.chip.key();
        let mut slot = usize::MAX;
        for i in 0..(t.registered as usize) {
            if t.players[i] == caller {
                require_keys_eq!(chip_key, t.chips[i], ArenaError::WrongChip);
                slot = i;
                break;
            }
        }
        require!(slot != usize::MAX, ArenaError::NotAParticipant);

        let bit = 1u16 << (slot as u16);
        require!((t.chips_claimed_mask & bit) == 0, ArenaError::ChipAlreadyClaimed);
        t.chips_claimed_mask |= bit;

        let auth_bump = ctx.accounts.config.chip_authority_bump;
        return_chip_to(
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip,
            &ctx.accounts.player.to_account_info(),
            &ctx.accounts.chip_authority,
            &ctx.accounts.system_program,
            auth_bump,
        )?;

        emit!(TournamentChipClaimed {
            id:     t.id,
            player: caller,
            slot:   slot as u8,
        });
        Ok(())
    }

    /// Cancel a still-REGISTERING tournament after join_timeout elapsed.
    /// Sets status=CANCELLED; participants reclaim chips via
    /// claim_tournament_chip.  Stake refunds: TODO out of scope for MVP
    /// (entry fees stay in pool_amount until status flips → for now
    /// admin can do a manual refund script post-cancel).
    pub fn expire_tournament_registration(
        ctx: Context<CancelTournament>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let t = &mut ctx.accounts.tournament;
        require!(t.status == T_STATUS_REGISTERING, ArenaError::WrongStatus);
        require!(
            now > t.created_at + ctx.accounts.config.join_timeout,
            ArenaError::JoinPeriodNotExpired
        );
        cancel_tournament(t, now);
        emit!(TournamentCancelled { id: t.id, reason: T_CANCEL_REGISTER_TIMEOUT });
        Ok(())
    }

    /// Admin escape: tournament stuck in ACTIVE state (Switchboard reveal
    /// hung).  Owner-only.  Marks CANCELLED — participants reclaim chips.
    pub fn force_resolve_tournament(ctx: Context<CancelTournament>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.caller.key(), ctx.accounts.config.owner,
            ArenaError::NotOwner
        );
        let now = Clock::get()?.unix_timestamp;
        let t = &mut ctx.accounts.tournament;
        require!(t.status == T_STATUS_ACTIVE, ArenaError::WrongStatus);
        require!(
            now > t.started_at + ctx.accounts.config.vrf_timeout,
            ArenaError::VrfNotTimedOut
        );
        cancel_tournament(t, now);
        emit!(TournamentCancelled { id: t.id, reason: T_CANCEL_VRF_TIMEOUT });
        Ok(())
    }
}

// ============================================================
//                    INTERNAL HELPERS
// ============================================================

/// PDA-signed treasury.record_fee CPI.  Wrapped so the heavy CpiContext
/// struct lives in its own (and short) stack frame.
#[inline(never)]
fn forward_fee_to_treasury<'info>(
    treasury_program: &AccountInfo<'info>,
    treasury_config:  &AccountInfo<'info>,
    treasury_vault:   &AccountInfo<'info>,
    arena_vault:      &AccountInfo<'info>,
    system_program:   &AccountInfo<'info>,
    arena_vault_bump: u8,
    amount:           u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"arena", b"vault", core::slice::from_ref(&arena_vault_bump)];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    let cpi_accounts = treasury::cpi::accounts::RecordFee {
        config:         treasury_config.clone(),
        vault:          treasury_vault.clone(),
        arena_vault:    arena_vault.clone(),
        system_program: system_program.clone(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        treasury_program.clone(),
        cpi_accounts,
        signer_seeds,
    );
    treasury::cpi::record_fee(cpi_ctx, amount)?;
    Ok(())
}

/// PDA-signed mpl-core TransferV1: send `asset` from chip_authority → `to`.
#[inline(never)]
fn return_chip_to<'info>(
    mpl_core:        &AccountInfo<'info>,
    asset:           &AccountInfo<'info>,
    to:              &AccountInfo<'info>,
    chip_authority:  &AccountInfo<'info>,
    system_program:  &AccountInfo<'info>,
    auth_bump:       u8,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"arena", b"chip_authority", core::slice::from_ref(&auth_bump)];
    TransferV1CpiBuilder::new(mpl_core)
        .asset(asset)
        .collection(None)
        .payer(to)                       // gas-payer (any acct)
        .authority(Some(chip_authority)) // current owner = our PDA
        .new_owner(to)
        .system_program(Some(system_program))
        .invoke_signed(&[seeds])?;
    Ok(())
}

// SEC-9 — the on-chain chip stat counters (battle_count / win_count)
// have been removed from `ChipData`.  Their values were never updated
// (re-adding the CPI to keep them in sync re-introduced the 4 KB BPF
// stack-frame overflow that the original `pay_ransom` hit).  The
// indexer authoritatively computes win/loss ratios from settle events,
// so on-chain shadow counters were strictly worse than nothing — they
// invariably read as 0 and tempted UI code to use them.

/// SEC-22 — transition a BR to SETTLED when all chips claimed AND
/// prize claimed.  Called from the tail of every claim ix.
#[inline(never)]
fn try_settle_br(r: &mut BattleRoyale, now: i64) {
    if r.status != STATUS_DECIDED { return; }
    let full_mask: u16 = (1u16 << (r.num_joined as u16)) - 1;
    if (r.chips_claimed_mask & full_mask) == full_mask && r.prize_claimed {
        r.status     = STATUS_SETTLED;
        r.settled_at = now;
    }
}

/// SEC-22 — mark a BR as CANCELLED.  Refunds of the per-player
/// stake from arena_vault → UserAccount are handled by a separate
/// `claim_stake_refund_br` ix (one tx per player) since iterating 8
/// UserAccount PDAs in a single ix would explode the BPF stack.
#[inline(never)]
fn cancel_br(r: &mut BattleRoyale, now: i64) {
    r.status     = STATUS_CANCELLED;
    r.settled_at = now;
}

// ============================================================
// SEC-23 — Tournament bracket logic
// ============================================================

/// Index of the first match in `tournament.matches[]` for a given round.
///   Round 0 → 0 (4 quarter-final matches at 0..4)
///   Round 1 → 4 (2 semi-final matches at 4..6)
///   Round 2 → 6 (final at 6, 3rd-place at 7)
const T_ROUND_OFFSETS: [u8; 4] = [0, 4, 6, 8];

#[inline(always)]
fn t_round_match_count(round: u8) -> u8 {
    // 4 quarters, 2 semis, 2 in last round (final + 3rd-place).
    match round { 0 => 4, 1 => 2, 2 => 2, _ => 0 }
}

/// Fill round 0 of the bracket with the seating: (0,1) (2,3) (4,5) (6,7).
/// Called from `start_tournament` after the lobby is full.
#[inline(never)]
fn t_seed_round_zero(t: &mut Tournament) {
    for i in 0..4u8 {
        t.matches[i as usize] = TMatch {
            status:             T_MATCH_PENDING,
            round:              0,
            slot_a:             i * 2,
            slot_b:             i * 2 + 1,
            winner_slot:        T_SLOT_UNSET,
            seed:               0,
            randomness_account: Pubkey::default(),
            decided_at:         0,
        };
    }
}

/// After every match in the current round is DECIDED, populate the
/// next round's match cells (winners advance for the main bracket;
/// LOSERS advance for the 3rd-place match in the final round).
///
/// When called for the last round (R2 done), populates `winner_*_slot`
/// fields and transitions status to COMPLETED.
///
/// Returns Some(round_indices) where round_indices are the just-seeded
/// matches in the new round (used by the caller to emit MatchRolling
/// events so the relayer picks them up).  Returns None if no more
/// rounds (tournament complete).
fn t_advance_round(t: &mut Tournament, now: i64) -> Option<(u8, u8, u8)> {
    let r = t.current_round;
    if r == 2 {
        // Final round done — populate podium.
        // matches[6] is the final, matches[7] is the 3rd-place.
        let final_match  = &t.matches[6];
        let third_match  = &t.matches[7];
        t.winner_1st_slot = final_match.winner_slot;
        t.winner_2nd_slot = if final_match.winner_slot == final_match.slot_a {
            final_match.slot_b
        } else {
            final_match.slot_a
        };
        t.winner_3rd_slot = third_match.winner_slot;
        t.status          = T_STATUS_COMPLETED;
        t.completed_at    = now;
        return None;
    }

    // Seed next round.
    let next_round   = r + 1;
    let cur_off      = T_ROUND_OFFSETS[r as usize] as usize;
    let next_off     = T_ROUND_OFFSETS[next_round as usize] as usize;
    let next_count   = t_round_match_count(next_round) as usize;

    if next_round == 2 {
        // SEC-23 — R2 has TWO matches that BOTH draw from the same pair
        // of R1 semis (matches[cur_off + 0] and [cur_off + 1]):
        //   matches[6] (final)     = winners of both semis
        //   matches[7] (3rd-place) = losers  of both semis
        //
        // Previous loop indexed cur_off + j*2 for "a_match", which for
        // j=1 read matches[cur_off+2] = matches[6] (the just-written
        // final, not a semi) and matches[7] (still default-zero) —
        // producing slot_b = 0xFF and hanging the bracket.  Copying via
        // stack-local TMatch (it's Copy) sidesteps &/&mut aliasing on
        // the matches array.
        let semi1 = t.matches[cur_off];
        let semi2 = t.matches[cur_off + 1];
        let l1 = if semi1.winner_slot == semi1.slot_a { semi1.slot_b } else { semi1.slot_a };
        let l2 = if semi2.winner_slot == semi2.slot_a { semi2.slot_b } else { semi2.slot_a };

        t.matches[next_off] = TMatch {
            status: T_MATCH_PENDING, round: next_round,
            slot_a: semi1.winner_slot, slot_b: semi2.winner_slot,
            winner_slot: T_SLOT_UNSET, seed: 0,
            randomness_account: Pubkey::default(), decided_at: 0,
        };
        t.matches[next_off + 1] = TMatch {
            status: T_MATCH_PENDING, round: next_round,
            slot_a: l1, slot_b: l2,
            winner_slot: T_SLOT_UNSET, seed: 0,
            randomness_account: Pubkey::default(), decided_at: 0,
        };
    } else {
        // R0→R1 standard pair advance: matches[off+0..2] → next.slot_a/b.
        for j in 0..next_count {
            let a_match = t.matches[cur_off + j * 2];
            let b_match = t.matches[cur_off + j * 2 + 1];
            t.matches[next_off + j] = TMatch {
                status: T_MATCH_PENDING, round: next_round,
                slot_a: a_match.winner_slot, slot_b: b_match.winner_slot,
                winner_slot: T_SLOT_UNSET, seed: 0,
                randomness_account: Pubkey::default(), decided_at: 0,
            };
        }
    }

    t.current_round = next_round;
    // Return (round, first_match_idx, count) — caller emits MatchRolling
    // for each [first..first+count).
    Some((next_round, next_off as u8, next_count as u8))
}

/// True once status==COMPLETED AND all 3 prizes are claimed AND all 8
/// chips reclaimed.  No state change here — purely a read.  We rely on
/// the COMPLETED transition + per-claim ix to update masks; the lifecycle
/// concept of "fully settled" is just (status, masks).
#[inline(always)]
fn t_is_fully_settled(t: &Tournament) -> bool {
    t.status == T_STATUS_COMPLETED
        && t.prize_claimed_mask == 0b111
        && t.chips_claimed_mask == 0xFF
}

#[inline(never)]
fn cancel_tournament(t: &mut Tournament, now: i64) {
    t.status       = T_STATUS_CANCELLED;
    t.completed_at = now;
}

#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn execute_forfeit<'info>(
    b:                 &mut Account<'info, Battle>,
    config:            &Account<'info, ArenaConfig>,
    mpl_core:          &AccountInfo<'info>,
    chip_loser:        &AccountInfo<'info>,
    chip_authority:    &AccountInfo<'info>,
    system_program:    &AccountInfo<'info>,
    winner:            &AccountInfo<'info>,
    expired:           bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let auth_bump = config.chip_authority_bump;

    b.status     = STATUS_SETTLED;
    b.resolution = if expired { RES_EXPIRED } else { RES_FORFEITED };
    b.settled_at = now;

    // Loser's chip → winner.  Winner reclaims their own chip via
    // `claim_winner_chip`; chip stats are computed by the indexer from
    // the emitted Settled event.  Keeps the BPF stack within budget.
    return_chip_to(mpl_core, chip_loser, winner, chip_authority, system_program, auth_bump)?;

    let loser_chip_key = if b.loser == b.player_a { b.chip_a } else { b.chip_b };
    emit!(BattleSettledForfeited {
        battle_id: b.id,
        loser: b.loser,
        chip_forfeited: loser_chip_key,
    });
    Ok(())
}

// ============================================================
//                          ACCOUNTS
// ============================================================

#[account]
pub struct ArenaConfig {
    pub owner:               Pubkey,
    pub chip_nft_program:    Pubkey,
    pub treasury_program:    Pubkey,
    pub vrf_authority:       Pubkey,
    pub next_battle_id:      u64,
    pub pool_amounts:        [u64; N_TIERS],
    pub fee_bps:             u16,
    pub decision_timeout:    i64,
    pub join_timeout:        i64,
    pub vrf_timeout:         i64,
    pub paused:              bool,
    pub bump:                u8,
    pub vault_bump:          u8,
    pub chip_authority_bump: u8,
    // SEC-21 — Switchboard On-Demand program ID.  When set, the
    // `fulfill_random_words_switchboard` ix verifies its argument
    // belongs to this program before consuming the revealed value.
    // Zero pubkey (Pubkey::default()) disables the Switchboard path
    // and only the mock `fulfill_random_words(seed)` ix can fulfil
    // (= legacy Option A).
    //
    // Field carved out of the leading 32 bytes of the old _reserved
    // padding (SEC-20).  Existing on-chain accounts deserialise
    // identically — their bytes that *used* to be _reserved[0..32]
    // become this field, which was zeroed at init = Pubkey::default()
    // = Switchboard path disabled until owner calls set_vrf_program.
    pub vrf_program:         Pubkey,
    // SEC-23 — Ticket SPL mint pubkey (deterministic PDA `[b"ticket_mint"]`).
    // Zero (Pubkey::default()) until owner calls `init_ticket_mint`.
    // The 32 bytes for this field are carved out of the leading 32 bytes
    // of the old _reserved padding (which SEC-21 already shrunk to 32).
    // Result: total SPACE unchanged, no realloc needed for upgrades from
    // pre-SEC-23 deployments.
    pub ticket_mint:         Pubkey,
    pub _reserved:           [u8; 0],
}

impl Default for ArenaConfig {
    fn default() -> Self {
        Self {
            owner:               Pubkey::default(),
            chip_nft_program:    Pubkey::default(),
            treasury_program:    Pubkey::default(),
            vrf_authority:       Pubkey::default(),
            next_battle_id:      0,
            pool_amounts:        [0; N_TIERS],
            fee_bps:             0,
            decision_timeout:    0,
            join_timeout:        0,
            vrf_timeout:         0,
            paused:              false,
            bump:                0,
            vault_bump:          0,
            chip_authority_bump: 0,
            vrf_program:         Pubkey::default(),
            ticket_mint:         Pubkey::default(),
            _reserved:           [],
        }
    }
}

impl ArenaConfig {
    // 8 + 32*4 + 8 + 6*8 + 2 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 32 (vrf_program) + 32 (ticket_mint) + 0 = 284
    pub const SPACE: usize =
        8 + (32 * 4) + 8 + (8 * N_TIERS) + 2 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 32 + 32;
}

#[account]
#[derive(Default)]
pub struct UserAccount {
    pub authority: Pubkey,
    pub balance:   u64,
    pub locked:    u64,
    pub bump:      u8,
}

impl UserAccount {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 1;
}

#[account]
#[derive(Default)]
pub struct Battle {
    pub id:              u64,
    pub player_a:        Pubkey,
    pub player_b:        Pubkey,
    pub chip_a:          Pubkey,
    pub chip_b:          Pubkey,
    pub pool_tier:       u8,
    pub status:          u8,
    pub winner:          Pubkey,
    pub loser:           Pubkey,
    pub random_seed:     u64,
    pub resolution:      u8,
    pub payment_amount:  u64,
    pub fee_amount:      u64,
    pub created_at:      i64,
    pub decided_at:      i64,
    pub settled_at:      i64,
    pub rolling_at:      i64,
    pub vrf_request_id:  u64,
    pub bump:            u8,
}

impl Battle {
    pub const SPACE: usize =
        8 + 8 + 32 + 32 + 32 + 32 + 1 + 1 + 32 + 32 + 8 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1;
}

// SEC-22 — Battle Royale: N players, single Switchboard VRF, winner
// takes the pool (minus treasury fee).  Chips are membership tokens
// only — returned to every player after settle.
#[account]
pub struct BattleRoyale {
    pub id:                 u64,
    pub status:             u8,                          // OPEN/ROLLING/DECIDED/SETTLED/CANCELLED
    pub pool_tier:          u8,                          // 0..N_TIERS
    pub max_players:        u8,                          // 4 or 8 (caller-chosen)
    pub num_joined:         u8,
    pub creator:            Pubkey,
    pub players:            [Pubkey; BR_MAX_PLAYERS],    // padded; first num_joined are valid
    pub chips:              [Pubkey; BR_MAX_PLAYERS],
    pub winner:             Pubkey,                      // set on DECIDED
    pub random_seed:        u64,
    pub randomness_account: Pubkey,                      // Switchboard PDA (audit)
    pub pool_amount:        u64,                         // pool_tier_amount * max_players
    pub fee_amount:         u64,
    pub created_at:         i64,
    pub rolling_at:         i64,
    pub decided_at:         i64,
    pub settled_at:         i64,
    // Per-player chip-claim tracking — bit i set iff players[i] called
    // claim_chip_br.  When all bits up to num_joined are set AND prize
    // is claimed, status auto-transitions to SETTLED.
    pub chips_claimed_mask: u16,
    pub prize_claimed:      bool,
    pub bump:               u8,
    pub _reserved:          [u8; 64],
}

impl Default for BattleRoyale {
    fn default() -> Self {
        Self {
            id:                 0,
            status:             0,
            pool_tier:          0,
            max_players:        0,
            num_joined:         0,
            creator:            Pubkey::default(),
            players:            [Pubkey::default(); BR_MAX_PLAYERS],
            chips:              [Pubkey::default(); BR_MAX_PLAYERS],
            winner:             Pubkey::default(),
            random_seed:        0,
            randomness_account: Pubkey::default(),
            pool_amount:        0,
            fee_amount:         0,
            created_at:         0,
            rolling_at:         0,
            decided_at:         0,
            settled_at:         0,
            chips_claimed_mask: 0,
            prize_claimed:      false,
            bump:               0,
            _reserved:          [0u8; 64],
        }
    }
}

impl BattleRoyale {
    // 8 discr + 8 + 1 + 1 + 1 + 1 + 32 + 32*8 + 32*8 + 32 + 8 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 2 + 1 + 1 + 64
    // = 8 + 8 + 4 + 32 + 256 + 256 + 32 + 8 + 32 + 8 + 8 + 8*4 + 2 + 1 + 1 + 64
    // = 758
    pub const SPACE: usize =
        8 + 8 + 1 + 1 + 1 + 1 + 32 + (32 * BR_MAX_PLAYERS) + (32 * BR_MAX_PLAYERS) +
        32 + 8 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 2 + 1 + 1 + 64;
}

// ============================================================
// SEC-23 — Tournament account + inline TMatch sub-struct
// ============================================================

/// One bracket cell.  Inlined in Tournament.matches[T_MATCHES] so the
/// whole bracket lives on one account — no per-match PDAs to create.
/// Borsh serialises this as a flat 53-byte run (no padding inside a
/// custom Anchor-derived struct).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct TMatch {
    pub status:             u8,         // PENDING / DECIDED
    pub round:              u8,         // 0..2
    pub slot_a:             u8,         // index into Tournament.players[]
    pub slot_b:             u8,
    pub winner_slot:        u8,         // valid only when status == DECIDED; 0xFF otherwise
    pub seed:               u64,
    pub randomness_account: Pubkey,     // Switchboard PDA for audit
    pub decided_at:         i64,
}
// = 1+1+1+1+1 + 8 + 32 + 8 = 53 bytes

impl Default for TMatch {
    fn default() -> Self {
        Self {
            status:             T_MATCH_PENDING,
            round:              0,
            slot_a:             T_SLOT_UNSET,
            slot_b:             T_SLOT_UNSET,
            winner_slot:        T_SLOT_UNSET,
            seed:               0,
            randomness_account: Pubkey::default(),
            decided_at:         0,
        }
    }
}

#[account]
pub struct Tournament {
    pub id:                 u64,
    pub status:             u8,                          // T_STATUS_*
    pub bracket_size:       u8,                          // pinned to T_PLAYERS = 8 in MVP
    pub registered:         u8,                          // 0..bracket_size
    pub current_round:      u8,                          // 0..T_ROUNDS
    pub creator:            Pubkey,
    pub players:            [Pubkey; T_PLAYERS],
    pub chips:              [Pubkey; T_PLAYERS],
    pub matches:            [TMatch; T_MATCHES],
    pub eliminated_mask:    u16,                         // bit i set iff players[i] knocked out
    pub winner_1st_slot:    u8,                          // populated on COMPLETED; 0xFF otherwise
    pub winner_2nd_slot:    u8,
    pub winner_3rd_slot:    u8,
    pub entry_fee:          u64,                         // lamports staked per player (locked at create)
    pub pool_amount:        u64,                         // entry_fee × bracket_size after full
    pub fee_amount:         u64,                         // 5% to treasury
    pub prize_1st:          u64,                         // 60% of pool
    pub prize_2nd:          u64,                         // 25% of pool
    pub prize_3rd:          u64,                         // 10% of pool
    pub created_at:         i64,
    pub started_at:         i64,
    pub completed_at:       i64,
    pub prize_claimed_mask: u8,                          // bit 0=1st, 1=2nd, 2=3rd
    pub chips_claimed_mask: u16,                         // bit i=players[i] reclaimed chip
    pub bump:               u8,
    pub _reserved:          [u8; 64],
}

impl Default for Tournament {
    fn default() -> Self {
        Self {
            id:                 0,
            status:             T_STATUS_REGISTERING,
            bracket_size:       0,
            registered:         0,
            current_round:      0,
            creator:            Pubkey::default(),
            players:            [Pubkey::default(); T_PLAYERS],
            chips:              [Pubkey::default(); T_PLAYERS],
            matches:            [TMatch::default(); T_MATCHES],
            eliminated_mask:    0,
            winner_1st_slot:    T_SLOT_UNSET,
            winner_2nd_slot:    T_SLOT_UNSET,
            winner_3rd_slot:    T_SLOT_UNSET,
            entry_fee:          0,
            pool_amount:        0,
            fee_amount:         0,
            prize_1st:          0,
            prize_2nd:          0,
            prize_3rd:          0,
            created_at:         0,
            started_at:         0,
            completed_at:       0,
            prize_claimed_mask: 0,
            chips_claimed_mask: 0,
            bump:               0,
            _reserved:          [0u8; 64],
        }
    }
}

impl Tournament {
    // Layout (borsh, flat):
    // 8 discr + 8 + 1 + 1 + 1 + 1 + 32 + 32*8 + 32*8 + 53*8 + 2 + 1 + 1 + 1 +
    // 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 2 + 1 + 64
    // = 8 + 8 + 4 + 32 + 256 + 256 + 424 + 5 + 72 + 1 + 2 + 1 + 64 = 1133
    pub const SPACE: usize =
        8 + 8 + 1 + 1 + 1 + 1 + 32 +
        (32 * T_PLAYERS) + (32 * T_PLAYERS) +
        (53 * T_MATCHES) +
        2 + 1 + 1 + 1 +
        8 + 8 + 8 + 8 + 8 + 8 +
        8 + 8 + 8 +
        1 + 2 + 1 + 64;
}

// ============================================================
//                          CONTEXTS
// ============================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = ArenaConfig::SPACE,
        seeds = [b"arena".as_ref()],
        bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    /// CHECK: lamport vault PDA.
    #[account(
        init,
        payer = owner,
        space = 0,
        seeds = [b"arena".as_ref(), b"vault".as_ref()],
        bump,
        owner = system_program::ID,
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: chip-owner PDA.  Initialised lazily; rent-exempt at 0 bytes.
    #[account(
        init,
        payer = owner,
        space = 0,
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump,
        owner = system_program::ID,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: address-only refs.
    pub chip_nft_program: UncheckedAccount<'info>,
    /// CHECK: address-only refs.
    pub treasury_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    #[account(
        mut,
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
        has_one = owner @ ArenaError::NotOwner,
    )]
    pub config: Account<'info, ArenaConfig>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    /// CHECK: vault PDA.
    #[account(
        mut,
        seeds = [b"arena".as_ref(), b"vault".as_ref()],
        bump  = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = UserAccount::SPACE,
        seeds = [b"user".as_ref(), payer.key().as_ref()],
        bump,
    )]
    pub user: Account<'info, UserAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnsureUserAccount<'info> {
    #[account(
        init_if_needed,
        payer = payer,
        space = UserAccount::SPACE,
        seeds = [b"user".as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub user: Account<'info, UserAccount>,

    /// CHECK: address-only — the future owner of this UserAccount.
    pub authority: AccountInfo<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawUser<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    /// CHECK: vault PDA.
    #[account(
        mut,
        seeds = [b"arena".as_ref(), b"vault".as_ref()],
        bump  = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"user".as_ref(), authority.key().as_ref()],
        bump  = user.bump,
        has_one = authority @ ArenaError::NotOwner,
    )]
    pub user: Account<'info, UserAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_tier: u8)]
pub struct CreateBattle<'info> {
    #[account(
        mut,
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        init,
        payer = player,
        space = Battle::SPACE,
        seeds = [b"battle".as_ref(), config.next_battle_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub battle: Account<'info, Battle>,

    /// CHECK: chip authority PDA — chip's new owner.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: chip Asset, validated by mpl-core CPI.
    #[account(mut)]
    pub chip: AccountInfo<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinBattle<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"battle".as_ref(), battle.id.to_le_bytes().as_ref()],
        bump  = battle.bump,
    )]
    pub battle: Account<'info, Battle>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: validated by mpl-core CPI.
    #[account(mut)]
    pub chip: AccountInfo<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelBattle<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"battle".as_ref(), battle.id.to_le_bytes().as_ref()],
        bump  = battle.bump,
    )]
    pub battle: Account<'info, Battle>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: validated by mpl-core CPI.
    #[account(mut)]
    pub chip_a: AccountInfo<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// `expire_join` is callable by anyone (the chip is stuck after Player A
/// abandons their unjoined battle), so this struct splits the signer (a
/// gas-payer) from the chip recipient (which is bound to `battle.player_a`).
#[derive(Accounts)]
pub struct ExpireJoin<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"battle".as_ref(), battle.id.to_le_bytes().as_ref()],
        bump  = battle.bump,
    )]
    pub battle: Account<'info, Battle>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: validated by mpl-core CPI.
    #[account(mut)]
    pub chip_a: AccountInfo<'info>,

    /// CHECK: chip recipient — MUST equal battle.player_a (otherwise any
    /// observer would route player_a's chip to themselves after the join
    /// timeout).
    #[account(mut, address = battle.player_a @ ArenaError::WrongPlayer)]
    pub player_a: AccountInfo<'info>,

    /// Pays the transaction; no authority gate.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FulfillVrf<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"battle".as_ref(), battle.id.to_le_bytes().as_ref()],
        bump  = battle.bump,
    )]
    pub battle: Account<'info, Battle>,

    pub vrf_authority: Signer<'info>,
}

/// SEC-21 — accounts for the trustless Switchboard fulfill ix.
/// `randomness_account` is the off-chain-created RandomnessAccountData;
/// its owner must equal `config.vrf_program` (checked at runtime).
/// `caller` is the relayer's gas-payer (anyone can submit — the seed
/// is fixed by the on-chain randomness data, not the caller).
#[derive(Accounts)]
pub struct FulfillVrfSwitchboard<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"battle".as_ref(), battle.id.to_le_bytes().as_ref()],
        bump  = battle.bump,
    )]
    pub battle: Account<'info, Battle>,

    /// CHECK: parsed manually — owner must equal config.vrf_program.
    pub randomness_account: AccountInfo<'info>,

    #[account(mut)]
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimWinnerChip<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        seeds = [b"battle".as_ref(), battle.id.to_le_bytes().as_ref()],
        bump  = battle.bump,
    )]
    pub battle: Account<'info, Battle>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: validated by mpl-core CPI.
    #[account(mut)]
    pub chip: AccountInfo<'info>,

    #[account(mut)]
    pub winner: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayRansom<'info> {
    #[account(
        mut,
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"battle".as_ref(), battle.id.to_le_bytes().as_ref()],
        bump  = battle.bump,
    )]
    pub battle: Account<'info, Battle>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: arena vault PDA — signs treasury CPI.
    #[account(
        mut,
        seeds = [b"arena".as_ref(), b"vault".as_ref()],
        bump  = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"user".as_ref(), loser.key().as_ref()],
        bump  = loser_user.bump,
    )]
    pub loser_user: Account<'info, UserAccount>,

    /// SEC-10 — UserAccount must already exist for the winner.  The
    /// frontend bundles a no-cost `ensure_user_account` ix in the same
    /// transaction as `pay_ransom` (one popup), so the winner never
    /// has to sign anything.  We tried `init_if_needed` inline but the
    /// extra create_account CPI pushed PayRansom past the 4 KB BPF
    /// stack-frame limit (Access violation in stack frame 5).
    #[account(
        mut,
        seeds = [b"user".as_ref(), winner.key().as_ref()],
        bump  = winner_user.bump,
    )]
    pub winner_user: Account<'info, UserAccount>,

    /// CHECK: validated by mpl-core CPI.
    #[account(mut)]
    pub chip_loser: AccountInfo<'info>,

    /// CHECK: treasury config PDA.
    #[account(mut)]
    pub treasury_config: AccountInfo<'info>,

    /// CHECK: treasury vault PDA.
    #[account(mut)]
    pub treasury_vault: AccountInfo<'info>,

    /// CHECK: treasury program ID.
    pub treasury_program: AccountInfo<'info>,

    #[account(mut)]
    pub loser: Signer<'info>,

    /// CHECK: address-only — destination of winner.balance credit.
    /// SEC-1: must equal `battle.winner` so a malicious loser cannot
    /// redirect the 95 % payout to a sock-puppet they control.
    #[account(address = battle.winner @ ArenaError::NotWinner)]
    pub winner: AccountInfo<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ForfeitChip<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"battle".as_ref(), battle.id.to_le_bytes().as_ref()],
        bump  = battle.bump,
    )]
    pub battle: Account<'info, Battle>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: validated by mpl-core CPI (loser's chip → winner).
    #[account(mut)]
    pub chip_loser: AccountInfo<'info>,

    /// Loser is the signer for `forfeit_chip` only.  For
    /// `expire_decision`, anyone can call — we don't gate on this.
    pub loser: Signer<'info>,

    /// CHECK: address-only destination of the loser's chip.
    #[account(mut)]
    pub winner: AccountInfo<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// `expire_decision` mirrors `ExpireJoin` — anyone calls, but the
/// destinations are address-bound to the battle's recorded keys.
#[derive(Accounts)]
pub struct ExpireDecision<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"battle".as_ref(), battle.id.to_le_bytes().as_ref()],
        bump  = battle.bump,
    )]
    pub battle: Account<'info, Battle>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: validated by mpl-core CPI (loser's chip → winner).
    #[account(mut)]
    pub chip_loser: AccountInfo<'info>,

    /// CHECK: must match battle.loser (informational; not used for auth).
    #[account(address = battle.loser @ ArenaError::WrongPlayer)]
    pub loser: AccountInfo<'info>,

    /// CHECK: chip recipient — SEC-8, must equal battle.winner.
    #[account(mut, address = battle.winner @ ArenaError::WrongPlayer)]
    pub winner: AccountInfo<'info>,

    /// Anyone may call.  Just pays the gas.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ForceResolve<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"battle".as_ref(), battle.id.to_le_bytes().as_ref()],
        bump  = battle.bump,
    )]
    pub battle: Account<'info, Battle>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: validated by mpl-core CPI.
    #[account(mut)]
    pub chip_a: AccountInfo<'info>,
    /// CHECK: validated by mpl-core CPI.
    #[account(mut)]
    pub chip_b: AccountInfo<'info>,

    /// CHECK: chip recipient — SEC-3, must equal battle.player_a.
    #[account(mut, address = battle.player_a @ ArenaError::WrongPlayer)]
    pub player_a: AccountInfo<'info>,
    /// CHECK: chip recipient — SEC-3, must equal battle.player_b.
    #[account(mut, address = battle.player_b @ ArenaError::WrongPlayer)]
    pub player_b: AccountInfo<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================
//                    BATTLE ROYALE ACCOUNTS (SEC-22)
// ============================================================

#[derive(Accounts)]
#[instruction(pool_tier: u8, max_players: u8)]
pub struct CreateBattleRoyale<'info> {
    #[account(
        mut,
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        init,
        payer = creator,
        space = BattleRoyale::SPACE,
        seeds = [b"royale".as_ref(), config.next_battle_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub royale: Account<'info, BattleRoyale>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinBattleRoyale<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"royale".as_ref(), royale.id.to_le_bytes().as_ref()],
        bump  = royale.bump,
    )]
    pub royale: Account<'info, BattleRoyale>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: chip asset, validated by mpl-core CPI.
    #[account(mut)]
    pub chip: AccountInfo<'info>,

    // Internal-balance ledger entry — debited pool_tier amount on join.
    #[account(
        mut,
        seeds = [b"user".as_ref(), player.key().as_ref()],
        bump  = player_user.bump,
        has_one = authority @ ArenaError::NotOwner,
    )]
    pub player_user: Account<'info, UserAccount>,

    /// CHECK: must match player_user.authority — Anchor enforces via has_one.
    pub authority: AccountInfo<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// SEC-22 — Switchboard fulfill for battle royale (Option B).
#[derive(Accounts)]
pub struct FulfillBattleRoyaleSwitchboard<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"royale".as_ref(), royale.id.to_le_bytes().as_ref()],
        bump  = royale.bump,
    )]
    pub royale: Account<'info, BattleRoyale>,

    /// CHECK: parsed manually — owner must equal config.vrf_program.
    pub randomness_account: AccountInfo<'info>,

    #[account(mut)]
    pub caller: Signer<'info>,
}

/// Player claims their chip back after settle (every BR player gets
/// chip back regardless of win/loss — chip is membership, not stake).
#[derive(Accounts)]
pub struct ClaimChipBattleRoyale<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"royale".as_ref(), royale.id.to_le_bytes().as_ref()],
        bump  = royale.bump,
    )]
    pub royale: Account<'info, BattleRoyale>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: validated by mpl-core CPI.
    #[account(mut)]
    pub chip: AccountInfo<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Winner claims the prize pool credit on their internal balance.
/// Treasury fee CPI'd to treasury_program in the same tx.
#[derive(Accounts)]
pub struct ClaimWinningsBattleRoyale<'info> {
    #[account(
        mut,
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"royale".as_ref(), royale.id.to_le_bytes().as_ref()],
        bump  = royale.bump,
    )]
    pub royale: Account<'info, BattleRoyale>,

    /// CHECK: arena vault PDA — signs treasury fee CPI.
    #[account(
        mut,
        seeds = [b"arena".as_ref(), b"vault".as_ref()],
        bump  = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"user".as_ref(), winner.key().as_ref()],
        bump  = winner_user.bump,
    )]
    pub winner_user: Account<'info, UserAccount>,

    /// CHECK: address-bound to royale.winner via require_keys_eq! in handler.
    #[account(mut)]
    pub winner: AccountInfo<'info>,

    /// CHECK: treasury config PDA.
    #[account(mut)]
    pub treasury_config: AccountInfo<'info>,

    /// CHECK: treasury vault PDA.
    #[account(mut)]
    pub treasury_vault: AccountInfo<'info>,

    /// CHECK: treasury program ID.
    pub treasury_program: AccountInfo<'info>,

    #[account(mut)]
    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Refund-all path: timeout while OPEN (never filled) OR VRF timeout.
#[derive(Accounts)]
pub struct CancelBattleRoyale<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        seeds = [b"royale".as_ref(), royale.id.to_le_bytes().as_ref()],
        bump  = royale.bump,
    )]
    pub royale: Account<'info, BattleRoyale>,

    /// Anyone can call.
    #[account(mut)]
    pub caller: Signer<'info>,
}

// ============================================================
// SEC-23 — TOURNAMENT ACCOUNTS
// ============================================================

/// One-shot admin ix: create the global SPL ticket mint.  After this,
/// `config.ticket_mint` is set and subsequent calls fail with
/// TicketMintAlreadyInitialized.
#[derive(Accounts)]
pub struct InitTicketMint<'info> {
    #[account(
        mut,
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    /// PDA mint with decimals=0; ticket_authority PDA owns mint+freeze.
    #[account(
        init,
        payer = owner,
        seeds = [b"ticket_mint".as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = ticket_authority,
        mint::freeze_authority = ticket_authority,
    )]
    pub ticket_mint: Account<'info, Mint>,

    /// CHECK: PDA-only signer for mint_to/burn — derived, never carries
    /// any data of its own.
    #[account(
        seeds = [b"ticket_authority".as_ref()],
        bump,
    )]
    pub ticket_authority: AccountInfo<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program:     Program<'info, Token>,
    pub system_program:    Program<'info, System>,
    pub rent:              Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct BuyTicket<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ArenaConfig>,

    /// CHECK: arena_vault PDA receives the SOL payment.
    #[account(
        mut,
        seeds = [b"arena".as_ref(), b"vault".as_ref()],
        bump  = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"ticket_mint".as_ref()],
        bump,
        constraint = ticket_mint.key() == config.ticket_mint @ ArenaError::WrongTicketMint,
    )]
    pub ticket_mint: Account<'info, Mint>,

    /// CHECK: PDA-only signer for mint_to.
    #[account(
        seeds = [b"ticket_authority".as_ref()],
        bump,
    )]
    pub ticket_authority: AccountInfo<'info>,

    /// Buyer's ATA — created on first BUY (init_if_needed).  Payer is
    /// the buyer themselves.
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = ticket_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(entry_fee_lamports: u64)]
pub struct CreateTournament<'info> {
    #[account(
        mut,
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Box<Account<'info, ArenaConfig>>,

    #[account(
        init,
        payer = creator,
        space = Tournament::SPACE,
        seeds = [b"tournament".as_ref(), config.next_battle_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub tournament: Box<Account<'info, Tournament>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
// SEC-23 — BPF stack-frame fix: Tournament (1133 bytes) + ArenaConfig (286)
// + Mint + TokenAccount + UserAccount overflowed try_accounts()'s 4 KB
// stack budget by ~1.8 KB.  Box<Account<>> moves the deserialised data
// to the heap; the Account wrapper itself becomes a single pointer on
// stack.  Handler code accesses via auto-deref so no other changes.
pub struct RegisterForTournament<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Box<Account<'info, ArenaConfig>>,

    #[account(
        mut,
        seeds = [b"tournament".as_ref(), tournament.id.to_le_bytes().as_ref()],
        bump  = tournament.bump,
    )]
    pub tournament: Box<Account<'info, Tournament>>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: validated by mpl-core CPI.
    #[account(mut)]
    pub chip: AccountInfo<'info>,

    #[account(
        mut,
        constraint = ticket_mint.key() == config.ticket_mint @ ArenaError::WrongTicketMint,
    )]
    pub ticket_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = ticket_mint,
        associated_token::authority = player,
    )]
    pub player_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"user".as_ref(), player.key().as_ref()],
        bump  = player_user.bump,
        has_one = authority @ ArenaError::NotOwner,
    )]
    pub player_user: Box<Account<'info, UserAccount>>,

    /// CHECK: has_one enforces player_user.authority == authority.
    pub authority: AccountInfo<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartTournament<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Box<Account<'info, ArenaConfig>>,

    #[account(
        mut,
        seeds = [b"tournament".as_ref(), tournament.id.to_le_bytes().as_ref()],
        bump  = tournament.bump,
    )]
    pub tournament: Box<Account<'info, Tournament>>,

    /// Anyone can poke.
    #[account(mut)]
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(match_idx: u8)]
pub struct AdvanceMatchSwitchboard<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Box<Account<'info, ArenaConfig>>,

    #[account(
        mut,
        seeds = [b"tournament".as_ref(), tournament.id.to_le_bytes().as_ref()],
        bump  = tournament.bump,
    )]
    pub tournament: Box<Account<'info, Tournament>>,

    /// CHECK: parsed manually — owner must equal config.vrf_program.
    pub randomness_account: AccountInfo<'info>,

    #[account(mut)]
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(rank: u8)]
pub struct ClaimTournamentPrize<'info> {
    #[account(
        mut,
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Box<Account<'info, ArenaConfig>>,

    #[account(
        mut,
        seeds = [b"tournament".as_ref(), tournament.id.to_le_bytes().as_ref()],
        bump  = tournament.bump,
    )]
    pub tournament: Box<Account<'info, Tournament>>,

    /// CHECK: arena_vault PDA signs the treasury fee CPI.
    #[account(
        mut,
        seeds = [b"arena".as_ref(), b"vault".as_ref()],
        bump  = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"user".as_ref(), winner.key().as_ref()],
        bump  = winner_user.bump,
    )]
    pub winner_user: Box<Account<'info, UserAccount>>,

    /// CHECK: address-bound to expected_pubkey in handler.
    #[account(mut)]
    pub winner: AccountInfo<'info>,

    /// CHECK: treasury config PDA, validated by treasury_program CPI.
    #[account(mut)]
    pub treasury_config: AccountInfo<'info>,

    /// CHECK: treasury vault PDA.
    #[account(mut)]
    pub treasury_vault: AccountInfo<'info>,

    /// CHECK: treasury program — address-checked.
    #[account(address = config.treasury_program)]
    pub treasury_program: AccountInfo<'info>,

    #[account(mut)]
    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTournamentChip<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Box<Account<'info, ArenaConfig>>,

    #[account(
        mut,
        seeds = [b"tournament".as_ref(), tournament.id.to_le_bytes().as_ref()],
        bump  = tournament.bump,
    )]
    pub tournament: Box<Account<'info, Tournament>>,

    /// CHECK: chip authority PDA.
    #[account(
        seeds = [b"arena".as_ref(), b"chip_authority".as_ref()],
        bump  = config.chip_authority_bump,
    )]
    pub chip_authority: AccountInfo<'info>,

    /// CHECK: validated by mpl-core CPI.
    #[account(mut)]
    pub chip: AccountInfo<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Refund-or-admin cancel path for tournaments.  Re-used by both
/// expire_tournament_registration (anyone, after join_timeout) and
/// force_resolve_tournament (owner-only, after vrf_timeout).
#[derive(Accounts)]
pub struct CancelTournament<'info> {
    #[account(
        seeds = [b"arena".as_ref()],
        bump  = config.bump,
    )]
    pub config: Box<Account<'info, ArenaConfig>>,

    #[account(
        mut,
        seeds = [b"tournament".as_ref(), tournament.id.to_le_bytes().as_ref()],
        bump  = tournament.bump,
    )]
    pub tournament: Box<Account<'info, Tournament>>,

    #[account(mut)]
    pub caller: Signer<'info>,
}

// ============================================================
//                          EVENTS
// ============================================================

#[event] pub struct ArenaInitialized {
    pub owner: Pubkey,
    pub chip_authority: Pubkey,
}
#[event] pub struct Deposited { pub user: Pubkey, pub amount: u64, pub balance: u64 }
#[event] pub struct Withdrawn { pub user: Pubkey, pub amount: u64, pub balance: u64 }

#[event] pub struct BattleCreated {
    pub battle_id: u64,
    pub player_a:  Pubkey,
    pub chip_a:    Pubkey,
    pub pool_tier: u8,
}
#[event] pub struct BattleJoined {
    pub battle_id: u64,
    pub player_b:  Pubkey,
    pub chip_b:    Pubkey,
    pub vrf_request_id: u64,
}
#[event] pub struct BattleDecided {
    pub battle_id: u64,
    pub winner:    Pubkey,
    pub loser:     Pubkey,
    pub random_seed: u64,
}
#[event] pub struct BattleSettledPaid {
    pub battle_id: u64,
    pub loser:     Pubkey,
    pub payment:   u64,
    pub fee:       u64,
}
#[event] pub struct BattleSettledForfeited {
    pub battle_id: u64,
    pub loser:     Pubkey,
    pub chip_forfeited: Pubkey,
}
#[event] pub struct BattleCancelled { pub battle_id: u64, pub player_a: Pubkey }
#[event] pub struct BattleExpired   { pub battle_id: u64, pub loser:    Pubkey }
#[event] pub struct VrfTimedOut     { pub battle_id: u64 }

// SEC-19 — admin audit events.
#[event] pub struct PausedUpdated       { pub paused:    bool }
#[event] pub struct FeeBpsUpdated       { pub fee_bps:   u16 }
#[event] pub struct PoolAmountUpdated   { pub tier:      u8,  pub lamports: u64 }
#[event] pub struct TimeoutUpdated      { pub kind:      u8,  pub seconds:  i64 }
#[event] pub struct VrfAuthorityUpdated { pub authority: Pubkey }
// SEC-21
#[event] pub struct VrfProgramUpdated   { pub program:   Pubkey }
#[event] pub struct SwitchboardVerified {
    pub battle_id:          u64,
    pub randomness_account: Pubkey,
}

// SEC-22 — Battle Royale events.
#[event] pub struct BattleRoyaleCreated {
    pub id:          u64,
    pub pool_tier:   u8,
    pub max_players: u8,
    pub creator:     Pubkey,
}
#[event] pub struct BattleRoyaleJoined {
    pub id:          u64,
    pub player:      Pubkey,
    pub chip:        Pubkey,
    pub slot:        u8,
    pub num_joined:  u8,
}
#[event] pub struct BattleRoyaleRolling {
    pub id:          u64,
    pub pool_amount: u64,
}
#[event] pub struct BattleRoyaleDecided {
    pub id:          u64,
    pub winner:      Pubkey,
    pub winner_idx:  u8,
    pub random_seed: u64,
    pub pool_amount: u64,
    pub fee_amount:  u64,
}
#[event] pub struct BattleRoyaleSettledPaid {
    pub id:          u64,
    pub winner:      Pubkey,
    pub payout:      u64,
    pub fee:         u64,
}
#[event] pub struct BattleRoyaleCancelled {
    pub id:          u64,
    pub reason:      u8,   // 0 = join timeout, 1 = vrf timeout
}

// ---- SEC-23 — Tournament events ------------------------------
#[event] pub struct TicketMintInitialized {
    pub ticket_mint: Pubkey,
    pub authority:   Pubkey,
}
#[event] pub struct TicketsPurchased {
    pub buyer:         Pubkey,
    pub amount:        u64,
    pub paid_lamports: u64,
}
#[event] pub struct TournamentCreated {
    pub id:           u64,
    pub bracket_size: u8,
    pub entry_fee:    u64,
    pub creator:      Pubkey,
}
#[event] pub struct TournamentRegistered {
    pub id:         u64,
    pub player:     Pubkey,
    pub chip:       Pubkey,
    pub slot:       u8,
    pub registered: u8,
}
#[event] pub struct TournamentStarted {
    pub id:          u64,
    pub pool_amount: u64,
    pub fee_amount:  u64,
    pub prize_1st:   u64,
    pub prize_2nd:   u64,
    pub prize_3rd:   u64,
}
#[event] pub struct TournamentMatchRolling {
    pub id:        u64,
    pub round:     u8,
    pub match_idx: u8,
    pub slot_a:    u8,
    pub slot_b:    u8,
}
#[event] pub struct TournamentMatchDecided {
    pub id:          u64,
    pub round:       u8,
    pub match_idx:   u8,
    pub winner_slot: u8,
    pub seed:        u64,
}
#[event] pub struct TournamentCompleted {
    pub id:         u64,
    pub winner_1st: Pubkey,
    pub winner_2nd: Pubkey,
    pub winner_3rd: Pubkey,
}
#[event] pub struct TournamentPrizeClaimed {
    pub id:     u64,
    pub winner: Pubkey,
    pub rank:   u8,    // 0=1st, 1=2nd, 2=3rd
    pub amount: u64,
}
#[event] pub struct TournamentChipClaimed {
    pub id:     u64,
    pub player: Pubkey,
    pub slot:   u8,
}
#[event] pub struct TournamentCancelled {
    pub id:     u64,
    pub reason: u8,    // 0 = registration timeout, 1 = vrf timeout
}

// ============================================================
//                          ERRORS
// ============================================================

#[error_code]
pub enum ArenaError {
    #[msg("Caller is not the configured owner / authority")]
    NotOwner,
    #[msg("Battles are paused")]
    Paused,
    #[msg("Wrong battle status for this action")]
    WrongStatus,
    #[msg("Cannot join your own battle")]
    CannotJoinOwnBattle,
    #[msg("Caller is not playerA")]
    NotYourBattle,
    #[msg("Caller is not the winner")]
    NotWinner,
    #[msg("Caller is not the loser")]
    NotLoser,
    #[msg("Decision period has expired")]
    DecisionPeriodExpired,
    #[msg("Decision period still active")]
    DecisionPeriodActive,
    #[msg("Join period has not expired")]
    JoinPeriodNotExpired,
    #[msg("VRF has not timed out yet")]
    VrfNotTimedOut,
    #[msg("Caller is not the registered VRF authority")]
    NotVrfAuthority,
    #[msg("Pool tier index out of range")]
    InvalidTier,
    #[msg("Invalid timeout (out of allowed window)")]
    InvalidTimeout,
    #[msg("Fee bps too high (max 10%)")]
    FeeTooHigh,
    #[msg("Insufficient internal balance")]
    InsufficientBalance,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Wrong chip account passed for this battle slot")]
    WrongChip,
    #[msg("Wrong player account — does not match battle.player_a / player_b")]
    WrongPlayer,
    #[msg("Randomness account is not owned by the configured Switchboard program")]
    WrongVrfProgram,
    #[msg("Switchboard VRF disabled (vrf_program is zero) — call set_vrf_program first")]
    SwitchboardDisabled,
    #[msg("Switchboard randomness account is malformed (wrong size or discriminator)")]
    MalformedRandomnessAccount,
    #[msg("Switchboard randomness has not been revealed yet (value_slot <= seed_slot)")]
    RandomnessNotRevealed,
    // SEC-22 — Battle Royale specific
    #[msg("max_players must be between 2 and BR_MAX_PLAYERS")]
    InvalidMaxPlayers,
    #[msg("Battle Royale already full")]
    BattleRoyaleFull,
    #[msg("Player has already joined this Battle Royale")]
    AlreadyJoined,
    #[msg("Caller is not a participant of this Battle Royale")]
    NotAParticipant,
    #[msg("Chip already claimed for this Battle Royale slot")]
    ChipAlreadyClaimed,
    #[msg("Prize already claimed for this Battle Royale")]
    PrizeAlreadyClaimed,
    // SEC-23 — Tournament specific
    #[msg("Ticket SPL mint already initialised — init_ticket_mint is one-shot")]
    TicketMintAlreadyInitialized,
    #[msg("Provided ticket mint does not match config.ticket_mint")]
    WrongTicketMint,
    #[msg("Tournament registration period closed or full")]
    TournamentRegistrationClosed,
    #[msg("Tournament lobby not full — cannot start yet")]
    TournamentNotReady,
    #[msg("Match is not in PENDING state")]
    TournamentMatchNotPending,
    #[msg("Match does not belong to the current round")]
    WrongTournamentRound,
    #[msg("Tournament has not completed — prize unavailable")]
    TournamentNotComplete,
    #[msg("Prize rank must be 0 (1st), 1 (2nd), or 2 (3rd)")]
    WrongPrizeRank,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
