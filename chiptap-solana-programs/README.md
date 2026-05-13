# ChipTap on Solana — programs

Anchor workspace with three programs:

```
chiptap-solana-programs/
├── programs/
│   ├── chip-nft        # Mints Metaplex Core Asset NFTs + on-chain stats PDA
│   ├── treasury        # Collects 5% platform fees in a PDA vault
│   └── battle-arena    # Game logic + UserAccount internal-balance ledger
├── tests/              # ts-mocha + Anchor TS client
├── migrations/         # post-deploy wiring (idempotent)
└── ARCHITECTURE.md     # design decisions — read first if changing accounts
```

The full design rationale (account layouts, SOL-flow, security
parity with EVM v2) is in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Prerequisites — set up WSL2

The Solana toolchain is Linux-first. Native Windows builds frequently break
on `cargo build-sbf`. Use **WSL2 (Ubuntu 22.04)** and clone the repo *inside*
the WSL filesystem (not a Windows-mounted path — IO is much faster).

```bash
# inside WSL2 Ubuntu
sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev curl git

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

# Solana CLI 1.18.22
sh -c "$(curl -sSfL https://release.solana.com/v1.18.22/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Anchor (avm = anchor version manager)
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1
avm use 0.30.1

# Node + Yarn
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g yarn

# Sanity
solana --version    # 1.18.22
anchor --version    # 0.30.1
```

Generate a local keypair (only used for tests + localnet):

```bash
solana-keygen new --outfile ~/.config/solana/id.json
solana config set --url localhost
solana airdrop 100
```

---

## Build

```bash
cd chiptap-solana-programs
yarn install
anchor build
```

First build downloads ~150 MB of Solana BPF crates. Subsequent builds are
seconds. Output goes to `target/deploy/*.so` and `target/idl/*.json`.

If you change Rust sources but `anchor.workspace.*` returns `undefined` in
tests, regenerate the IDL: `anchor build && anchor idl init` is rarely needed,
just rerun `anchor build`.

---

## Test (localnet)

```bash
anchor test
```

This:
1. Builds programs.
2. Spawns a local `solana-test-validator` (cloned with the Metaplex Core
   program from devnet — see `Anchor.toml`).
3. Deploys the three programs.
4. Runs `tests/**/*.ts` via ts-mocha.

To re-run tests against an already-running validator (faster iteration):

```bash
solana-test-validator --reset \
  --clone CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d --url devnet
# in another shell:
anchor test --skip-local-validator
```

---

## Deploy

### Localnet

```bash
solana-test-validator --reset --clone CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d --url devnet &
anchor deploy --provider.cluster localnet
anchor run deploy --provider.cluster localnet
```

### Devnet

Get devnet SOL first:

```bash
solana config set --url devnet
solana airdrop 5            # repeat as needed; faucet caps at 2 SOL/req
```

Then:

```bash
anchor build
anchor deploy --provider.cluster devnet
anchor run deploy --provider.cluster devnet
```

The `migrations/deploy.ts` script runs `initialize` and cross-wires the
programs — idempotent, safe to rerun.

After devnet deploy, copy the printed program IDs into:

* `Anchor.toml` `[programs.devnet]`
* `chiptap-solana-frontend/src/config/index.ts` (TODO — added in next phase)
* `chiptap-solana-indexer/.env` (TODO — added in next phase)

---

## Manual end-to-end smoke

For a non-test interaction loop after deploying to localnet/devnet:

```bash
anchor run smoke         # TODO: not yet wired; tests/smoke.ts is the substitute
```

For now, `anchor test` runs `tests/smoke.ts` which mirrors the EVM
`scripts/e2e-battle.js` happy-path: mint × 2 → create → join → fulfill VRF →
pay ransom → withdraw.

---

## Common errors

| Error | Cause / fix |
|---|---|
| `error: linker 'cc' not found` | `sudo apt install build-essential` |
| `Provider URL: not provided` | `export ANCHOR_PROVIDER_URL=http://localhost:8899` |
| `Wallet not provided` | `export ANCHOR_WALLET=$HOME/.config/solana/id.json` |
| `Account does not exist or has no data` (test setup) | Validator was reset, re-run `anchor test` (which starts fresh validator) |
| `Program failed to complete: BPF program panicked` | Rust panic — check program logs: `solana logs` |
| `Already in use` on init | Idempotent guard caught it; safe to ignore |
| `Custom program error: 0x1771` | Anchor `ConstraintSeeds` — passed wrong PDA somewhere; double-check `helpers.pda.*` |
| Endless `cargo build-sbf` on slow machine | First build only; subsequent runs are sub-second |

---

## Next milestones (tracked separately)

* Indexer rewrite (`chiptap-solana-indexer/`) using `Connection.onLogs`
  + Postgres schema kept identical to EVM version.
* Frontend rewrite (`chiptap-solana-frontend/`) replacing wagmi with
  `@solana/wallet-adapter-react` and Anchor TS client.
* CI: add Rust + Solana toolchain to `.github/workflows/ci.yml`.
* Switchboard On-Demand VRF integration for mainnet (mock VRF stays for
  localnet/devnet).
