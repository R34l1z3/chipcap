#!/usr/bin/env bash
# Generate a cold backup keypair for the Squads multisig (member #2).
# Save the output file somewhere safe (USB drive, password manager) and
# delete it from disk once you've extracted it.  This keypair never
# touches a webapp / browser.
set -euo pipefail
. "$(dirname "$0")/wsl-env.sh"

DIR=/root/.config/solana/multisig
mkdir -p "$DIR"
COLD="$DIR/cold-backup.json"

if [ -f "$COLD" ]; then
  echo "[gen-cold-keypair] cold-backup.json already exists at $COLD — refusing to overwrite"
else
  solana-keygen new --no-bip39-passphrase --silent -o "$COLD"
  chmod 600 "$COLD"
  echo "[gen-cold-keypair] generated $COLD"
fi

echo
echo "=== addresses ==="
HOT=$(solana address -k /root/.config/solana/id.json)
CLD=$(solana address -k "$COLD")
echo "HOT  (current dev):  $HOT"
echo "COLD (backup):       $CLD"
echo
echo "Squads multisig will have 2-of-2 with both addresses as members."
echo "Cold keypair file (WSL): $COLD"
