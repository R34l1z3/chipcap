#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"
solana config set --url localhost --keypair "$HOME/.config/solana/id.json" >/dev/null

# anchor deploy reads target/deploy/*.so + matching keypair files we
# generated in step 4.  This deploys all 3 programs.
anchor deploy --provider.cluster localnet
