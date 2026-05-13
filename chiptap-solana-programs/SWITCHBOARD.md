# Switchboard On-Demand VRF — integration recipe

The current `battle_arena::fulfill_random_words(seed: u64)` is a **mock
VRF** gated by `config.vrf_authority` (a single registered signer).
For localnet and the smoke tests this is the owner keypair.  For
testnet / mainnet, swap to Switchboard On-Demand by following the
checklist below.

Status: **interface ready, devnet integration not yet performed.**

## Why not mid-session?

End-to-end requires a live Switchboard queue on devnet/mainnet plus a
funded keypair to commit/reveal randomness — not reproducible from a
local Windows + WSL2 dev box.  The integration path below is the
mechanical translation; once you have devnet access, work through it
top-to-bottom.

## Threat model

Today: trust `config.vrf_authority` to pick `seed` honestly.  Compromise
of that key = winner control.  The owner-only `set_vrf_authority` ix
already exists for rotation.

Target: `seed` is the SHA-256 of a Switchboard randomness account's
revealed value.  Even if our relayer bot is compromised it can only
*refuse* to call us, not choose the winner.

## Off-chain (the relayer bot)

The relayer is a small Node service.  Per joined battle, it:

1. Creates a Switchboard randomness account on the configured queue.
2. Submits `randomness_commit` to Switchboard with `slothash_provided
   = recent slot`.
3. Waits for the commit slot to be confirmed (slot delay configurable
   on the queue; devnet default is small).
4. Submits `randomness_reveal` (anyone can — the oracles attached to
   that queue actually do it).
5. Reads the revealed value (32 bytes) from the randomness account.
6. Calls our existing `fulfill_random_words(seed)` with
   `seed = u64::from_le_bytes(value[0..8])`, signing as
   `config.vrf_authority`.

For deployment, the relayer's wallet key IS the `vrf_authority`.
Replace it with `set_vrf_authority` when rotating.

## On-chain (battle-arena changes)

Two options, in increasing order of work:

### Option A: trusted relayer (interim)

**No program changes.**  Production deploys the relayer bot, points its
keypair at `vrf_authority`, and relies on it to honestly read the
Switchboard randomness.  Equivalent to the mock — but the bot's logic
is auditable open source.

### Option B: on-chain verification (target)

Add a new instruction `fulfill_random_words_switchboard` that takes a
`randomness_account: AccountInfo`, validates `owner ==
config.vrf_program`, reads `RandomnessAccountData` via the
`switchboard-on-demand` crate, and checks:

```rust
require!(randomness_account.owner == &cfg.vrf_program, …);
let data = randomness_account.try_borrow_data()?;
let acc  = RandomnessAccountData::parse(data)?;
let value = acc.get_value(&Clock::get()?)?;   // panics if too early or reveal expired
let seed  = u64::from_le_bytes(value[..8].try_into().unwrap());
```

…then write the seed to `battle.random_seed` the same way the mock does.

Dependency: `switchboard-on-demand = "0.1.x"` in `battle-arena/Cargo.toml`.
**Risk**: borsh / anchor version conflicts (see CLAUDE.md gotchas — we
already hit this with mpl-core 0.12).  Pin Switchboard's borsh feature
flag to match Anchor 0.30's.  Build with `--no-idl` and regenerate IDLs
through `gen-idls.js`.

Also: add `vrf_program: Pubkey` to `ArenaConfig` plus an admin setter.
This is a PDA layout change — see CLAUDE.md "PDA versioning" gotcha;
plan to land alongside the reserved-padding migration so we don't burn
two migration windows.

## Devnet test plan (TODO once funded)

1. Build a queue on devnet (`switchboard-cli queue create`).
2. Deploy the programs to devnet (same `Anchor.toml` cluster swap).
3. Spin up the relayer with `vrf_authority` matching its wallet.
4. Mint chips on devnet via UI.
5. Run a battle.
6. Verify the relayer logs commit + reveal + fulfill.
7. Confirm `Battle.random_seed` matches the Switchboard `value[..8]`
   slice exactly.
8. Soak-test for a week; check no settled battle was decided by an
   off-pattern seed (i.e. relayer is not silently fudging).
