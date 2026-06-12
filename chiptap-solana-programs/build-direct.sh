#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"
echo "--- which anchor ---"
which anchor
anchor --version
echo "--- which solana ---"
which solana
solana --version
# IDL stage is broken on Rust >= 1.95 (proc_macro::SourceFile removed —
# see CLAUDE.md "anchor build is broken").  IDLs come from gen-idls.js.
echo "--- anchor build --no-idl ---"
anchor build --no-idl 2>&1
