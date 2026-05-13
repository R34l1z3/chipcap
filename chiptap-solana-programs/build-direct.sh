#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"
echo "--- which anchor ---"
which anchor
anchor --version
echo "--- which solana ---"
which solana
solana --version
echo "--- anchor build (with IDL) ---"
anchor build 2>&1
