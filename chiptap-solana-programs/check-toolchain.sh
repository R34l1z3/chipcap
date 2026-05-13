#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
echo "rustc:  $(rustc --version)"
echo "cargo:  $(cargo --version)"
echo "solana: $(solana --version)"
echo "anchor: $(anchor --version)"
echo "node:   $(node -v)"
echo "yarn:   $(yarn -v)"
