#!/usr/bin/env bash
# Try multiple devnet RPCs to airdrop SOL.  Public faucets aggressively
# rate-limit; rotating RPC endpoints sometimes gets around it.
set -uo pipefail
. "$(dirname "$0")/wsl-env.sh"

ADDR="${1:-$(solana address)}"
AMOUNT="${2:-2}"

echo "Target: $ADDR  (requesting $AMOUNT SOL each)"
echo

for RPC in \
  https://api.devnet.solana.com \
  https://devnet.helius-rpc.com \
  https://rpc.ankr.com/solana_devnet \
  ; do
  echo "--- $RPC ---"
  solana airdrop "$AMOUNT" "$ADDR" --url "$RPC" 2>&1 | tail -2
  sleep 1
done

echo
echo "=== final balance ==="
solana balance "$ADDR" --url https://api.devnet.solana.com
