#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
shortcut_skill="$HOME/.codex/plugins/cache/shortcuts-playground/shortcuts-playground/1.2.1/skills/shortcuts-playground"
common_git_dir=$(git -C "$repo_dir" rev-parse --path-format=absolute --git-common-dir)
main_repo=$(CDPATH= cd -- "$(dirname -- "$common_git_dir")" && pwd)
python="$main_repo/.venv/bin/python"
if [ ! -x "$python" ]; then
  python="$repo_dir/.venv/bin/python"
fi
if [ ! -x "$python" ]; then
  echo "FinTracka virtualenv is required" >&2
  exit 1
fi

(cd "$repo_dir/remote" && NO_COLOR=1 CI=1 npm test -- --run && npm run typecheck && npm run check:deployment)

(cd "$repo_dir/frontend" && npm test -- --run && npm run typecheck && npm run build:viewer)
if [ "${FINTRACKA_SKIP_EXTERNAL_BROWSER:-0}" = 1 ]; then
  (cd "$repo_dir/frontend" && npx playwright test e2e/remote-viewer.spec.ts --list >/dev/null)
else
  (cd "$repo_dir/frontend" && PATH="$(dirname "$python"):$PATH" npm run test:e2e)
fi

PYTHONPATH="$repo_dir" "$python" -m pytest "$repo_dir/tests" -q

scratch=$(mktemp -d)
trap 'find "$scratch" -depth -delete' EXIT HUP INT TERM
"$repo_dir/scripts/build-receipt-refiner.sh" "$scratch/install"

plutil -lint "$repo_dir/shortcuts/FinTracka Receipt Scanner.plist"
python3 "$repo_dir/scripts/verify-receipt-shortcut-v4.py" \
  "$repo_dir/shortcuts/FinTracka Receipt Scanner.plist"
python3 "$shortcut_skill/scripts/validate_shortcut.py" \
  "$repo_dir/shortcuts/FinTracka Receipt Scanner.plist" --target-platform all
test -s "$repo_dir/shortcuts/FinTracka Receipt Scanner.shortcut"
find "$repo_dir/shortcuts" -mindepth 2 -maxdepth 2 -type f \
  -name 'FinTracka Receipt Scanner-*.xml' | grep -q .
mkdir -p "$scratch/signed"
printf 'AEA1unrelated' > "$scratch/signed/FinTracka Receipt Scanner.shortcut"
"$repo_dir/scripts/sign-receipt-shortcut-v4.sh" "$scratch/signed" >/dev/null
test "$(wc -c < "$scratch/signed/FinTracka Receipt Scanner.shortcut")" -gt 10000

python3 "$repo_dir/scripts/scan_local_secrets.py"
if git -C "$repo_dir" ls-files | grep -Eiq '(^|/)(IMG_|Screenshot)[^/]*\.(heic|heif|jpe?g|png)$'; then
  echo "tracked private-looking image artifact found" >&2
  exit 1
fi
if git -C "$repo_dir" ls-files 'shortcuts/*' | grep -Eiq '\.(heic|heif|jpe?g|png)$'; then
  echo "receipt image found in Shortcut artifacts" >&2
  exit 1
fi

(cd "$repo_dir" && git diff --check)
