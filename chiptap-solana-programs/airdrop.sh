#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
solana cluster-version
solana airdrop 100
solana balance
