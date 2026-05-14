#!/usr/bin/env bash
# Run after every `node gen-idls.js` in the programs dir.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROGS="$HERE/../chiptap-solana-programs"
cp -v "$PROGS/target/idl/battle_arena.json" "$HERE/idl/battle_arena.json"
echo "OK"
