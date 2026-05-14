# Public-devnet deployment — $0 / solo path

End-to-end recipe to put ChipTap on a public URL without paying anything.

| Component | Where | Free tier | Why |
|---|---|---|---|
| Frontend (Vite SPA) | **Vercel** | Unlimited bandwidth on Hobby plan, GitHub auto-deploy | Best DX for Vite, no card needed |
| Indexer (Node + REST + WS) | **Fly.io** | 3 shared-cpu VMs × 256 MB free, GitHub OAuth signup | Persistent process; no auto-sleep |
| Postgres | **Neon** | 0.5 GB free DB, GitHub OAuth | Serverless; sleeps after 5 min idle (cold-start ~1 s — fine) |
| Relayer (auto VRF) | **Fly.io** (same account) | Second shared-cpu VM, free | Always-on, restart-on-crash |

Total monthly cost: **$0**.  None of the providers above ask for a card on signup (verify on their site at sign-up time — policies change).

## Order of operations

1. **Postgres on Neon** — get a connection URL first; indexer needs it.
2. **Indexer on Fly.io** — needs `DATABASE_URL` from step 1, exposes the
   public URL the frontend will point at.
3. **Frontend on Vercel** — needs the indexer URL from step 2.
4. **Relayer on Fly.io** — needs the vrf_authority keypair; runs forever.
5. **Announce** — Twitter / Solana Discord / /r/solana with the Vercel URL.

You can skip steps 1+2+4 initially: a "frontend-only" Vercel deploy is
fine for showing off Connect Wallet + Mint + Create Battle (those talk
to chain directly, not the indexer).  The indexer powers the LIST views
(open battles, leaderboard, profile history) which gracefully degrade
to "no data" without it.

---

## 1. Neon Postgres (~3 min)

1. https://neon.tech → **Sign in with GitHub**
2. Create project → name `chiptap-db`, region near Fly's `fra`
3. Database: `chiptap_pvp_db`, role: `chiptap`
4. **Copy the connection string** — looks like:
   ```
   postgres://chiptap:HEX_SECRET@ep-...neon.tech/chiptap_pvp_db?sslmode=require
   ```
5. (Save it — needed in step 2 + by any future SQL client.)

## 2. Indexer on Fly.io (~5 min)

```bash
# One-time:
brew install flyctl              # macOS, or `iwr https://fly.io/install.ps1 -useb | iex` on Windows
fly auth signup                  # opens browser; GitHub OAuth, no card
                                  # if it asks for card later, switch to free Hobby plan
                                  # — your account stays cardless until you scale up

cd chiptap-solana-indexer
fly launch --no-deploy           # detects fly.toml, prompts for app name
                                 # accept defaults; we already have fly.toml

# Migrate DB schema against the Neon URL we just got:
DATABASE_URL='postgres://...neon.tech/chiptap_pvp_db?sslmode=require' \
  npm run db:migrate

# Pass the same URL as a Fly secret:
fly secrets set DATABASE_URL='postgres://...neon.tech/chiptap_pvp_db?sslmode=require'
fly secrets set WS_TOKEN=$(openssl rand -hex 16)     # optional — protects WS broadcast (SEC-13)

# Deploy:
fly deploy

# After ~2 min:
fly status                       # should show 1 running machine
curl https://chiptap-indexer.fly.dev/api/health
# → {"status":"ok","db":{"ok":true,...}}
```

Public URLs you now have:
- REST:     `https://chiptap-indexer.fly.dev/api`
- WS:       `wss://chiptap-indexer.fly.dev:3003` (Fly routes via dual-stack)

## 3. Frontend on Vercel (~5 min)

1. https://vercel.com → **Sign in with GitHub** (no card needed for Hobby)
2. **Add New → Project** → import `R34l1z3/chipcap`
3. **Root Directory**: `chiptap-solana-frontend`
4. Framework: Vite (auto-detected from `vercel.json`)
5. **Environment Variables** — paste these:

   | Key | Value |
   |---|---|
   | `VITE_SOLANA_CLUSTER` | `devnet` |
   | `VITE_SOLANA_RPC`     | `https://api.devnet.solana.com` |
   | `VITE_CHIP_NFT_PROGRAM`     | `A8fqFHnTHAAq3B5t22S8RAix4neNTXTp7RaZ6aQbk5qQ` |
   | `VITE_BATTLE_ARENA_PROGRAM` | `Ae65nkzg2DD4dFUttxUXPpVfZT7kMPX1L9Uk9GDxkBU8` |
   | `VITE_TREASURY_PROGRAM`     | `wGAqdvJJV2DTHUgkDxdMkWotTvg8Q7r5kz5NntWESPp` |
   | `VITE_INDEXER_URL`  | `https://chiptap-indexer.fly.dev/api` |
   | `VITE_WS_URL`       | `wss://chiptap-indexer.fly.dev:3003` |
   | `VITE_WS_TOKEN`     | (same as the indexer's `WS_TOKEN`, leave blank if no auth) |

6. **Deploy** — ~90 s build, then live at `chipcap.vercel.app` (or whatever name auto-assigned).
7. **Custom domain** (optional): Settings → Domains → Add → `chiptap.fun` etc.

## 4. Relayer on Fly.io (~3 min)

```bash
cd chiptap-solana-relayer
fly launch --no-deploy           # accept defaults; uses fly.toml

# Export the vrf_authority keypair as raw JSON:
fly secrets set VRF_AUTHORITY_KEYPAIR_JSON="$(cat ~/.config/solana/id.json)"
#   ^ this is the same keypair that signed `set_vrf_authority` on chain.
#     For mainnet later: generate a SEPARATE dedicated keypair for the
#     relayer (so a compromise of the owner key isn't a compromise of
#     the relayer).

fly deploy

fly logs                         # tail the boot — should see
                                 # "[boot] relayer running"
```

## 5. Verify the full loop

Open the Vercel URL in a browser with Backpack:

1. Connect Backpack (set network → Devnet first)
2. Mint a Common chip on each of two wallets
3. Create + join a battle from the two wallets
4. **Don't touch anything** — the relayer should auto-fulfill within ~5 s
5. The losing wallet → BATTLE → Deposit 0.06 SOL → Pay Ransom
6. The winning wallet → ME → Withdraw
7. Check `https://solscan.io/...?cluster=devnet` for all the txs

## 6. Public announce (optional)

- **Twitter / X**: thread the architecture diagram + URL + open-source link
- **Solana Discord** (#dapps-showcase / #builders-help)
- **Reddit** (/r/solana)
- **Solana grants** programs — link to the deployed devnet build as proof of execution

Open-source URL: https://github.com/R34l1z3/chipcap

## Troubleshooting

| Symptom | Fix |
|---|---|
| Vercel build fails on `npx tsc --noEmit` | Run locally first; commit fixes, push.  CI on GitHub Actions matches Vercel's build env. |
| Indexer healthcheck red | `fly logs` — usually wrong `DATABASE_URL` or migration not run.  `npm run db:migrate` against the real Neon URL. |
| Frontend shows red banner "Program X not deployed" | `VITE_*_PROGRAM` env vars don't match what's on devnet.  Sanity: `solana program show <ID> --url devnet` |
| Relayer doesn't fulfill | `fly logs` from the relayer.  Usually: vrf_authority on chain ≠ relayer wallet, or out of SOL.  `solana balance <RELAYER_WALLET> --url devnet`. |
| "Wallet not detected" on Vercel deploy | Vite env vars not loaded.  Each Vercel project has Environment Variables tab — they must be set for the matching Environment (Production / Preview / Development). |
