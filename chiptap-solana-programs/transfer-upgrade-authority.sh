#!/usr/bin/env bash
# Hand over upgrade-authority of all 3 programs to a multisig vault.
#
# Usage:
#   bash transfer-upgrade-authority.sh <SQUADS_VAULT_PUBKEY> [--url devnet|mainnet-beta|<rpc>]
#
# Example:
#   bash transfer-upgrade-authority.sh GhPnTQ9...Bx7 --url devnet
#
# After this runs, the dev (hot) keypair can NO LONGER upgrade programs
# alone — 2 signatures from the Squads members are required.  Verify
# with `solana program show <PROGRAM>` and check `Authority:` matches the
# Squads vault.
set -euo pipefail
. "$(dirname "$0")/wsl-env.sh"

NEW_AUTH="${1:-}"
shift || true
URL_ARG="--url localhost"
if [ "${1:-}" = "--url" ]; then
  URL_ARG="--url $2"
  shift 2
fi

if [ -z "$NEW_AUTH" ]; then
  echo "ERROR: missing new-authority pubkey"
  echo "usage: $0 <NEW_AUTHORITY_PUBKEY> [--url <network>]"
  exit 2
fi

# Sanity-check the new authority is valid base58 32-byte pubkey by
# running a cheap RPC query.
solana account "$NEW_AUTH" $URL_ARG >/dev/null 2>&1 || {
  echo "WARN: $NEW_AUTH not found on $URL_ARG; that's fine if Squads vault hasn't received SOL yet."
}

cd "$(dirname "$0")"
for prog in treasury chip_nft battle_arena; do
  PID=$(solana address -k "target/deploy/${prog}-keypair.json")
  echo "→ ${prog}: ${PID}"
  CURRENT=$(solana program show "$PID" $URL_ARG 2>/dev/null | awk '/^Authority:/ {print $2}')
  echo "  current authority: $CURRENT"
  if [ "$CURRENT" = "$NEW_AUTH" ]; then
    echo "  already transferred — skipping"
    continue
  fi
  solana program set-upgrade-authority \
    "$PID" \
    --new-upgrade-authority "$NEW_AUTH" \
    --skip-new-upgrade-authority-signer-check \
    $URL_ARG
done

echo
echo "[transfer-upgrade-authority] done — verify with: solana program show <PID> $URL_ARG"
