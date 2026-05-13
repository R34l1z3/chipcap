#!/usr/bin/env bash
set -euo pipefail

. "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

echo "[anchor] installing anchor-cli 0.30.1 using Rust 1.79 (its locked toolchain)"
rustup install 1.79.0 >/dev/null 2>&1 || true
RUSTUP_TOOLCHAIN=1.79.0 cargo install anchor-cli --version 0.30.1 --locked --force

anchor --version
