#!/usr/bin/env bash
# Sync target/idl/*.json into the indexer and frontend trees.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
for f in treasury chip_nft battle_arena; do
  cp -v "$HERE/target/idl/$f.json" "$ROOT/chiptap-solana-indexer/idl/$f.json"
  cp -v "$HERE/target/idl/$f.json" "$ROOT/chiptap-solana-frontend/src/idl/$f.json"
done
echo "OK"
