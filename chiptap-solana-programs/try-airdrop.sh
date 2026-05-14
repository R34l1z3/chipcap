#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
ADDR="Dkq4VizFkoouuxfo83ZyvUUwCwMdArbABtfNb48DCJ5s"

echo "=== api.devnet.solana.com ==="
solana airdrop 2 "$ADDR" --url https://api.devnet.solana.com 2>&1 | tail -2 || true
sleep 2
echo "=== helius devnet ==="
solana airdrop 2 "$ADDR" --url https://devnet.helius-rpc.com 2>&1 | tail -2 || true
sleep 2
echo "=== ankr devnet ==="
solana airdrop 2 "$ADDR" --url https://rpc.ankr.com/solana_devnet 2>&1 | tail -2 || true
echo
echo "=== balance ==="
solana balance "$ADDR" --url https://api.devnet.solana.com
