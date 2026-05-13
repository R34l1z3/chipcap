#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "[init] installing js deps (first run)"
  yarn install --silent --ignore-scripts
fi
node init-programs.js
