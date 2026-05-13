#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"
mkdir -p target/deploy
for name in treasury chip_nft battle_arena; do
  if [ ! -f "target/deploy/${name}-keypair.json" ]; then
    solana-keygen new --no-bip39-passphrase --silent --force \
      -o "target/deploy/${name}-keypair.json"
  fi
  pk=$(solana-keygen pubkey "target/deploy/${name}-keypair.json")
  echo "${name} ${pk}"
done
