#!/usr/bin/env bash
# Start validator in detached background (survives parent shell exit).
. "$(dirname "$0")/wsl-env.sh"
pkill -9 -f solana-test-validator 2>/dev/null || true
sleep 1
nohup solana-test-validator --reset \
  --ledger /tmp/test-ledger \
  --rpc-port 8899 \
  --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
  --url https://api.devnet.solana.com \
  > /tmp/validator.log 2>&1 < /dev/null &
disown
echo "spawned"
