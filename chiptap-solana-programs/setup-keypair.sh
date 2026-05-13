#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
mkdir -p "$HOME/.config/solana"
if [ ! -f "$HOME/.config/solana/id.json" ]; then
  solana-keygen new --no-bip39-passphrase --force -o "$HOME/.config/solana/id.json"
fi
solana config set --url localhost
solana address
