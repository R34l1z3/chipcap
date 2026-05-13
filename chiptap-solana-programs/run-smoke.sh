#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
cd "$(dirname "$0")"
node smoke.js
