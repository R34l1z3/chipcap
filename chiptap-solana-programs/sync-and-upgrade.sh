#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/wsl-env.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

echo "=== regenerate IDL JSONs ==="
node "$HERE/gen-idls.js" | tail -3

echo
echo "=== sync IDLs to indexer + frontend + relayer ==="
for f in treasury chip_nft battle_arena; do
  cp "$HERE/target/idl/$f.json" "$ROOT/chiptap-solana-indexer/idl/$f.json"
  cp "$HERE/target/idl/$f.json" "$ROOT/chiptap-solana-frontend/src/idl/$f.json"
  cp "$HERE/target/idl/$f.json" "$ROOT/chiptap-solana-relayer/idl/$f.json" 2>/dev/null || true
  echo "  $f.json → 3 trees"
done

echo
echo "=== upgrade battle_arena on devnet ==="
solana config set --url https://api.devnet.solana.com >/dev/null
solana program deploy \
  --program-id "$HERE/target/deploy/battle_arena-keypair.json" \
  "$HERE/target/deploy/battle_arena.so" 2>&1 | tail -3
