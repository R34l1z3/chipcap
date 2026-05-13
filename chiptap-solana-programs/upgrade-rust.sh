#!/usr/bin/env bash
. "$(dirname "$0")/wsl-env.sh"
rustup install stable
rustup default stable
rustup show active-toolchain
rustc --version
cargo --version
