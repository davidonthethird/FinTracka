#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
shortcut_skill="$HOME/.codex/plugins/cache/shortcuts-playground/shortcuts-playground/1.2.1/skills/shortcuts-playground"

(cd "$repo_dir/remote" && npm run test:ci && npm run typecheck && npm run check:deployment)
(cd "$repo_dir/frontend" && npm test -- --run && npm run typecheck:viewer && npm run build:viewer)
common_git_dir=$(git -C "$repo_dir" rev-parse --path-format=absolute --git-common-dir)
main_repo=$(CDPATH= cd -- "$(dirname -- "$common_git_dir")" && pwd)
if [ -x "$main_repo/.venv/bin/python" ]; then
  PATH="$main_repo/.venv/bin:$PATH"
  export PATH
elif ! python -c 'import uvicorn' >/dev/null 2>&1; then
  echo "python with the FinTracka E2E dependencies is required" >&2
  exit 1
fi
(cd "$repo_dir/frontend" && npm run test:e2e -- --grep "receipt model comparison waits")
python -m pytest "$repo_dir/tests/test_receipt_shortcut_privacy.py" -q
python3 "$shortcut_skill/scripts/validate_shortcut.py" \
  "$repo_dir/shortcuts/FinTracka Receipt Model Comparison.xml" \
  --target-platform all --target-macos 27
test -s "$repo_dir/shortcuts/FinTracka Receipt Scanner.shortcut"
node "$repo_dir/scripts/summarize-receipt-benchmark.mjs" \
  "$repo_dir/scripts/receipt-benchmark-truth.template.json" \
  "$repo_dir/scripts/receipt-benchmark-reviewed-results.example.json" >/dev/null
git -C "$repo_dir" check-ignore -q .private/receipt-benchmark/truth.json
! git -C "$repo_dir" ls-files | grep -q '^\.private/receipt-benchmark/'
git -C "$repo_dir" diff --check
