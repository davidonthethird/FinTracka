#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target="$repo_dir/.private/receipt-benchmark"

if git -C "$repo_dir" ls-files --error-unmatch .private/receipt-benchmark >/dev/null 2>&1; then
  echo "refusing: private receipt benchmark data is tracked by git" >&2
  exit 1
fi
if ! git -C "$repo_dir" check-ignore -q .private/receipt-benchmark/truth.json; then
  echo "refusing: .private/receipt-benchmark is not ignored" >&2
  exit 1
fi

mkdir -p "$target/photos"
if [ ! -e "$target/truth.json" ]; then
  cp "$repo_dir/scripts/receipt-benchmark-truth.template.json" "$target/truth.json"
  chmod 600 "$target/truth.json"
fi

echo "Private benchmark ready at $target"
echo "Copy receipt photos into photos/ and manually complete truth.json from the images."
