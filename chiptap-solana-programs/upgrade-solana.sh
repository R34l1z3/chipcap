#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
# Latest stable Agave — newer bundled cargo-build-sbf with edition2024.
curl -sSfL https://release.anza.xyz/stable/install -o /tmp/anza-stable.sh
bash /tmp/anza-stable.sh
solana --version
echo "--- platform-tools ---"
ls "$HOME/.cache/solana/" 2>/dev/null || true
