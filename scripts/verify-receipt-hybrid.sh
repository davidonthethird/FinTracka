#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
python="$repo_dir/../../.venv/bin/python"
if [ ! -x "$python" ]; then
  python="$repo_dir/.venv/bin/python"
fi

(cd "$repo_dir/remote" && npx vitest run \
  tests/receipt-interpretation.test.ts \
  tests/receipt-refinement-store.test.ts \
  tests/receipt-refinement-gateway.test.ts \
  tests/receipt-shortcut-store.test.ts \
  tests/receipt-shortcut-gateway.test.ts && npx tsc --noEmit)

(cd "$repo_dir/frontend" && npx vitest run tests/receipt-shortcut-pages.test.tsx && npx tsc --noEmit)

"$python" -m pytest \
  "$repo_dir/tests/test_receipt_refinement_service.py" \
  "$repo_dir/tests/test_mobile_command_client.py" -q

(cd "$repo_dir/native/receipt-refiner" && swift build -c release)

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
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
