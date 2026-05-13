#!/usr/bin/env bash
# Sourced by every WSL helper script — sets up Solana / Rust / Anchor PATH
# without depending on /root/.profile (which sometimes isn't read in
# non-interactive `wsl -- bash <script>` invocations).
set -euo pipefail
. "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
