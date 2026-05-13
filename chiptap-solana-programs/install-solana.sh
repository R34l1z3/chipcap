#!/usr/bin/env bash
set -euo pipefail
curl -sSfL https://release.anza.xyz/v1.18.22/install -o /tmp/solana-install.sh
bash /tmp/solana-install.sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version
