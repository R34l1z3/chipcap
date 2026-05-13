# ChipTap PvP — Full Project

[![CI EVM](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![CI Solana](../../actions/workflows/solana-ci.yml/badge.svg)](../../actions/workflows/solana-ci.yml)

1v1 blockchain battle game. 2 players stake NFT chips, on-chain randomness picks the winner, loser chooses to pay ransom OR forfeit chip.

Two complete stacks live side-by-side:

| Stack | Chain | NFT std | Wallet | Status |
|---|---|---|---|---|
| **Polygon** | EVM (Solidity, Hardhat, ethers v6, wagmi) | ERC-721 | MetaMask / WalletConnect | shipped (44 tests, CI green, prod docker) |
| **Solana** | Anchor 0.30 + `@solana/web3.js` | Metaplex Core | Phantom / Solflare / Backpack | hardened (SEC-1…19, attack-smoke + idempotency + WS-auth regressions green) |

> **Contributors and Claude-Code sessions: read [`CLAUDE.md`](./CLAUDE.md) first.**
> It pins toolchain versions, lists the (numerous) Solana gotchas
> (`anchor build` IDL pipeline wedged on Rust ≥ 1.95, BPF 4 KB stack
> overflows, init_if_needed-in-PayRansom footgun, etc.), and is the
> source of truth for the SEC-* hardening tags referenced in code
> comments and commit messages.

---

## Project Structure

```
chiptap-full/
├── chiptap-contracts/         # ── EVM (Polygon) ─────────────────
├── chiptap-indexer/           #     Solidity contracts + Node.js
├── chiptap-pvp-frontend/      #     indexer + React/wagmi frontend
├── chiptap-nft-metadata/      #     SVG + IPFS metadata generators
│
├── chiptap-solana-programs/   # ── Solana (Anchor 0.30) ─────────
├── chiptap-solana-indexer/    #     Anchor programs + Node.js
├── chiptap-solana-frontend/   #     indexer + React/wallet-adapter
│
└── .github/workflows/         #     ci.yml (EVM) + solana-ci.yml
```

The Solana stack is intentionally separate from the EVM one — same UX,
different chain. Pick one for production; for an MVP, develop them in
parallel and decide later. Indexer DB schema is the same shape on both
sides (only field types differ), so the frontend's REST API layer is
nearly identical.

For Solana-specific design decisions (UserAccount internal-balance
ledger, fixed-SOL pricing, mock VRF for localnet → Switchboard for
mainnet), read `chiptap-solana-programs/ARCHITECTURE.md`.

---

## Quick Start — Local Testing (Windows / macOS / Linux)

### Prerequisites
- **Node.js 20+** ([download](https://nodejs.org/))
- **Docker Desktop** ([download](https://www.docker.com/products/docker-desktop))
- **Git** and a terminal (PowerShell, bash, or zsh)
- **MetaMask** browser extension

---

### Step 1: Contracts — deploy to local Hardhat node

```powershell
cd chiptap-contracts
npm install
npm test                                          # run the 28+ unit tests
npx hardhat node                                  # keep this terminal open — local blockchain runs here
```

Open a **new terminal**:

```powershell
cd chiptap-contracts
npm run deploy:local                              # deploys ChipNFT + BattleArena v2 + Treasury + mocks
```

Copy the contract addresses printed at the end — you'll need them for frontend + indexer.

**Smoke test** in a third terminal (uses an ephemeral in-process network — does NOT touch the running `hardhat node`):

```powershell
cd chiptap-contracts
npx hardhat run scripts/e2e-battle.js --network hardhat
```

> Note: `npm run deploy:local` deploys to the running node via `--network localhost`,
> while `e2e-battle.js` is meant as a self-contained smoke test on `--network hardhat`.

This runs the full battle lifecycle (deploy → mint → battle → VRF → settle) in one command. Should print `🎉 E2E TEST PASSED`.

---

### Step 2: Indexer — start PostgreSQL + event listener

```powershell
cd ../chiptap-indexer
docker compose up -d                              # PostgreSQL on port 5433
npm install
copy .env.example .env                            # on macOS/Linux: cp .env.example .env
```

Edit `.env` — paste the contract addresses from Step 1:

```env
CHIP_NFT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
BATTLE_ARENA_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
RPC_WS=ws://127.0.0.1:8545
```

Then:

```powershell
npm run db:migrate                                # creates tables (including v2 total_withdrawn)
npm run dev                                       # API on :3002, WS on :3003
```

Verify:
- http://localhost:3002/api/health — should return `{status: "ok"}`
- http://localhost:3002/api/stats — should show zero stats

---

### Step 3: Frontend — connect wallet + play

```powershell
cd ../chiptap-pvp-frontend
npm install
copy .env.example .env
```

Edit `src/config/index.ts` — paste contract addresses into the local network section:

```ts
export const CONTRACTS: Record<number, { chipNFT: `0x${string}`; battleArena: `0x${string}`; treasury: `0x${string}` }> = {
  [hardhat.id]: {  // 31337
    chipNFT: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    battleArena: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    treasury: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  },
  // ... Amoy and Polygon mainnet as needed
};
```

Start the dev server:

```powershell
npm run dev                                       # http://localhost:5173
```

Configure MetaMask:
- Add network: **Hardhat Local**
  - RPC URL: `http://127.0.0.1:8545`
  - Chain ID: `31337`
  - Currency: `MATIC` (or `POL`)
- Import a test account — copy a private key from the Hardhat node terminal (accounts are pre-funded with 10,000 ETH)

---

### Step 4: Play a test battle

1. **Mint chips** — go to MINT page, pick Common rarity, click MINT. You'll need 2 chips (or mint from a second MetaMask account).
2. **Create battle** — Battle Arena → Create → pick $5 pool → select chip → create.
3. **Join battle** — switch to second account, pick your chip, click JOIN.
4. **Trigger VRF** — in a new terminal:
   ```powershell
   cd chiptap-contracts
   npx hardhat console --network hardhat
   ```
   In the console:
   ```js
   const vrf = await ethers.getContractAt("MockVRFCoordinator", "VRF_ADDRESS_FROM_DEPLOY");
   await vrf.fulfillRandomWords(1, [42]);    // request ID 1, even = playerA wins
   ```
5. **Winner claims** → CLAIM CHIP button appears on the winner's screen
6. **Loser chooses** → PAY RANSOM or FORFEIT CHIP
7. If paid: winner sees WithdrawBanner → withdraws winnings

You should see real-time notification toasts and status changes via WebSocket.

---

## Production stack in Docker

The `prod` profile in `chiptap-indexer/docker-compose.yml` brings up a full
self-contained stack:

```
                  ┌────────────────────────────┐
browser  :8080 →  │ chiptap-frontend           │  nginx, SPA + reverse proxy
                  │   /              → SPA      │
                  │   /api/*         → indexer  │
                  │   /ws            → indexer  │
                  └─────────────┬──────────────┘
                                │ docker network
                  ┌─────────────▼──────────────┐
        :3002 ←   │ chiptap-indexer            │  Node 20 + tini, non-root
        :3003 ←   │   REST API + WS broadcast  │
                  └─────────────┬──────────────┘
                  ┌─────────────▼──────────────┐
        :5433 ←   │ chiptap-indexer-db         │  Postgres 16-alpine
                  └────────────────────────────┘
```

Both Dockerfiles are **multi-stage**, run as **non-root**, and ship with
HEALTHCHECKs (`/api/health` and `/healthz`).

```powershell
cd chiptap-indexer

# 1. Provide deployed contract addresses + (optional) RPC overrides.
#    The *_PROD names exist so they don't collide with the dev `.env`
#    (which uses `RPC_WS=ws://127.0.0.1:8545` for host-side `npm run dev`).
$env:CHIP_NFT_ADDRESS = "0x..."
$env:BATTLE_ARENA_ADDRESS = "0x..."

# Default RPC is `ws://host.docker.internal:8545` (works on Mac/Windows).
# Override for testnet/mainnet:
# $env:RPC_WS_PROD   = "wss://polygon-amoy-bor-rpc.publicnode.com"
# $env:RPC_HTTP_PROD = "https://rpc-amoy.polygon.technology"

# 2. Build + start everything (Postgres + migrate + indexer + frontend)
docker compose --profile prod up -d --build

# 3. Verify
curl http://localhost:8080/healthz           # ok
curl http://localhost:8080/api/health        # {"status":"ok",...}  (proxied)
docker compose ps                            # all services healthy
docker compose logs -f frontend indexer
```

Then open **http://localhost:8080** in your browser.

The frontend bundle is built with relative URLs (`VITE_INDEXER_URL=/api`,
`VITE_WS_URL=/ws`), so the same image works behind plain HTTP locally and
behind a TLS terminator in production — `wsClient` resolves `/ws` to
`ws[s]://current-host/ws` at runtime based on `window.location.protocol`.

To override at build time:

```powershell
docker compose --profile prod build --build-arg VITE_INDEXER_URL=https://api.example.com/api frontend
```

The `migrate` step is a one-shot service (`indexer-migrate`) that runs to
completion before the long-running `indexer` boots. Migrations are idempotent.

To stop everything: `docker compose --profile prod down` (add `-v` to wipe the
Postgres volume).

> **Local dev workflow is unchanged**: `docker compose up -d` (no profile) still
> brings up only Postgres on `localhost:5433`, and you run the indexer with
> `npm run dev` against your host-side Hardhat node + `npm run dev` for the
> frontend on `:5173`.

---

## Next: Testnet Deployment (Polygon Amoy)

See `chiptap-contracts/DEPLOY-AMOY-GUIDE.md` for:
- Getting Amoy POL from faucet
- Creating Chainlink VRF subscription + funding with LINK
- Deploying contracts
- Uploading NFT metadata to IPFS via Pinata
- Deploying indexer to VPS + frontend to Vercel

---

## Architecture

```
┌──────────────────────────┐
│  Frontend (React + wagmi) │   :5173
│   • Mint, Inventory       │
│   • Battle Arena (v2 UI)  │
│   • WithdrawBanner        │
└────┬─────────────┬───────┘
     │             │
     │ RPC writes  │ REST/WS reads
     │             │
     ▼             ▼
┌─────────────┐ ┌──────────────────────┐
│ Blockchain  │ │  Indexer              │ :3002 (REST)
│ (Hardhat /  │ │  • Event listener     │ :3003 (WS)
│  Amoy /     │ │  • REST API           │
│  Polygon)   │ │  • WebSocket broadcast│
│             │ └───────┬──────────────┘
│ Contracts:  │         │
│ • ChipNFT   │         ▼
│ • Battle    │ ┌──────────────┐
│   Arena v2  │ │ PostgreSQL   │ :5433
│ • Treasury  │ │  • chips     │
│ • MockVRF   │ │  • battles   │
└─────────────┘ │  • players   │
                │  • events    │
                └──────────────┘
```

---

## Key features v2

- **3 security fixes applied**: VRF timeout + forceResolve, pull-payment pattern (winner withdraws), minimal VRF callback (gas-safe)
- **Indexer with WebSocket**: real-time battle updates pushed to frontend, with REST fallback
- **Retro 90s UI**: Press Start 2P + VT323 fonts, CRT scanlines, Windows 98 chrome
- **Procedural NFT art**: 5 rarity tiers, unique SVG per token
- **Full test coverage**: 28 unit tests + E2E script

---

## Troubleshooting

**"Failed to connect to indexer"** → Check `docker compose ps` for PostgreSQL, `npm run dev` for indexer. Verify `VITE_INDEXER_URL` in frontend `.env`.

**"Transaction reverted"** → Check that contract addresses in `config/index.ts` match the Hardhat deploy output. Local Hardhat nodes generate the same addresses every time if you don't reset state.

**"Chip not showing after mint"** → Hardhat node doesn't emit events properly sometimes. Restart frontend or click REFRESH.

**"VRF not responding"** → In local mode you must manually fulfill via `vrf.fulfillRandomWords(requestId, [seed])`. Even seed = playerA wins, odd = playerB wins.

**WS shows "POLL" instead of "LIVE"** → Indexer WebSocket is not reachable. Check firewall/ports, verify indexer logs.
