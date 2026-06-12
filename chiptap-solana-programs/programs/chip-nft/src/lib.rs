// ============================================================
// programs/chip-nft/src/lib.rs
//
// Each chip is a Metaplex Core Asset (one account, ~0.0035 SOL rent).
// Per-chip game stats live in our own `ChipData` PDA — keeping them
// out of the Asset's plugin data so we don't pay extra rent.
//
// SEC-26 — Tier system (replaces the 5-level mint-time rarity):
//   • Every chip mints at TIER 0 for a single flat price.
//   • `progression_wins` counts the chip's PvP (1v1) + Battle Royale
//     victories; crossing a threshold auto-promotes the tier:
//       T0→T1 at 100 wins, →T2 at 250, →T3 at 550, →T4 at 1550.
//     Tournaments intentionally do NOT count (user decision 2026-06-10).
//   • `record_chip_win` is PERMISSIONLESS + idempotent: anyone may
//     submit the Battle / BattleRoyale account after the game is
//     DECIDED; the handler verifies the account is owned by the
//     registered battle-arena program, parses the winner + winner's
//     chip from the raw layout (same manual-parse discipline as the
//     SEC-21 Switchboard verification), and dedupes via a monotonic
//     `last_game_id` (1v1 + BR share one arena-side id counter, and a
//     chip is escrowed while it plays, so its game ids strictly
//     increase).  NO CPI from battle-arena — that path is what blew
//     the 4 KB BPF stack in SEC-9/SEC-10.
// ============================================================

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use mpl_core::{
    instructions::CreateV1CpiBuilder,
    types::DataState,
    ID as MPL_CORE_ID,
};

declare_id!("A8fqFHnTHAAq3B5t22S8RAix4neNTXTp7RaZ6aQbk5qQ");

// SEC-26 — cumulative win thresholds; index = current tier.
// tier N promotes to N+1 once progression_wins >= TIER_THRESHOLDS[N].
pub const TIER_THRESHOLDS: [u32; 4] = [100, 250, 550, 1550];
pub const TIER_MAX:        u8 = 4;

// Anchor account discriminators of the battle-arena accounts we parse
// in `record_chip_win` (sha256("account:<Name>")[0..8]).  These are
// layout-frozen at deploy time; a battle-arena account-shape change is
// already documented as a hard break (SEC-20).
const BATTLE_DISC: [u8; 8] = [81, 148, 121, 71, 63, 166, 116, 24];
const ROYALE_DISC: [u8; 8] = [236, 95, 128, 245, 19, 52, 28, 163];

// Game statuses shared by Battle + BattleRoyale.
const GAME_DECIDED: u8 = 2;
const GAME_SETTLED: u8 = 3;

#[program]
pub mod chip_nft {
    use super::*;

    /// One-shot init.  SEC-26: a single flat tier-0 mint price.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.owner                = ctx.accounts.owner.key();
        cfg.battle_authority     = Pubkey::default();    // audit field, set later
        cfg.battle_arena_program = Pubkey::default();    // set_battle_arena_program later
        cfg.mint_enabled         = false;
        cfg.next_token_id        = 1;
        cfg.bump                 = ctx.bumps.config;
        cfg.vault_bump           = ctx.bumps.vault;

        cfg.mint_price   = 20_000_000;   // 0.02 SOL — every chip mints at T0
        cfg.max_supply   = 0;            // 0 = unlimited
        cfg.minted_count = 0;

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
        price_lamports: u64,
    ) -> Result<()> {
        ctx.accounts.config.mint_price = price_lamports;
        emit!(MintPriceUpdated { new_price: price_lamports });
        Ok(())
    }

    pub fn set_max_supply(
        ctx: Context<OwnerOnly>,
        supply: u64,
    ) -> Result<()> {
        ctx.accounts.config.max_supply = supply;
        emit!(MaxSupplyUpdated { supply });
        Ok(())
    }

    /// Audit field — the BattleArena's signing PDA (kept for DevTools
    /// visibility; nothing on-chain gates on it since SEC-9).
    pub fn set_battle_authority(
        ctx: Context<OwnerOnly>,
        authority: Pubkey,
    ) -> Result<()> {
        ctx.accounts.config.battle_authority = authority;
        emit!(BattleAuthorityUpdated { authority });
        Ok(())
    }

    /// SEC-26 — register the battle-arena PROGRAM id.  `record_chip_win`
    /// only accepts game accounts owned by this program.
    pub fn set_battle_arena_program(
        ctx: Context<OwnerOnly>,
        program: Pubkey,
    ) -> Result<()> {
        ctx.accounts.config.battle_arena_program = program;
        emit!(BattleArenaProgramUpdated { program });
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

    /// Mint a single chip NFT — always tier 0 (SEC-26).
    /// `name` and `uri` come from the client (uri usually points at
    /// `ipfs://CID/<tokenId>.json` produced by chiptap-nft-metadata).
    pub fn mint_chip(
        ctx: Context<MintChip>,
        name: String,
        uri:  String,
    ) -> Result<()> {
        require!(ctx.accounts.config.mint_enabled, ChipNftError::MintDisabled);
        require!(name.len() <= 32,                 ChipNftError::NameTooLong);
        require!(uri.len()  <= 200,                ChipNftError::UriTooLong);

        // Snapshot all config we need so the &mut borrow can be released
        // before we hand `ctx.accounts.config.to_account_info()` to the
        // mpl-core CPI builder.
        let price:    u64;
        let token_id: u64;
        let cfg_bump: u8;
        {
            let cfg = &mut ctx.accounts.config;
            price = cfg.mint_price;
            if cfg.max_supply > 0 {
                require!(cfg.minted_count < cfg.max_supply, ChipNftError::MaxSupplyReached);
            }
            // Allocate next token id and update counters BEFORE the CPI
            // to Metaplex Core, so a CPI failure leaves no half-state.
            token_id = cfg.next_token_id;
            cfg.next_token_id = cfg.next_token_id.checked_add(1).ok_or(ChipNftError::MathOverflow)?;
            cfg.minted_count  = cfg.minted_count.checked_add(1).ok_or(ChipNftError::MathOverflow)?;
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
        chip.asset            = ctx.accounts.asset.key();
        chip.token_id         = token_id;
        chip.tier             = 0;
        chip.progression_wins = 0;
        chip.last_game_id     = 0;
        chip.minted_at        = Clock::get()?.unix_timestamp;
        chip.bump             = ctx.bumps.chip_data;

        emit!(ChipMinted {
            asset:    ctx.accounts.asset.key(),
            owner:    ctx.accounts.payer.key(),
            token_id,
            tier: 0,
            price,
        });
        Ok(())
    }

    // ------------------------------------------------------------
    // SEC-26 — TIER PROGRESSION
    // ------------------------------------------------------------

    /// Record one win for the chip that won `game` (a battle-arena
    /// `Battle` or `BattleRoyale` account) and auto-promote its tier
    /// when a threshold is crossed.
    ///
    /// PERMISSIONLESS: any signer may submit — the winner's client does
    /// it as a claim preinstruction, but a watcher/indexer can too.
    /// Safety comes from verification, not identity:
    ///   1. `game.owner` must be the registered battle-arena program.
    ///   2. The 8-byte discriminator must match Battle / BattleRoyale.
    ///   3. The game must be DECIDED or SETTLED.
    ///   4. `chip_data.asset` must equal the WINNER's chip in that game.
    ///   5. `game.id` must exceed `chip_data.last_game_id` — a chip is
    ///      escrowed while it plays, so its game ids strictly increase;
    ///      this makes the call idempotent (replay = WinAlreadyRecorded).
    ///
    /// SEC-9 note: this deliberately replaces the old `record_battle`
    /// CPI-from-arena design — no battle-arena ix grows a CPI, so the
    /// 4 KB BPF stack frame issue cannot resurface.
    pub fn record_chip_win(ctx: Context<RecordChipWin>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(
            cfg.battle_arena_program != Pubkey::default(),
            ChipNftError::ArenaProgramNotSet
        );

        let game = &ctx.accounts.game;
        require_keys_eq!(
            *game.owner,
            cfg.battle_arena_program,
            ChipNftError::WrongGameProgram
        );

        let data = game.try_borrow_data()?;
        require!(data.len() > 8, ChipNftError::BadGameAccount);

        // Manual layout parse (offsets frozen at battle-arena deploy):
        //   Battle:        id@8 player_a@16 chip_a@80 chip_b@112
        //                  status@145 winner@146
        //   BattleRoyale:  id@8 status@16 num_joined@19
        //                  players@52+32i chips@308+32i winner@564
        let (game_id, status, winner_chip): (u64, u8, Pubkey) =
            if data[0..8] == BATTLE_DISC {
                require!(data.len() >= 178 + 32, ChipNftError::BadGameAccount);
                let id       = u64::from_le_bytes(data[8..16].try_into().unwrap());
                let player_a = Pubkey::try_from(&data[16..48]).unwrap();
                let chip_a   = Pubkey::try_from(&data[80..112]).unwrap();
                let chip_b   = Pubkey::try_from(&data[112..144]).unwrap();
                let status   = data[145];
                let winner   = Pubkey::try_from(&data[146..178]).unwrap();
                let wchip    = if winner == player_a { chip_a } else { chip_b };
                (id, status, wchip)
            } else if data[0..8] == ROYALE_DISC {
                require!(data.len() >= 564 + 32, ChipNftError::BadGameAccount);
                let id         = u64::from_le_bytes(data[8..16].try_into().unwrap());
                let status     = data[16];
                let num_joined = (data[19] as usize).min(8);
                let winner     = Pubkey::try_from(&data[564..596]).unwrap();
                let mut wchip  = Pubkey::default();
                for i in 0..num_joined {
                    let p_off = 52 + i * 32;
                    let p = Pubkey::try_from(&data[p_off..p_off + 32]).unwrap();
                    if p == winner {
                        let c_off = 308 + i * 32;
                        wchip = Pubkey::try_from(&data[c_off..c_off + 32]).unwrap();
                        break;
                    }
                }
                (id, status, wchip)
            } else {
                return err!(ChipNftError::BadGameAccount);
            };

        require!(
            status == GAME_DECIDED || status == GAME_SETTLED,
            ChipNftError::GameNotDecided
        );

        let chip = &mut ctx.accounts.chip_data;
        require_keys_eq!(winner_chip, chip.asset, ChipNftError::NotWinnerChip);
        require!(game_id > chip.last_game_id, ChipNftError::WinAlreadyRecorded);

        chip.last_game_id     = game_id;
        chip.progression_wins = chip.progression_wins.saturating_add(1);

        let old_tier = chip.tier;
        let mut new_tier = old_tier;
        while new_tier < TIER_MAX
            && chip.progression_wins >= TIER_THRESHOLDS[new_tier as usize]
        {
            new_tier += 1;
        }

        emit!(ChipWinRecorded {
            asset:   chip.asset,
            game_id,
            wins:    chip.progression_wins,
            tier:    new_tier,
        });

        if new_tier != old_tier {
            chip.tier = new_tier;
            emit!(ChipPromoted {
                asset:    chip.asset,
                old_tier,
                new_tier,
                wins: chip.progression_wins,
            });
        }
        Ok(())
    }
}

// ============================================================
//                          ACCOUNTS
// ============================================================

#[account]
pub struct ChipNftConfig {
    pub owner:                Pubkey,
    pub battle_authority:     Pubkey,   // audit field (SEC-9)
    // SEC-26 — trusted owner of the Battle/BattleRoyale accounts that
    // `record_chip_win` parses.
    pub battle_arena_program: Pubkey,
    pub mint_enabled:         bool,
    pub next_token_id:        u64,      // monotonically increasing
    pub mint_price:           u64,      // SEC-26: single flat T0 price
    pub max_supply:           u64,      // 0 = unlimited
    pub minted_count:         u64,
    pub bump:                 u8,
    pub vault_bump:           u8,
    // SEC-20 — see TreasuryConfig and CLAUDE.md "PDA versioning".
    pub _reserved:            [u8; 64],
}

impl Default for ChipNftConfig {
    fn default() -> Self {
        Self {
            owner:                Pubkey::default(),
            battle_authority:     Pubkey::default(),
            battle_arena_program: Pubkey::default(),
            mint_enabled:         false,
            next_token_id:        0,
            mint_price:           0,
            max_supply:           0,
            minted_count:         0,
            bump:                 0,
            vault_bump:           0,
            _reserved:            [0u8; 64],
        }
    }
}

impl ChipNftConfig {
    // 8 discr + 32 + 32 + 32 + 1 + 8 + 8 + 8 + 8 + 1 + 1 + 64 = 195
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 1 + 8 + 8 + 8 + 8 + 1 + 1 + 64;
}

#[account]
#[derive(Default)]
pub struct ChipData {
    pub asset:            Pubkey,
    pub token_id:         u64,
    // SEC-26 — tier (0..4) + win-based progression.
    pub tier:             u8,
    pub progression_wins: u32,
    pub last_game_id:     u64,   // monotonic replay guard for record_chip_win
    pub minted_at:        i64,
    pub bump:             u8,
    pub _reserved:        [u8; 16],
}

impl ChipData {
    // 8 discr + 32 + 8 + 1 + 4 + 8 + 8 + 1 + 16 = 86
    pub const SPACE: usize = 8 + 32 + 8 + 1 + 4 + 8 + 8 + 1 + 16;
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

// SEC-26 — permissionless win recording (see handler doc).
#[derive(Accounts)]
pub struct RecordChipWin<'info> {
    #[account(
        seeds = [b"chip_nft".as_ref()],
        bump  = config.bump,
    )]
    pub config: Account<'info, ChipNftConfig>,

    #[account(
        mut,
        seeds = [b"chip".as_ref(), chip_data.asset.as_ref()],
        bump  = chip_data.bump,
    )]
    pub chip_data: Account<'info, ChipData>,

    /// CHECK: a battle-arena `Battle` or `BattleRoyale` account.
    /// Ownership, discriminator, status, winner-chip linkage and replay
    /// protection are all verified in the handler.
    pub game: AccountInfo<'info>,

    pub caller: Signer<'info>,
}

// ============================================================
//                          EVENTS
// ============================================================

#[event] pub struct ChipNftInitialized        { pub owner: Pubkey }
#[event] pub struct MintPriceUpdated          { pub new_price: u64 }
#[event] pub struct BattleAuthorityUpdated    { pub authority: Pubkey }
// SEC-19 — admin audit events.
#[event] pub struct MintEnabledUpdated        { pub enabled: bool }
#[event] pub struct MaxSupplyUpdated          { pub supply: u64 }
// SEC-26.
#[event] pub struct BattleArenaProgramUpdated { pub program: Pubkey }
#[event]
pub struct ChipMinted {
    pub asset:    Pubkey,
    pub owner:    Pubkey,
    pub token_id: u64,
    pub tier:     u8,
    pub price:    u64,
}
// SEC-26 — progression events (indexer mirrors these into `chips`).
#[event]
pub struct ChipWinRecorded {
    pub asset:   Pubkey,
    pub game_id: u64,
    pub wins:    u32,
    pub tier:    u8,
}
#[event]
pub struct ChipPromoted {
    pub asset:    Pubkey,
    pub old_tier: u8,
    pub new_tier: u8,
    pub wins:     u32,
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
    // SEC-26: rarity is gone; slot kept so codes don't shift.
    #[msg("(deprecated)")]
    InvalidRarityDeprecated,
    #[msg("Maximum supply has been reached")]
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
    // SEC-26 — record_chip_win.
    #[msg("battle_arena_program is not configured")]
    ArenaProgramNotSet,
    #[msg("Game account is not owned by the registered battle-arena program")]
    WrongGameProgram,
    #[msg("Account is not a Battle or BattleRoyale")]
    BadGameAccount,
    #[msg("Game is not decided yet")]
    GameNotDecided,
    #[msg("Chip is not the winner of this game")]
    NotWinnerChip,
    #[msg("Win for this game was already recorded")]
    WinAlreadyRecorded,
}
