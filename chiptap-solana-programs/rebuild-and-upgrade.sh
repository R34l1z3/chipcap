#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"
solana config set --url localhost --keypair "$HOME/.config/solana/id.json" >/dev/null

echo "[rebuild] anchor build --no-idl"
anchor build --no-idl

echo "[upgrade] in-place upgrade of each program"
for prog in treasury chip_nft battle_arena; do
  pid=$(solana address -k target/deploy/${prog}-keypair.json)
  echo "  $prog → $pid"
  solana program deploy --program-id target/deploy/${prog}-keypair.json target/deploy/${prog}.so
done
