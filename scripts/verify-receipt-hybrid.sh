#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
python="$repo_dir/../../.venv/bin/python"
if [ ! -x "$python" ]; then
  python="$repo_dir/.venv/bin/python"
fi

(cd "$repo_dir/remote" && npm test -- --run && npm run typecheck && npm run check:deployment)

(cd "$repo_dir/frontend" && npm test -- --run && npm run typecheck && npm run build && \
  PATH="$(dirname "$python"):$PATH" npm run test:e2e)

PYTHONPATH="$repo_dir" "$python" -m pytest "$repo_dir/tests" -q

(cd "$repo_dir/native/receipt-refiner" && swift build -c release && \
  .build/release/fintracka-receipt-refiner --self-test)

scratch=$(mktemp -d)
trap 'find "$scratch" -depth -delete' EXIT HUP INT TERM
package="$scratch/00000000-0000-4000-8000-000000000001"
mkdir -p "$package"
echo '{"contract":"receipt_refinement_package/v1","refinement_id":"wrong-job","page_count":1,"created_at":"2026-11-04T12:00:00Z"}' > "$package/manifest.json"
: > "$package/page-001.heic"
if "$repo_dir/native/receipt-refiner/.build/release/fintracka-receipt-refiner" "$package" \
  >"$scratch/stdout" 2>"$scratch/stderr"; then
  echo "native refiner accepted an invalid package" >&2
  exit 1
fi
grep -qx 'INVALID_PACKAGE' "$scratch/stderr"

(cd "$repo_dir" && git diff --check)
