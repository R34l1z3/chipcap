#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"

# Reset ledger every run.  Clone Metaplex Core program from devnet so
# our chip_nft mint CPI lands on a real Asset implementation.
mkdir -p /tmp/test-ledger

solana-test-validator --reset \
  --ledger /tmp/test-ledger \
  --rpc-port 8899 \
  --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
  --url https://api.devnet.solana.com "$@"
