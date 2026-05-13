// ============================================================
// programs/chip-nft/src/lib.rs
//
// Solana port of EVM ChipNFT.sol.
// Each chip is a Metaplex Core Asset (one account, ~0.0035 SOL rent).
// Per-chip game stats live in our own `ChipData` PDA — keeping them
// out of the Asset's plugin data so we don't pay extra rent and have
// type-safe access from BattleArena CPI.
//
// Differences from EVM:
//   • mint price + max supply per rarity stored in `ChipNftConfig`,
//     not in 5 separate mappings.
//   • mint price flows into a SystemAccount-style vault PDA;
//     owner withdraws via signed CPI.
//   • `recordBattle` ↔ `record_battle` callable only by a single
//     registered `battle_authority` PDA (the BattleArena's signer
//     PDA).  Verified by Pubkey match — no list, no mapping.
// ============================================================

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use mpl_core::{
    instructions::CreateV1CpiBuilder,
    types::DataState,
    ID as MPL_CORE_ID,
};

declare_id!("A8fqFHnTHAAq3B5t22S8RAix4neNTXTp7RaZ6aQbk5qQ");

// Rarity values mirror the EVM enum order.
pub const RARITY_COMMON:    u8 = 0;
pub const RARITY_UNCOMMON:  u8 = 1;
pub const RARITY_RARE:      u8 = 2;
pub const RARITY_EPIC:      u8 = 3;
pub const RARITY_LEGENDARY: u8 = 4;
pub const RARITY_MAX:       u8 = 4;

#[program]
pub mod chip_nft {
    use super::*;

    /// One-shot init.  Sets default mint prices and max supplies that mirror
    /// the EVM contract's tier ratios but in lamports.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.owner            = ctx.accounts.owner.key();
        cfg.battle_authority = Pubkey::default();    // set later
        cfg.mint_enabled     = false;
        cfg.next_token_id    = 1;
        cfg.bump             = ctx.bumps.config;
        cfg.vault_bump       = ctx.bumps.vault;

        // Default lamport prices (same ratios as EVM 2/10/40/100/400).
        cfg.mint_price = [
            20_000_000,        // Common    0.02 SOL
            100_000_000,       // Uncommon  0.1
            400_000_000,       // Rare      0.4
            1_000_000_000,     // Epic      1.0
            4_000_000_000,     // Legendary 4.0
        ];

        // Default supply caps.  0 = unlimited.
        cfg.max_supply = [
            0,                 // Common    unlimited
            10_000,            // Uncommon
            3_000,             // Rare
            500,               // Epic
            50,                // Legendary
        ];
        cfg.minted_count = [0; 5];

        emit!(ChipNftInitialized { owner: cfg.owner });
        Ok(())
    }

    // ------------------------------------------------------------
    // OWNER FUNCTIONS
    // ------------------------------------------------------------

    pub fn set_mint_enabled(ctx: Context<OwnerOnly>, enabled: bool) -> Result<()> {
        ctx.accounts.config.mint_enabled = enabled;
        emit!(MintEnabledUpdated { enabled });
        Ok(())
    }

    pub fn set_mint_price(
        ctx: Context<OwnerOnly>,
        rarity: u8,
        price_lamports: u64,
    ) -> Result<()> {
        require!(rarity <= RARITY_MAX, ChipNftError::InvalidRarity);
        ctx.accounts.config.mint_price[rarity as usize] = price_lamports;
        emit!(MintPriceUpdated { rarity, new_price: price_lamports });
        Ok(())
    }

    pub fn set_max_supply(
        ctx: Context<OwnerOnly>,
        rarity: u8,
        supply: u32,
    ) -> Result<()> {
        require!(rarity <= RARITY_MAX, ChipNftError::InvalidRarity);
        ctx.accounts.config.max_supply[rarity as usize] = supply;
        emit!(MaxSupplyUpdated { rarity, supply });
        Ok(())
    }

    /// Register the BattleArena's signing PDA.  Only this exact pubkey can
    /// later call `record_battle` — no allowlist, no mapping, just identity.
    pub fn set_battle_authority(
        ctx: Context<OwnerOnly>,
        authority: Pubkey,
    ) -> Result<()> {
        ctx.accounts.config.battle_authority = authority;
        emit!(BattleAuthorityUpdated { authority });
        Ok(())
    }

    /// Owner pulls accumulated mint revenue from the vault PDA.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, ChipNftError::ZeroAmount);

        let rent_min = Rent::get()?.minimum_balance(0);
        let max_w   = ctx.accounts.vault.lamports().saturating_sub(rent_min);
        require!(amount <= max_w, ChipNftError::InsufficientBalance);

        let bump = ctx.accounts.config.vault_bump;
        let seeds: &[&[u8]] = &[b"chip_nft", b"vault", core::slice::from_ref(&bump)];
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
        Ok(())
    }

    // ------------------------------------------------------------
    // PUBLIC: MINT
    // ------------------------------------------------------------

    /// Mint a single chip NFT.
    /// `name` and `uri` come from the client (uri usually points at
    /// `ipfs://CID/<tokenId>.json` produced by chiptap-nft-metadata).
    pub fn mint_chip(
        ctx: Context<MintChip>,
        rarity: u8,
        name: String,
        uri:  String,
    ) -> Result<()> {
        require!(ctx.accounts.config.mint_enabled, ChipNftError::MintDisabled);
        require!(rarity <= RARITY_MAX,             ChipNftError::InvalidRarity);
        require!(name.len() <= 32,                 ChipNftError::NameTooLong);
        require!(uri.len()  <= 200,                ChipNftError::UriTooLong);

        // Snapshot all config we need so the &mut borrow can be released
        // before we hand `ctx.accounts.config.to_account_info()` to the
        // mpl-core CPI builder.
        let idx        = rarity as usize;
        let price:    u64;
        let cap:      u32;
        let minted:   u32;
        let token_id: u64;
        let cfg_bump: u8;
        {
            let cfg = &mut ctx.accounts.config;
            price  = cfg.mint_price[idx];
            cap    = cfg.max_supply[idx];
            minted = cfg.minted_count[idx];
            if cap > 0 {
                require!(minted < cap, ChipNftError::MaxSupplyReached);
            }
            // Allocate next token id and update counters BEFORE the CPI
            // to Metaplex Core, so a CPI failure leaves no half-state.
            token_id = cfg.next_token_id;
            cfg.next_token_id     = cfg.next_token_id.checked_add(1).ok_or(ChipNftError::MathOverflow)?;
            cfg.minted_count[idx] = minted.checked_add(1).ok_or(ChipNftError::MathOverflow)?;
            cfg_bump = cfg.bump;
        }

        // 1) Buyer pays mint price into our vault.
        let pay_cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to:   ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(pay_cpi, price)?;

        // 2) CPI to Metaplex Core — create a fresh Asset.
        //    asset.signer must be a brand-new keypair generated client-side.
        CreateV1CpiBuilder::new(&ctx.accounts.mpl_core.to_account_info())
            .asset(&ctx.accounts.asset.to_account_info())
            .collection(None)
            .authority(Some(&ctx.accounts.config.to_account_info()))
            .payer(&ctx.accounts.payer.to_account_info())
            .owner(Some(&ctx.accounts.payer.to_account_info()))
            .update_authority(Some(&ctx.accounts.config.to_account_info()))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .data_state(DataState::AccountState)
            .name(name.clone())
            .uri(uri.clone())
            .invoke_signed(&[&[
                b"chip_nft",
                core::slice::from_ref(&cfg_bump),
            ]])?;

        // 4) Init our ChipData PDA with stats.
        let chip = &mut ctx.accounts.chip_data;
        chip.asset     = ctx.accounts.asset.key();
        chip.token_id  = token_id;
        chip.rarity    = rarity;
        chip.minted_at = Clock::get()?.unix_timestamp;
        chip.bump      = ctx.bumps.chip_data;

        emit!(ChipMinted {
            asset:    ctx.accounts.asset.key(),
            owner:    ctx.accounts.payer.key(),
            token_id,
            rarity,
            price,
        });
        Ok(())
    }

    // SEC-9 — `record_battle` and its on-chain stat fields are gone.
    // The counters were never incremented (`pay_ransom` would have hit
    // the 4 KB BPF stack frame limit), so they always read 0 and tempted
    // UI code into using broken data.  Authoritative win/loss tallies
    // live in the indexer's `player_stats` table, computed from settle
    // events.  `battle_authority` is now an audit field only (admin can
    // still set it to display in DevTools).
}

// ============================================================
//                          ACCOUNTS
// ============================================================

#[account]
#[derive(Default)]
pub struct ChipNftConfig {
    pub owner:            Pubkey,
    pub battle_authority: Pubkey,
    pub mint_enabled:     bool,
    pub next_token_id:    u64,        // monotonically increasing
    pub mint_price:       [u64; 5],   // by rarity
    pub max_supply:       [u32; 5],
    pub minted_count:     [u32; 5],
    pub bump:             u8,
    pub vault_bump:       u8,
    // SEC-20 — see TreasuryConfig and CLAUDE.md "PDA versioning".
    pub _reserved:        [u8; 64],
}

impl ChipNftConfig {
    // 8 discr + 32 + 32 + 1 + 8 + 5*8 + 5*4 + 5*4 + 1 + 1 + 64 = 207
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 8 + (5 * 8) + (5 * 4) + (5 * 4) + 1 + 1 + 64;
}

#[account]
#[derive(Default)]
pub struct ChipData {
    pub asset:     Pubkey,
    pub token_id:  u64,
    pub rarity:    u8,
    pub minted_at: i64,
    pub bump:      u8,
}

impl ChipData {
    // 8 discr + 32 + 8 + 1 + 8 + 1 = 58
    pub const SPACE: usize = 8 + 32 + 8 + 1 + 8 + 1;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer  = owner,
        space  = ChipNftConfig::SPACE,
        seeds = [b"chip_nft".as_ref()],
        bump
    )]
    pub config: Account<'info, ChipNftConfig>,

    /// CHECK: lamport-only mint vault PDA.
    #[account(
        init,
        payer  = owner,
        space  = 0,
        seeds = [b"chip_nft".as_ref(), b"vault".as_ref()],
        bump,
        owner  = system_program::ID,
    )]
    pub vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    #[account(
        mut,
        seeds = [b"chip_nft".as_ref()],
        bump  = config.bump,
        has_one = owner @ ChipNftError::NotOwner,
    )]
    pub config: Account<'info, ChipNftConfig>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"chip_nft".as_ref()],
        bump  = config.bump,
        has_one = owner @ ChipNftError::NotOwner,
    )]
    pub config: Account<'info, ChipNftConfig>,

    /// CHECK: lamport-only vault PDA.
    #[account(
        mut,
        seeds = [b"chip_nft".as_ref(), b"vault".as_ref()],
        bump  = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintChip<'info> {
    #[account(
        mut,
        seeds = [b"chip_nft".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ChipNftConfig>,

    /// CHECK: lamport-only vault PDA.
    #[account(
        mut,
        seeds = [b"chip_nft".as_ref(), b"vault".as_ref()],
        bump  = config.vault_bump,
    )]
    pub vault: AccountInfo<'info>,

    /// Fresh keypair from the client.  Becomes a Metaplex Core Asset.
    /// CHECK: validated and written by mpl-core CPI.
    #[account(mut, signer)]
    pub asset: AccountInfo<'info>,

    /// Per-chip stats PDA, seeded by the asset address.
    #[account(
        init,
        payer = payer,
        space = ChipData::SPACE,
        seeds = [b"chip".as_ref(), asset.key().as_ref()],
        bump,
    )]
    pub chip_data: Account<'info, ChipData>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: address constraint validates this is the real Metaplex Core program.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// SEC-9 — `RecordBattle` Accounts struct removed along with the ix.

// ============================================================
//                          EVENTS
// ============================================================

#[event] pub struct ChipNftInitialized      { pub owner: Pubkey }
#[event] pub struct MintPriceUpdated        { pub rarity: u8, pub new_price: u64 }
#[event] pub struct BattleAuthorityUpdated  { pub authority: Pubkey }
// SEC-19 — admin audit events.
#[event] pub struct MintEnabledUpdated      { pub enabled: bool }
#[event] pub struct MaxSupplyUpdated        { pub rarity:  u8, pub supply: u32 }
#[event]
pub struct ChipMinted {
    pub asset:    Pubkey,
    pub owner:    Pubkey,
    pub token_id: u64,
    pub rarity:   u8,
    pub price:    u64,
}

// ============================================================
//                          ERRORS
// ============================================================

#[error_code]
pub enum ChipNftError {
    #[msg("Caller is not the owner")]
    NotOwner,
    // SEC-9: NotBattleAuthority used to gate `record_battle` — both the
    // ix and this variant are dead since chip stats are computed by the
    // indexer.  Slot kept so other error codes don't shift.
    #[msg("(deprecated)")]
    NotBattleAuthorityDeprecated,
    #[msg("Mint is currently disabled")]
    MintDisabled,
    #[msg("Invalid rarity")]
    InvalidRarity,
    #[msg("Maximum supply for this rarity has been reached")]
    MaxSupplyReached,
    #[msg("Vault has insufficient lamports above rent minimum")]
    InsufficientBalance,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Asset name exceeds 32 bytes")]
    NameTooLong,
    #[msg("Asset URI exceeds 200 bytes")]
    UriTooLong,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
