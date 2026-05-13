// ============================================================
// gen-idls.js — emits Anchor 0.30 IDL JSONs for all 3 programs
// ============================================================
//
// Run once:
//   node gen-idls.js
//
// Outputs:
//   target/idl/treasury.json
//   target/idl/chip_nft.json
//   target/idl/battle_arena.json
//
// Then copy them into:
//   chiptap-solana-indexer/idl/
//   chiptap-solana-frontend/src/idl/
//
// We hand-write IDLs because `anchor build` (with IDL) is wedged on
// new Rust due to proc_macro::SourceFile being removed from std.
// ============================================================

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const sha8 = (s) =>
  Array.from(crypto.createHash("sha256").update(s).digest().slice(0, 8));

// ---- helpers for the IDL DSL ----
const PUBKEY = "pubkey";
const arr   = (t, n) => ({ array: [t, n] });
const opt   = (t)    => ({ option: t });
const def   = (name) => ({ defined: { name } });

const ev    = (name) => ({ name, discriminator: sha8(`event:${name}`) });
const acc   = (name) => ({ name, discriminator: sha8(`account:${name}`) });
const ix    = (snake_name, accounts, args = [], returns = undefined) => {
  const obj = {
    name: snake_name,
    discriminator: sha8(`global:${snake_name}`),
    accounts,
    args,
  };
  if (returns) obj.returns = returns;
  return obj;
};

// account-meta builders
const A = (name, opts = {}) => ({ name, ...opts });
const W = (name, opts = {}) => ({ name, writable: true, ...opts });
const S = (name, opts = {}) => ({ name, signer: true, ...opts });
const WS = (name, opts = {}) => ({ name, writable: true, signer: true, ...opts });
const SP = { name: "system_program", address: "11111111111111111111111111111111" };
const MPL = { name: "mpl_core", address: "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d" };

// ============================================================
//                         TREASURY
// ============================================================

const TREASURY_ID = "wGAqdvJJV2DTHUgkDxdMkWotTvg8Q7r5kz5NntWESPp";

const treasuryIdl = {
  address: TREASURY_ID,
  metadata: { name: "treasury", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    ix("initialize", [
      WS("owner"),
      W ("config"),
      W ("vault"),
      SP,
    ]),
    ix("set_battle_arena", [
      W("config"),
      S("owner"),
    ], [{ name: "battle_arena", type: PUBKEY }]),
    ix("record_fee", [
      W("config"),
      W("vault"),
      WS("arena_vault"),
      SP,
    ], [{ name: "amount", type: "u64" }]),
    ix("withdraw", [
      W("config"),
      W("vault"),
      WS("owner"),
      SP,
    ], [{ name: "amount", type: "u64" }]),
  ],
  accounts: [acc("TreasuryConfig")],
  events: [
    ev("TreasuryInitialized"),
    ev("BattleArenaUpdated"),
    ev("FeeRecorded"),
    ev("Withdrawn"),
  ],
  errors: [
    { code: 6000, name: "NotDepositor",         msg: "Caller is not the registered BattleArena depositor" },
    { code: 6001, name: "NotOwner",             msg: "Caller is not the treasury owner" },
    { code: 6002, name: "InsufficientBalance",  msg: "Vault has insufficient lamports above rent minimum" },
    { code: 6003, name: "ZeroAmount",           msg: "Amount must be greater than zero" },
    { code: 6004, name: "MathOverflow",         msg: "Arithmetic overflow" },
  ],
  types: [
    {
      name: "TreasuryConfig",
      type: {
        kind: "struct",
        fields: [
          { name: "owner",            type: PUBKEY },
          { name: "battle_arena",     type: PUBKEY },
          { name: "total_collected",  type: "u64" },
          { name: "total_withdrawn",  type: "u64" },
          { name: "bump",             type: "u8" },
          { name: "vault_bump",       type: "u8" },
          // SEC-20 forward-compat padding (see CLAUDE.md)
          { name: "_reserved",        type: arr("u8", 64) },
        ],
      },
    },
    { name: "TreasuryInitialized", type: { kind: "struct", fields: [{ name: "owner", type: PUBKEY }] } },
    { name: "BattleArenaUpdated",  type: { kind: "struct", fields: [{ name: "battle_arena", type: PUBKEY }] } },
    { name: "FeeRecorded",         type: { kind: "struct", fields: [{ name: "amount", type: "u64" }] } },
    { name: "Withdrawn",           type: { kind: "struct", fields: [{ name: "to", type: PUBKEY }, { name: "amount", type: "u64" }] } },
  ],
};

// ============================================================
//                          CHIP-NFT
// ============================================================

const CHIP_NFT_ID = "A8fqFHnTHAAq3B5t22S8RAix4neNTXTp7RaZ6aQbk5qQ";

const chipNftIdl = {
  address: CHIP_NFT_ID,
  metadata: { name: "chip_nft", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    ix("initialize", [
      WS("owner"),
      W ("config"),
      W ("vault"),
      SP,
    ]),
    ix("set_mint_enabled",  [W("config"), S("owner")], [{ name: "enabled", type: "bool" }]),
    ix("set_mint_price",    [W("config"), S("owner")], [{ name: "rarity", type: "u8" }, { name: "price_lamports", type: "u64" }]),
    ix("set_max_supply",    [W("config"), S("owner")], [{ name: "rarity", type: "u8" }, { name: "supply", type: "u32" }]),
    ix("set_battle_authority", [W("config"), S("owner")], [{ name: "authority", type: PUBKEY }]),
    ix("withdraw",          [W("config"), W("vault"), WS("owner"), SP], [{ name: "amount", type: "u64" }]),
    ix("mint_chip", [
      W ("config"),
      W ("vault"),
      WS("asset"),
      W ("chip_data"),
      WS("payer"),
      MPL,
      SP,
    ], [
      { name: "rarity", type: "u8" },
      { name: "name",   type: "string" },
      { name: "uri",    type: "string" },
    ]),
    // SEC-9 — `record_battle` removed.  Stats live in the indexer now.
  ],
  accounts: [acc("ChipNftConfig"), acc("ChipData")],
  events: [
    ev("ChipNftInitialized"),
    ev("MintPriceUpdated"),
    ev("BattleAuthorityUpdated"),
    ev("ChipMinted"),
    // SEC-19
    ev("MintEnabledUpdated"),
    ev("MaxSupplyUpdated"),
  ],
  errors: [
    { code: 6000, name: "NotOwner",                    msg: "Caller is not the owner" },
    { code: 6001, name: "NotBattleAuthorityDeprecated", msg: "(deprecated)" },
    { code: 6002, name: "MintDisabled",        msg: "Mint is currently disabled" },
    { code: 6003, name: "InvalidRarity",       msg: "Invalid rarity" },
    { code: 6004, name: "MaxSupplyReached",    msg: "Maximum supply for this rarity has been reached" },
    { code: 6005, name: "InsufficientBalance", msg: "Vault has insufficient lamports above rent minimum" },
    { code: 6006, name: "ZeroAmount",          msg: "Amount must be greater than zero" },
    { code: 6007, name: "NameTooLong",         msg: "Asset name exceeds 32 bytes" },
    { code: 6008, name: "UriTooLong",          msg: "Asset URI exceeds 200 bytes" },
    { code: 6009, name: "MathOverflow",        msg: "Arithmetic overflow" },
  ],
  types: [
    {
      name: "ChipNftConfig",
      type: { kind: "struct", fields: [
        { name: "owner",            type: PUBKEY },
        { name: "battle_authority", type: PUBKEY },
        { name: "mint_enabled",     type: "bool" },
        { name: "next_token_id",    type: "u64" },
        { name: "mint_price",       type: arr("u64", 5) },
        { name: "max_supply",       type: arr("u32", 5) },
        { name: "minted_count",     type: arr("u32", 5) },
        { name: "bump",             type: "u8" },
        { name: "vault_bump",       type: "u8" },
        // SEC-20 forward-compat padding
        { name: "_reserved",        type: arr("u8", 64) },
      ]},
    },
    {
      name: "ChipData",
      type: { kind: "struct", fields: [
        { name: "asset",     type: PUBKEY },
        { name: "token_id",  type: "u64" },
        { name: "rarity",    type: "u8" },
        { name: "minted_at", type: "i64" },
        { name: "bump",      type: "u8" },
      ]},
    },
    { name: "ChipNftInitialized",     type: { kind: "struct", fields: [{ name: "owner", type: PUBKEY }] } },
    { name: "MintPriceUpdated",       type: { kind: "struct", fields: [{ name: "rarity", type: "u8" }, { name: "new_price", type: "u64" }] } },
    { name: "BattleAuthorityUpdated", type: { kind: "struct", fields: [{ name: "authority", type: PUBKEY }] } },
    { name: "ChipMinted",             type: { kind: "struct", fields: [
      { name: "asset", type: PUBKEY },
      { name: "owner", type: PUBKEY },
      { name: "token_id", type: "u64" },
      { name: "rarity", type: "u8" },
      { name: "price",  type: "u64" },
    ] } },
    // SEC-19
    { name: "MintEnabledUpdated", type: { kind: "struct", fields: [{ name: "enabled", type: "bool" }] } },
    { name: "MaxSupplyUpdated",   type: { kind: "struct", fields: [
      { name: "rarity", type: "u8" },
      { name: "supply", type: "u32" },
    ] } },
  ],
};

// ============================================================
//                        BATTLE-ARENA
// ============================================================

const ARENA_ID = "Ae65nkzg2DD4dFUttxUXPpVfZT7kMPX1L9Uk9GDxkBU8";

const arenaIdl = {
  address: ARENA_ID,
  metadata: { name: "battle_arena", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    ix("initialize", [
      WS("owner"),
      W ("config"),
      W ("vault"),
      W ("chip_authority"),
      A ("chip_nft_program"),
      A ("treasury_program"),
      SP,
    ]),
    ix("set_paused",            [W("config"), S("owner")], [{ name: "paused", type: "bool" }]),
    ix("set_fee_bps",           [W("config"), S("owner")], [{ name: "fee_bps", type: "u16" }]),
    ix("set_pool_amount",       [W("config"), S("owner")], [{ name: "tier", type: "u8" }, { name: "lamports", type: "u64" }]),
    ix("set_decision_timeout",  [W("config"), S("owner")], [{ name: "seconds", type: "i64" }]),
    ix("set_join_timeout",      [W("config"), S("owner")], [{ name: "seconds", type: "i64" }]),
    ix("set_vrf_timeout",       [W("config"), S("owner")], [{ name: "seconds", type: "i64" }]),
    ix("set_vrf_authority",     [W("config"), S("owner")], [{ name: "authority", type: PUBKEY }]),

    ix("ensure_user_account", [
      W ("user"),
      A ("authority"),
      WS("payer"),
      SP,
    ]),

    ix("deposit", [
      A ("config"),
      W ("vault"),
      W ("user"),
      WS("payer"),
      SP,
    ], [{ name: "amount", type: "u64" }]),

    ix("withdraw", [
      A ("config"),
      W ("vault"),
      W ("user"),
      WS("authority"),
      SP,
    ], [{ name: "amount", type: "u64" }]),

    ix("create_battle", [
      W ("config"),
      W ("battle"),
      A ("chip_authority"),
      W ("chip"),
      WS("player"),
      MPL,
      SP,
    ], [{ name: "pool_tier", type: "u8" }]),

    ix("join_battle", [
      A ("config"),
      W ("battle"),
      A ("chip_authority"),
      W ("chip"),
      WS("player"),
      MPL,
      SP,
    ]),

    ix("cancel_battle", [
      A ("config"),
      W ("battle"),
      A ("chip_authority"),
      W ("chip_a"),
      WS("player"),
      MPL,
      SP,
    ]),

    ix("fulfill_random_words", [
      A ("config"),
      W ("battle"),
      S ("vrf_authority"),
    ], [{ name: "seed", type: "u64" }]),

    ix("claim_winner_chip", [
      A ("config"),
      A ("battle"),
      A ("chip_authority"),
      W ("chip"),
      WS("winner"),
      MPL,
      SP,
    ]),

    ix("pay_ransom", [
      W ("config"),
      W ("battle"),
      A ("chip_authority"),
      W ("vault"),
      W ("loser_user"),
      W ("winner_user"),
      W ("chip_loser"),
      W ("treasury_config"),
      W ("treasury_vault"),
      A ("treasury_program"),
      WS("loser"),
      A ("winner"),
      MPL,
      SP,
    ]),

    ix("forfeit_chip", [
      A ("config"),
      W ("battle"),
      A ("chip_authority"),
      W ("chip_loser"),
      S ("loser"),
      W ("winner"),
      MPL,
      SP,
    ]),

    ix("expire_decision", [
      A ("config"),
      W ("battle"),
      A ("chip_authority"),
      W ("chip_loser"),
      A ("loser"),       // SEC-8: was Signer — now address-constrained only
      W ("winner"),      // chip recipient; address-constrained in program
      WS("caller"),      // anyone — just pays the gas
      MPL,
      SP,
    ]),

    ix("expire_join", [
      A ("config"),
      W ("battle"),
      A ("chip_authority"),
      W ("chip_a"),
      W ("player_a"),    // SEC-2: chip recipient; address-constrained in program
      WS("caller"),      // anyone — just pays the gas
      MPL,
      SP,
    ]),

    ix("force_resolve", [
      A ("config"),
      W ("battle"),
      A ("chip_authority"),
      W ("chip_a"),
      W ("chip_b"),
      W ("player_a"),
      W ("player_b"),
      MPL,
      SP,
    ]),
  ],

  accounts: [acc("ArenaConfig"), acc("UserAccount"), acc("Battle")],

  events: [
    ev("ArenaInitialized"),
    ev("Deposited"),
    ev("Withdrawn"),
    ev("BattleCreated"),
    ev("BattleJoined"),
    ev("BattleDecided"),
    ev("BattleSettledPaid"),
    ev("BattleSettledForfeited"),
    ev("BattleCancelled"),
    ev("BattleExpired"),
    ev("VrfTimedOut"),
    // SEC-19 — admin audit events
    ev("PausedUpdated"),
    ev("FeeBpsUpdated"),
    ev("PoolAmountUpdated"),
    ev("TimeoutUpdated"),
    ev("VrfAuthorityUpdated"),
  ],

  errors: [
    { code: 6000,  name: "NotOwner",              msg: "Caller is not the configured owner / authority" },
    { code: 6001,  name: "Paused",                msg: "Battles are paused" },
    { code: 6002,  name: "WrongStatus",           msg: "Wrong battle status for this action" },
    { code: 6003,  name: "CannotJoinOwnBattle",   msg: "Cannot join your own battle" },
    { code: 6004,  name: "NotYourBattle",         msg: "Caller is not playerA" },
    { code: 6005,  name: "NotWinner",             msg: "Caller is not the winner" },
    { code: 6006,  name: "NotLoser",              msg: "Caller is not the loser" },
    { code: 6007,  name: "DecisionPeriodExpired", msg: "Decision period has expired" },
    { code: 6008,  name: "DecisionPeriodActive",  msg: "Decision period still active" },
    { code: 6009,  name: "JoinPeriodNotExpired",  msg: "Join period has not expired" },
    { code: 6010, name: "VrfNotTimedOut",        msg: "VRF has not timed out yet" },
    { code: 6011, name: "NotVrfAuthority",       msg: "Caller is not the registered VRF authority" },
    { code: 6012, name: "InvalidTier",           msg: "Pool tier index out of range" },
    { code: 6013, name: "InvalidTimeout",        msg: "Invalid timeout (out of allowed window)" },
    { code: 6014, name: "FeeTooHigh",            msg: "Fee bps too high (max 10%)" },
    { code: 6015, name: "InsufficientBalance",   msg: "Insufficient internal balance" },
    { code: 6016, name: "ZeroAmount",            msg: "Amount must be greater than zero" },
    { code: 6017, name: "WrongChip",             msg: "Wrong chip account passed for this battle slot" },
    { code: 6018, name: "WrongPlayer",           msg: "Wrong player account — does not match battle.player_a / player_b" },
    { code: 6019, name: "MathOverflow",          msg: "Arithmetic overflow" },
  ],

  types: [
    {
      name: "ArenaConfig",
      type: { kind: "struct", fields: [
        { name: "owner",                type: PUBKEY },
        { name: "chip_nft_program",     type: PUBKEY },
        { name: "treasury_program",     type: PUBKEY },
        { name: "vrf_authority",        type: PUBKEY },
        { name: "next_battle_id",       type: "u64" },
        { name: "pool_amounts",         type: arr("u64", 6) },
        { name: "fee_bps",              type: "u16" },
        { name: "decision_timeout",     type: "i64" },
        { name: "join_timeout",         type: "i64" },
        { name: "vrf_timeout",          type: "i64" },
        { name: "paused",               type: "bool" },
        { name: "bump",                 type: "u8" },
        { name: "vault_bump",           type: "u8" },
        { name: "chip_authority_bump",  type: "u8" },
        // SEC-20 forward-compat padding
        { name: "_reserved",            type: arr("u8", 64) },
      ]},
    },
    {
      name: "UserAccount",
      type: { kind: "struct", fields: [
        { name: "authority", type: PUBKEY },
        { name: "balance",   type: "u64" },
        { name: "locked",    type: "u64" },
        { name: "bump",      type: "u8" },
      ]},
    },
    {
      name: "Battle",
      type: { kind: "struct", fields: [
        { name: "id",              type: "u64" },
        { name: "player_a",        type: PUBKEY },
        { name: "player_b",        type: PUBKEY },
        { name: "chip_a",          type: PUBKEY },
        { name: "chip_b",          type: PUBKEY },
        { name: "pool_tier",       type: "u8" },
        { name: "status",          type: "u8" },
        { name: "winner",          type: PUBKEY },
        { name: "loser",           type: PUBKEY },
        { name: "random_seed",     type: "u64" },
        { name: "resolution",      type: "u8" },
        { name: "payment_amount",  type: "u64" },
        { name: "fee_amount",      type: "u64" },
        { name: "created_at",      type: "i64" },
        { name: "decided_at",      type: "i64" },
        { name: "settled_at",      type: "i64" },
        { name: "rolling_at",      type: "i64" },
        { name: "vrf_request_id",  type: "u64" },
        { name: "bump",            type: "u8" },
      ]},
    },
    { name: "ArenaInitialized",       type: { kind: "struct", fields: [
      { name: "owner", type: PUBKEY },
      { name: "chip_authority", type: PUBKEY },
    ]}},
    { name: "Deposited", type: { kind: "struct", fields: [
      { name: "user", type: PUBKEY }, { name: "amount", type: "u64" }, { name: "balance", type: "u64" },
    ]}},
    { name: "Withdrawn", type: { kind: "struct", fields: [
      { name: "user", type: PUBKEY }, { name: "amount", type: "u64" }, { name: "balance", type: "u64" },
    ]}},
    { name: "BattleCreated", type: { kind: "struct", fields: [
      { name: "battle_id", type: "u64" },
      { name: "player_a",  type: PUBKEY },
      { name: "chip_a",    type: PUBKEY },
      { name: "pool_tier", type: "u8" },
    ]}},
    { name: "BattleJoined", type: { kind: "struct", fields: [
      { name: "battle_id",       type: "u64" },
      { name: "player_b",        type: PUBKEY },
      { name: "chip_b",          type: PUBKEY },
      { name: "vrf_request_id",  type: "u64" },
    ]}},
    { name: "BattleDecided", type: { kind: "struct", fields: [
      { name: "battle_id",   type: "u64" },
      { name: "winner",      type: PUBKEY },
      { name: "loser",       type: PUBKEY },
      { name: "random_seed", type: "u64" },
    ]}},
    { name: "BattleSettledPaid", type: { kind: "struct", fields: [
      { name: "battle_id", type: "u64" },
      { name: "loser",     type: PUBKEY },
      { name: "payment",   type: "u64" },
      { name: "fee",       type: "u64" },
    ]}},
    { name: "BattleSettledForfeited", type: { kind: "struct", fields: [
      { name: "battle_id",      type: "u64" },
      { name: "loser",          type: PUBKEY },
      { name: "chip_forfeited", type: PUBKEY },
    ]}},
    { name: "BattleCancelled", type: { kind: "struct", fields: [
      { name: "battle_id", type: "u64" },
      { name: "player_a",  type: PUBKEY },
    ]}},
    { name: "BattleExpired", type: { kind: "struct", fields: [
      { name: "battle_id", type: "u64" },
      { name: "loser",     type: PUBKEY },
    ]}},
    { name: "VrfTimedOut", type: { kind: "struct", fields: [
      { name: "battle_id", type: "u64" },
    ]}},
    // SEC-19
    { name: "PausedUpdated",       type: { kind: "struct", fields: [{ name: "paused",  type: "bool" }] }},
    { name: "FeeBpsUpdated",       type: { kind: "struct", fields: [{ name: "fee_bps", type: "u16" }] }},
    { name: "PoolAmountUpdated",   type: { kind: "struct", fields: [
      { name: "tier",     type: "u8"  },
      { name: "lamports", type: "u64" },
    ]}},
    { name: "TimeoutUpdated",      type: { kind: "struct", fields: [
      { name: "kind",    type: "u8"  },
      { name: "seconds", type: "i64" },
    ]}},
    { name: "VrfAuthorityUpdated", type: { kind: "struct", fields: [{ name: "authority", type: PUBKEY }]}},
  ],
};

// ============================================================
//                       WRITE OUTPUT
// ============================================================

const outDir = path.join(__dirname, "target", "idl");
fs.mkdirSync(outDir, { recursive: true });

for (const [name, idl] of Object.entries({
  treasury: treasuryIdl,
  chip_nft: chipNftIdl,
  battle_arena: arenaIdl,
})) {
  const file = path.join(outDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(idl, null, 2));
  console.log(`wrote ${file} (${idl.instructions.length} ix, ${idl.events.length} ev, ${idl.types.length} types)`);
}
