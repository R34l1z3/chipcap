# chiptap-solana-relayer

Tiny Node.js service.  One job: when a battle reaches `ROLLING`, call
`fulfill_random_words(seed)` on `battle_arena` so the game doesn't
stall waiting for a human admin.

Replaces the manual `node fulfill-vrf.js <id>` flow in
`chiptap-solana-programs/`.  Needed for any public devnet / mainnet
deployment.

This is **SWITCHBOARD.md Option A** — the relayer holds the registered
`vrf_authority` keypair and can technically pick any seed.  See that
file for the long-term trustless plan (Option B: on-chain Switchboard
proof verification).

## Trust model

| What | Now (Option A) | Later (Option B) |
|---|---|---|
| Where randomness comes from | `slothash + sha256(battle_id)` derived from a finalized blockhash | Switchboard On-Demand VRF proof |
| Can the relayer pick the winner? | **Theoretically yes** — operator runs this bot | No — program verifies Switchboard proof on-chain |
| Can the validator-leader influence | Slightly (controls the slothash they propose); negligible for non-leader-extracted positions | No |
| Operational complexity | Single bot, no oracle deps | Switchboard SDK + per-VRF fee + commit/reveal slot delay |

For local dev / low-stake bets, Option A is fine.  Migrate to Option B
before opening the door to large pools.

## Setup

```bash
cd chiptap-solana-relayer
cp .env.example .env
# edit .env — at minimum:
#   SOLANA_RPC=https://api.devnet.solana.com
#   BATTLE_ARENA_PROGRAM=<your devnet program id>
#   VRF_AUTHORITY_KEYPAIR=/path/to/keypair.json   (must match what
#     `arena.config.vrf_authority` is set to on-chain)
npm install
bash copy-idl.sh        # syncs IDL from chiptap-solana-programs/
```

## Smoke check (no chain writes)

```bash
npm run smoke
# Prints RPC + keypair + program info.  Exits 0 iff the program is
# executable on the configured RPC.
```

## Run

```bash
npm start            # production
npm run dev          # auto-reload on src/ change
```

Output looks like:
```
2026-05-14T19:00:00.123Z [boot] connected to https://api.devnet.solana.com, slot=462...
2026-05-14T19:00:00.124Z [boot] watching program Ae65nkzg…BU8
2026-05-14T19:00:00.124Z [boot] randomness source: slothash
2026-05-14T19:00:00.567Z [live] subscribed (subId=0)
2026-05-14T19:00:00.567Z [boot] relayer running
2026-05-14T19:01:23.456Z [live] BattleJoined #4 in sig=4xJ9k7…
2026-05-14T19:01:26.512Z [fulfill #4] OK  tx=2Pn3K…
```

## Deployment (free tier)

The bot is ~30 MB resident and runs forever on free Oracle Cloud
"Always Free" tier (4 vCPU + 24 GB RAM ARM instance, free for life).
Standard systemd / pm2 / Docker workflows all fit.  See
`Dockerfile.example` (TODO) for the canonical setup.

Operationally: 
- Healthcheck: process is healthy iff it logged `[boot] relayer running`
  within the last 30 s.  Add a simple log-scrape + Telegram alert.
- Restart policy: `restart unless-stopped`.  Process is stateless; on
  restart the polling fallback (every 20 s) catches anything missed.

## Cost

- RPC: free tier of any provider (devnet has unlimited public; mainnet
  Helius free is 100k req/day, plenty for a relayer).
- Per VRF tx: ~5 000 lamports = $0.001 at $200/SOL.  1000 battles =
  $1/day.  Pad the vrf_authority wallet with 1 SOL/year and forget.

## Why not subscribe to the indexer's WS?

Because we deliberately don't want a dependency chain `chain → indexer
→ relayer`.  If the indexer is down, battles still need to resolve.
The relayer talks directly to the validator.

## TODO / migration to Option B

1. Add `@switchboard-xyz/on-demand` dep.
2. Implement `fromSwitchboard()` in `src/randomness.js` (create +
   commit + reveal sequence).
3. Land program-side ix `fulfill_random_words_switchboard(randomness_account)`
   that verifies the proof on-chain.
4. Set `RANDOMNESS_SOURCE=switchboard` and update relayer to call the
   new ix.  The owner can rotate `vrf_authority` to the Switchboard
   queue address at that point.
