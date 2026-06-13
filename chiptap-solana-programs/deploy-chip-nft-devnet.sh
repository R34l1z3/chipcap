#!/usr/bin/env bash
# SEC-26 — deploy ONLY the new chip_nft program to devnet (minimal wipe).
# Uses solana program deploy (exact max-len) to minimise rent.
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"
URL=https://api.devnet.solana.com
KP="$HOME/.config/solana/id.json"
echo "payer: $(solana address)"
echo "balance: $(solana balance --url $URL)"
echo "program id: $(solana-keygen pubkey target/deploy/chip_nft-keypair.json)"
solana program deploy target/deploy/chip_nft.so \
  --program-id target/deploy/chip_nft-keypair.json \
  --url "$URL" --keypair "$KP" --commitment confirmed
echo "balance after: $(solana balance --url $URL)"
