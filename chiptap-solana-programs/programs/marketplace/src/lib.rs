// ============================================================
// programs/marketplace/src/lib.rs
//
// SEC-27 — P2P chip marketplace.  Sellers escrow a chip and name a
// price in SOL; any buyer fills it in one transaction.
//
// Deliberately a SEPARATE program rather than new instructions on
// battle-arena.  Two measured reasons:
//   • `ArenaConfig._reserved` is EXHAUSTED — it is literally
//     `[u8; 0]` today (SEC-21 carved 32 bytes for `vrf_program`,
//     SEC-23 another 32 for `ticket_mint`).  Any new arena config
//     field would need the `realloc!` migration SEC-20 deferred,
//     against live devnet state.  A fresh program gets fresh padding.
//   • battle-arena already needs `Box<Account<>>` on 7 Accounts
//     structs just to stay inside Solana's 4 KB BPF stack frame
//     (SEC-23).  Don't pile onto that.
//
// Payment is DIRECT wallet -> wallet SOL, NOT the arena's UserAccount
// internal ledger.  The project must never custody user funds, and a
// purchase is a deliberate one-off action — unlike the per-battle
// wallet popups the internal ledger exists to avoid.
//
// Escrow model: `make_listing` moves the chip into `market_authority`.
// A useful consequence: "listed" and "in a battle" are MUTUALLY
// EXCLUSIVE for free.  mpl-core refuses a TransferV1 whose authority
// isn't the current owner, so battle-arena cannot escrow a listed chip
// and we cannot list a battling one.  No cross-program check needed —
// do NOT add one thinking it's missing.
//
// Fee sink: this program's own `market_vault`, owner-withdrawable.
// NOT treasury — `treasury::record_fee` authenticates a SINGLE
// registered depositor (`require_keys_eq!(arena_vault, cfg.battle_arena)`),
// so routing marketplace fees there needs a treasury upgrade first.
// That upgrade is cheap when we want it (`TreasuryConfig._reserved` is
// still the full `[u8; 64]`, so a `marketplace: Pubkey` slot costs no
// migration) but it is not a v1 prerequisite.
// ============================================================

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use mpl_core::{
    instructions::TransferV1CpiBuilder,
    ID as MPL_CORE_ID,
};

declare_id!("4xHdVGgRKnNu3bCSJY9CRz9fnrvxiJuZU2uc9kfHxJ1P");

/// Hard ceiling on the marketplace fee, enforced on both `initialize`
/// and `set_fee_bps` so a compromised owner key can't set 100 %.
pub const MAX_FEE_BPS: u16 = 1_000; // 10 %

#[program]
pub mod marketplace {
    use super::*;

    // ============================================================
    //                          ADMIN
    // ============================================================

    /// One-shot: creates the config PDA, the lamport fee vault and the
    /// escrow authority that owns listed chips.
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, MarketError::FeeTooHigh);

        let cfg = &mut ctx.accounts.config;
        cfg.owner          = ctx.accounts.owner.key();
        cfg.fee_bps        = fee_bps;
        cfg.paused         = false;
        cfg.next_listing_id = 1;
        cfg.total_volume   = 0;
        cfg.total_fees     = 0;
        cfg.bump           = ctx.bumps.config;
        cfg.vault_bump     = ctx.bumps.vault;
        cfg.authority_bump = ctx.bumps.market_authority;
        cfg._reserved      = [0u8; 64];

        emit!(MarketInitialized { owner: cfg.owner, fee_bps });
        Ok(())
    }

    /// Emergency stop.  Blocks new listings and fills; `cancel_listing`
    /// stays open on purpose so sellers can always retrieve their chip.
    pub fn set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(MarketPausedUpdated { paused });
        Ok(())
    }

    pub fn set_fee_bps(ctx: Context<OwnerOnly>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, MarketError::FeeTooHigh);
        ctx.accounts.config.fee_bps = fee_bps;
        emit!(MarketFeeBpsUpdated { fee_bps });
        Ok(())
    }

    /// Owner pulls accumulated fees out of `market_vault`.  The vault
    /// must stay rent-exempt afterwards or the runtime would purge it.
    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        require!(amount > 0, MarketError::ZeroAmount);

        let min_rent = Rent::get()?.minimum_balance(0);
        let available = ctx.accounts.vault.lamports().saturating_sub(min_rent);
        require!(amount <= available, MarketError::VaultInsufficient);

        let bump = ctx.accounts.config.vault_bump;
        let seeds: &[&[u8]] = &[b"market", b"vault", core::slice::from_ref(&bump)];
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

        emit!(FeesWithdrawn { to: ctx.accounts.owner.key(), amount });
        Ok(())
    }

    // ============================================================
    //                       SELLER ACTIONS
    // ============================================================

    /// Escrow `chip` and offer it at `price` lamports.
    ///
    /// The effective fee is SNAPSHOTTED into the Listing.  That is
    /// deliberate: a later `set_fee_bps` must not retroactively tax
    /// offers a seller already published at a known net payout.
    pub fn make_listing(ctx: Context<MakeListing>, price: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, MarketError::Paused);
        require!(price > 0, MarketError::ZeroPrice);

        // Chip moves seller -> market_authority.  Seller signs, so
        // mpl-core enforces that they really are the current owner.
        TransferV1CpiBuilder::new(&ctx.accounts.mpl_core.to_account_info())
            .asset(&ctx.accounts.chip.to_account_info())
            .collection(None)
            .payer(&ctx.accounts.seller.to_account_info())
            .authority(Some(&ctx.accounts.seller.to_account_info()))
            .new_owner(&ctx.accounts.market_authority.to_account_info())
            .system_program(Some(&ctx.accounts.system_program.to_account_info()))
            .invoke()?;

        let cfg = &mut ctx.accounts.config;
        let listing_id = cfg.next_listing_id;
        cfg.next_listing_id = cfg
            .next_listing_id
            .checked_add(1)
            .ok_or(MarketError::MathOverflow)?;
        let fee_bps = cfg.fee_bps;

        let l = &mut ctx.accounts.listing;
        l.id         = listing_id;
        l.seller     = ctx.accounts.seller.key();
        l.asset      = ctx.accounts.chip.key();
        l.price      = price;
        l.fee_bps    = fee_bps;
        l.created_at = Clock::get()?.unix_timestamp;
        l.bump       = ctx.bumps.listing;

        emit!(ListingCreated {
            id:     listing_id,
            seller: l.seller,
            asset:  l.asset,
            price,
            fee_bps,
        });
        Ok(())
    }

    /// Seller withdraws the offer and takes the chip back.  Works even
    /// while paused — never trap someone's asset behind an admin flag.
    pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
        let (id, seller, asset) = {
            let l = &ctx.accounts.listing;
            (l.id, l.seller, l.asset)
        };

        transfer_chip_from_escrow(
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip,
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.market_authority,
            &ctx.accounts.system_program.to_account_info(),
            ctx.accounts.config.authority_bump,
        )?;

        emit!(ListingCancelled { id, seller, asset });
        Ok(())
    }

    // ============================================================
    //                        BUYER ACTION
    // ============================================================

    /// Buy a listed chip: pay `price` (split seller / fee) and receive
    /// the asset.  One transaction, one wallet popup.
    ///
    /// `seller` is bound to `listing.seller` by an `address` constraint
    /// on the Accounts struct AND re-checked here — same defence in
    /// depth as SEC-1's `pay_ransom` winner check, because getting this
    /// wrong would let a buyer redirect the seller's payout.
    ///
    /// `max_price` is MANDATORY slippage protection, not a nicety.  The
    /// Listing PDA is seeded by the ASSET, not by the listing id, so the
    /// same address is reused every time a chip is re-listed.  Without
    /// this bound a malicious seller could land `cancel_listing` +
    /// `make_listing` at a far higher price in between the buyer signing
    /// and the tx executing, and the buyer's own signature would pay the
    /// new price.  Wallet simulation does NOT protect against this — it
    /// runs before signing, the swap happens after.  Pass the price the
    /// buyer was actually shown.
    pub fn fill_listing(ctx: Context<FillListing>, max_price: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, MarketError::Paused);

        let (id, seller, asset, price, fee_bps) = {
            let l = &ctx.accounts.listing;
            (l.id, l.seller, l.asset, l.price, l.fee_bps)
        };

        require!(price <= max_price, MarketError::PriceExceedsMax);
        require_keys_eq!(ctx.accounts.seller.key(), seller, MarketError::NotSeller);
        require_keys_eq!(ctx.accounts.chip.key(),   asset,  MarketError::WrongChip);
        require!(
            ctx.accounts.buyer.key() != seller,
            MarketError::CannotBuyOwnListing
        );

        let fee = (price as u128)
            .checked_mul(fee_bps as u128)
            .ok_or(MarketError::MathOverflow)?
            .checked_div(10_000u128)
            .ok_or(MarketError::MathOverflow)? as u64;
        let to_seller = price.checked_sub(fee).ok_or(MarketError::MathOverflow)?;

        // buyer -> seller (net proceeds)
        if to_seller > 0 {
            let cpi = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to:   ctx.accounts.seller.to_account_info(),
                },
            );
            system_program::transfer(cpi, to_seller)?;
        }

        // buyer -> market_vault (fee)
        if fee > 0 {
            let cpi = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to:   ctx.accounts.vault.to_account_info(),
                },
            );
            system_program::transfer(cpi, fee)?;
        }

        // chip: market_authority -> buyer
        transfer_chip_from_escrow(
            &ctx.accounts.mpl_core,
            &ctx.accounts.chip,
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.market_authority,
            &ctx.accounts.system_program.to_account_info(),
            ctx.accounts.config.authority_bump,
        )?;

        let cfg = &mut ctx.accounts.config;
        cfg.total_volume = cfg.total_volume.saturating_add(price);
        cfg.total_fees   = cfg.total_fees.saturating_add(fee);

        emit!(ListingFilled {
            id,
            seller,
            buyer: ctx.accounts.buyer.key(),
            asset,
            price,
            fee,
            paid_to_seller: to_seller,
        });
        Ok(())
    }
}

// ============================================================
//                      INTERNAL HELPERS
// ============================================================

/// PDA-signed mpl-core TransferV1: send `asset` from market_authority
/// -> `to`.  `#[inline(never)]` so the fat CpiBuilder lives in its own
/// short stack frame (the SEC-10 / `pay_ransom` lesson).
#[inline(never)]
fn transfer_chip_from_escrow<'info>(
    mpl_core:         &AccountInfo<'info>,
    asset:            &AccountInfo<'info>,
    to:               &AccountInfo<'info>,
    market_authority: &AccountInfo<'info>,
    system_program:   &AccountInfo<'info>,
    auth_bump:        u8,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"market", b"authority", core::slice::from_ref(&auth_bump)];
    TransferV1CpiBuilder::new(mpl_core)
        .asset(asset)
        .collection(None)
        .payer(to)                         // gas-payer (the receiving signer)
        .authority(Some(market_authority)) // current owner = our PDA
        .new_owner(to)
        .system_program(Some(system_program))
        .invoke_signed(&[seeds])?;
    Ok(())
}

// ============================================================
//                           STATE
// ============================================================

#[account]
pub struct MarketConfig {
    pub owner:           Pubkey,
    pub fee_bps:         u16,
    pub paused:          bool,
    pub next_listing_id: u64,
    pub total_volume:    u64, // lifetime lamports traded
    pub total_fees:      u64, // lifetime lamports taken as fee
    pub bump:            u8,
    pub vault_bump:      u8,
    pub authority_bump:  u8,
    // SEC-20 discipline: configs carry forward-compat padding so a new
    // primitive field never re-shifts existing byte offsets.  New fields
    // go BEFORE this and shrink it to compensate — never after.
    pub _reserved:       [u8; 64],
}

impl MarketConfig {
    // 8 discr + 32 + 2 + 1 + 8 + 8 + 8 + 1 + 1 + 1 + 64 = 134
    pub const SPACE: usize = 8 + 32 + 2 + 1 + 8 + 8 + 8 + 1 + 1 + 1 + 64;
}

/// One live listing per asset (seeds are `[b"listing", asset]`), so the
/// PDA itself makes double-listing impossible.  Closed on cancel/fill,
/// which frees the seed for a future re-listing.
///
/// No `_reserved` padding, deliberately — same call as `Battle`: these
/// are cheap, short-lived accounts, so a future shape change should
/// ship as a new account type rather than a migration.
#[account]
pub struct Listing {
    pub id:         u64,
    pub seller:     Pubkey,
    pub asset:      Pubkey,
    pub price:      u64,
    pub fee_bps:    u16, // snapshot at listing time — see make_listing
    pub created_at: i64,
    pub bump:       u8,
}

impl Listing {
    // 8 discr + 8 + 32 + 32 + 8 + 2 + 8 + 1 = 99
    pub const SPACE: usize = 8 + 8 + 32 + 32 + 8 + 2 + 8 + 1;
}

// ============================================================
//                     ACCOUNTS STRUCTS
// ============================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = MarketConfig::SPACE,
        seeds = [b"market".as_ref()],
        bump,
    )]
    pub config: Account<'info, MarketConfig>,

    /// CHECK: lamport fee vault PDA.
    #[account(
        init,
        payer = owner,
        space = 0,
        seeds = [b"market".as_ref(), b"vault".as_ref()],
        bump,
        owner = system_program::ID,
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: escrow owner PDA for listed chips; rent-exempt at 0 bytes.
    #[account(
        init,
        payer = owner,
        space = 0,
        seeds = [b"market".as_ref(), b"authority".as_ref()],
        bump,
        owner = system_program::ID,
    )]
    pub market_authority: AccountInfo<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    #[account(
        mut,
        seeds = [b"market".as_ref()],
        bump = config.bump,
        constraint = config.owner == owner.key() @ MarketError::NotOwner,
    )]
    pub config: Account<'info, MarketConfig>,

    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(
        seeds = [b"market".as_ref()],
        bump = config.bump,
        constraint = config.owner == owner.key() @ MarketError::NotOwner,
    )]
    pub config: Account<'info, MarketConfig>,

    /// CHECK: lamport fee vault PDA.
    #[account(
        mut,
        seeds = [b"market".as_ref(), b"vault".as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MakeListing<'info> {
    #[account(
        mut,
        seeds = [b"market".as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, MarketConfig>,

    #[account(
        init,
        payer = seller,
        space = Listing::SPACE,
        seeds = [b"listing".as_ref(), chip.key().as_ref()],
        bump,
    )]
    pub listing: Account<'info, Listing>,

    /// CHECK: escrow owner PDA.
    #[account(
        mut,
        seeds = [b"market".as_ref(), b"authority".as_ref()],
        bump = config.authority_bump,
    )]
    pub market_authority: AccountInfo<'info>,

    /// CHECK: chip Asset, validated by the mpl-core CPI.
    #[account(mut)]
    pub chip: AccountInfo<'info>,

    #[account(mut)]
    pub seller: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelListing<'info> {
    #[account(
        seeds = [b"market".as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, MarketConfig>,

    /// Rent refunds to the seller who paid it.
    #[account(
        mut,
        close = seller,
        seeds = [b"listing".as_ref(), chip.key().as_ref()],
        bump = listing.bump,
        constraint = listing.seller == seller.key() @ MarketError::NotSeller,
        constraint = listing.asset  == chip.key()   @ MarketError::WrongChip,
    )]
    pub listing: Account<'info, Listing>,

    /// CHECK: escrow owner PDA.
    #[account(
        mut,
        seeds = [b"market".as_ref(), b"authority".as_ref()],
        bump = config.authority_bump,
    )]
    pub market_authority: AccountInfo<'info>,

    /// CHECK: chip Asset, validated by the mpl-core CPI.
    #[account(mut)]
    pub chip: AccountInfo<'info>,

    #[account(mut)]
    pub seller: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FillListing<'info> {
    #[account(
        mut,
        seeds = [b"market".as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, MarketConfig>,

    /// Rent refunds to the seller who paid it on `make_listing`.
    #[account(
        mut,
        close = seller,
        seeds = [b"listing".as_ref(), chip.key().as_ref()],
        bump = listing.bump,
        constraint = listing.asset == chip.key() @ MarketError::WrongChip,
    )]
    pub listing: Account<'info, Listing>,

    /// CHECK: lamport fee vault PDA.
    #[account(
        mut,
        seeds = [b"market".as_ref(), b"vault".as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: escrow owner PDA.
    #[account(
        mut,
        seeds = [b"market".as_ref(), b"authority".as_ref()],
        bump = config.authority_bump,
    )]
    pub market_authority: AccountInfo<'info>,

    /// CHECK: bound to `listing.seller` — receives the net proceeds.
    #[account(mut, address = listing.seller @ MarketError::NotSeller)]
    pub seller: AccountInfo<'info>,

    /// CHECK: chip Asset, validated by the mpl-core CPI.
    #[account(mut)]
    pub chip: AccountInfo<'info>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: address-checked.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================
//                          EVENTS
// ============================================================

#[event] pub struct MarketInitialized   { pub owner: Pubkey, pub fee_bps: u16 }
#[event] pub struct MarketPausedUpdated { pub paused: bool }
#[event] pub struct MarketFeeBpsUpdated { pub fee_bps: u16 }
#[event] pub struct FeesWithdrawn       { pub to: Pubkey, pub amount: u64 }

#[event]
pub struct ListingCreated {
    pub id:      u64,
    pub seller:  Pubkey,
    pub asset:   Pubkey,
    pub price:   u64,
    pub fee_bps: u16,
}

#[event]
pub struct ListingCancelled {
    pub id:     u64,
    pub seller: Pubkey,
    pub asset:  Pubkey,
}

#[event]
pub struct ListingFilled {
    pub id:             u64,
    pub seller:         Pubkey,
    pub buyer:          Pubkey,
    pub asset:          Pubkey,
    pub price:          u64,
    pub fee:            u64,
    pub paid_to_seller: u64,
}

// ============================================================
//                          ERRORS
// ============================================================

#[error_code]
pub enum MarketError {
    #[msg("Caller is not the marketplace owner")]
    NotOwner,               // 6000
    #[msg("Marketplace is paused")]
    Paused,                 // 6001
    #[msg("Listing price must be greater than zero")]
    ZeroPrice,              // 6002
    #[msg("Fee exceeds the hard ceiling")]
    FeeTooHigh,             // 6003
    #[msg("Account is not the seller of this listing")]
    NotSeller,              // 6004
    #[msg("Chip does not match the listing asset")]
    WrongChip,              // 6005
    #[msg("Seller cannot buy their own listing")]
    CannotBuyOwnListing,    // 6006
    #[msg("Arithmetic overflow")]
    MathOverflow,           // 6007
    #[msg("Amount must be greater than zero")]
    ZeroAmount,             // 6008
    #[msg("Vault has insufficient lamports above rent minimum")]
    VaultInsufficient,      // 6009
    #[msg("Listing price is higher than the buyer's accepted maximum")]
    PriceExceedsMax,        // 6010
}
