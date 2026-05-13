// ============================================================
// programs/treasury/src/lib.rs
//
// Solana port of EVM Treasury.sol.
// Collects platform fees from BattleArena. The vault is a
// SystemAccount-style PDA (system-program-owned, lamports only)
// so anyone — including the BattleArena program signing as its
// own PDA — can pay fees in via `system_program::transfer`.
// Only the owner can pull lamports out, via PDA-signed CPI.
//
// Differences from EVM:
//   • No `receive()` — fees flow in via CPI'd `record_fee`,
//     which performs a system_program::transfer from the
//     caller's vault to ours.
//   • No `depositors[]` mapping — instead, the BattleArena
//     program is registered once via `set_battle_arena(..)` and
//     verified at CPI time by Pubkey match.
// ============================================================

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("wGAqdvJJV2DTHUgkDxdMkWotTvg8Q7r5kz5NntWESPp");

#[program]
pub mod treasury {
    use super::*;

    /// One-shot init.  Creates singleton config PDA (`[b"treasury"]`)
    /// and vault PDA (`[b"treasury", b"vault"]`).
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.owner            = ctx.accounts.owner.key();
        cfg.battle_arena     = Pubkey::default();
        cfg.total_collected  = 0;
        cfg.total_withdrawn  = 0;
        cfg.bump             = ctx.bumps.config;
        cfg.vault_bump       = ctx.bumps.vault;
        emit!(TreasuryInitialized { owner: cfg.owner });
        Ok(())
    }

    /// Owner registers the BattleArena PDA that's allowed to deposit fees.
    pub fn set_battle_arena(ctx: Context<OwnerOnly>, battle_arena: Pubkey) -> Result<()> {
        ctx.accounts.config.battle_arena = battle_arena;
        emit!(BattleArenaUpdated { battle_arena });
        Ok(())
    }

    /// Called by BattleArena via CPI.  Moves `amount` lamports from
    /// `arena_vault` into the treasury vault and bumps the counter.
    /// `arena_vault` must sign — that proves the caller really owns it.
    pub fn record_fee(ctx: Context<RecordFee>, amount: u64) -> Result<()> {
        require!(amount > 0, TreasuryError::ZeroAmount);

        let cfg = &mut ctx.accounts.config;
        require_keys_eq!(
            ctx.accounts.arena_vault.key(),
            cfg.battle_arena,
            TreasuryError::NotDepositor
        );

        // The arena_vault is a PDA owned by the BattleArena program; the
        // BattleArena program must invoke us via CPI with arena_vault
        // signing via its seeds.  We then forward those lamports into our
        // own vault using a plain SystemProgram::transfer — no extra
        // signing on our side because arena_vault is the source.
        let cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.arena_vault.to_account_info(),
                to:   ctx.accounts.vault.to_account_info(),
            },
        );
        // The signer seeds were attached to the *outer* CPI by BattleArena,
        // so this transfer succeeds without us re-signing.
        system_program::transfer(cpi, amount)?;

        cfg.total_collected = cfg
            .total_collected
            .checked_add(amount)
            .ok_or(TreasuryError::MathOverflow)?;

        emit!(FeeRecorded { amount });
        Ok(())
    }

    /// Owner withdraws lamports from the vault.  Vault is a SystemAccount-
    /// style PDA, so we sign via its seeds.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, TreasuryError::ZeroAmount);

        let vault_lamports = ctx.accounts.vault.lamports();
        let rent_min = Rent::get()?.minimum_balance(0);
        let max_withdrawable = vault_lamports.saturating_sub(rent_min);
        require!(amount <= max_withdrawable, TreasuryError::InsufficientBalance);

        let bump = ctx.accounts.config.vault_bump;
        let seeds: &[&[u8]] = &[b"treasury", b"vault", core::slice::from_ref(&bump)];
        let signer_seeds = &[seeds];

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to:   ctx.accounts.owner.to_account_info(),
            },
            signer_seeds,
        );
        system_program::transfer(cpi, amount)?;

        ctx.accounts.config.total_withdrawn = ctx
            .accounts
            .config
            .total_withdrawn
            .checked_add(amount)
            .ok_or(TreasuryError::MathOverflow)?;

        emit!(Withdrawn { to: ctx.accounts.owner.key(), amount });
        Ok(())
    }
}

// ============================================================
//                          ACCOUNTS
// ============================================================

#[account]
#[derive(Default)]
pub struct TreasuryConfig {
    pub owner:           Pubkey,
    pub battle_arena:    Pubkey, // PDA of the registered BattleArena vault
    pub total_collected: u64,
    pub total_withdrawn: u64,
    pub bump:            u8,
    pub vault_bump:      u8,
}

impl TreasuryConfig {
    pub const SPACE: usize = 8 /* discr */ + 32 + 32 + 8 + 8 + 1 + 1;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer  = owner,
        space  = TreasuryConfig::SPACE,
        seeds = [b"treasury".as_ref()],
        bump
    )]
    pub config: Account<'info, TreasuryConfig>,

    /// SystemAccount-style PDA — lamports only, no data.
    #[account(
        init,
        payer  = owner,
        space  = 0,
        seeds = [b"treasury".as_ref(), b"vault".as_ref()],
        bump,
        owner  = system_program::ID,
    )]
    /// CHECK: lamport-only vault, owner enforced via seeds + system_program.
    pub vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    #[account(
        mut,
        seeds = [b"treasury".as_ref()],
        bump  = config.bump,
        has_one = owner @ TreasuryError::NotOwner,
    )]
    pub config: Account<'info, TreasuryConfig>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct RecordFee<'info> {
    #[account(
        mut,
        seeds = [b"treasury".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, TreasuryConfig>,

    /// CHECK: lamport-only vault PDA.
    #[account(
        mut,
        seeds = [b"treasury".as_ref(), b"vault".as_ref()],
        bump  = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    /// The BattleArena's vault PDA.  Must sign (program-derived signer).
    /// We compare its key to `config.battle_arena` to authenticate.
    #[account(mut)]
    pub arena_vault: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"treasury".as_ref()],
        bump  = config.bump,
        has_one = owner @ TreasuryError::NotOwner,
    )]
    pub config: Account<'info, TreasuryConfig>,

    /// CHECK: lamport-only vault PDA.
    #[account(
        mut,
        seeds = [b"treasury".as_ref(), b"vault".as_ref()],
        bump  = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================
//                          EVENTS
// ============================================================

#[event] pub struct TreasuryInitialized { pub owner: Pubkey }
#[event] pub struct BattleArenaUpdated  { pub battle_arena: Pubkey }
#[event] pub struct FeeRecorded         { pub amount: u64 }
#[event] pub struct Withdrawn           { pub to: Pubkey, pub amount: u64 }

// ============================================================
//                          ERRORS
// ============================================================

#[error_code]
pub enum TreasuryError {
    #[msg("Caller is not the registered BattleArena depositor")]
    NotDepositor,
    #[msg("Caller is not the treasury owner")]
    NotOwner,
    #[msg("Vault has insufficient lamports above rent minimum")]
    InsufficientBalance,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
