#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"
echo "--- solana cmds ---"
ls "$HOME/.local/share/solana/install/active_release/bin/" | head -30
echo "--- cargo-build-sbf ---"
which cargo-build-sbf || true
cargo-build-sbf --version 2>&1 || true
echo "--- cargo-build-bpf ---"
which cargo-build-bpf || true
echo "--- anchor strace (10 lines) ---"
cd "$(dirname "$0")"
strace -f -e trace=openat -o /tmp/anchor.strace anchor build 2>&1 | head -5 || true
echo "--- strace tail (look for ENOENT) ---"
grep -E "ENOENT" /tmp/anchor.strace | tail -10
