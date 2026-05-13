#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"
rustup install nightly >/dev/null 2>&1 || true
echo "[idl] anchor build with RUSTUP_TOOLCHAIN=1.79.0"
rm -rf target/idl
RUSTUP_TOOLCHAIN=1.79.0 anchor build 2>&1 | tail -30
