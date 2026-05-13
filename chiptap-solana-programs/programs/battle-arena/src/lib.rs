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
#[derive(Default)]
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
    // SEC-20 — see CLAUDE.md "PDA versioning".  Anchor account sizes
    // are frozen at init; new fields go BEFORE this padding (and the
    // padding shrinks) so existing accounts keep deserialising.  Once
    // padding is exhausted, schedule a `realloc` migration ix.
    pub _reserved:           [u8; 64],
}

impl ArenaConfig {
    // 8 + 32*4 + 8 + 6*8 + 2 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 64 = 284
    pub const SPACE: usize =
        8 + (32 * 4) + 8 + (8 * N_TIERS) + 2 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 64;
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
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
