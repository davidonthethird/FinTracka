#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
data_dir=${1:-"$HOME/Library/Application Support/FinTracka"}
cd "$repo_dir/native/receipt-refiner"
swift build -c release
install -d -m 700 "$data_dir/tools"
install -m 700 ".build/release/fintracka-receipt-refiner" "$data_dir/tools/fintracka-receipt-refiner"
