#!/usr/bin/env bash
# Upgrade chip_nft + battle_arena in place, regen + sync IDLs.
set -euo pipefail
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"

for prog in chip_nft battle_arena treasury; do
  echo "[upgrade] $prog"
  solana program deploy \
    --program-id "target/deploy/${prog}-keypair.json" \
    "target/deploy/${prog}.so" 2>&1 | tail -2
done

node gen-idls.js | tail -3
bash "$(dirname "$0")/copy-idls.sh" | tail -2
echo "OK"
