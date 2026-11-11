#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir=${1:-"$repo_dir/shortcuts"}
source="$repo_dir/shortcuts/FinTracka Receipt Scanner.plist"
skill="$HOME/.codex/plugins/cache/shortcuts-playground/shortcuts-playground/1.2.1/skills/shortcuts-playground"

python3 "$repo_dir/scripts/verify-receipt-shortcut-v4.py" "$source"
python3 "$skill/scripts/validate_shortcut.py" "$source" --target-platform all
mkdir -p "$output_dir"
SHORTCUTS_PLAYGROUND_OUTPUT_DIR="$output_dir" \
  "$skill/scripts/sign_shortcut.sh" "$source" --name "FinTracka Receipt Scanner"
python3 - "$output_dir/FinTracka Receipt Scanner.shortcut" <<'PY'
from pathlib import Path
import sys

artifact = Path(sys.argv[1]).read_bytes()
if not artifact.startswith(b"AEA1") or len(artifact) < 10_000:
    raise SystemExit("trusted receipt Shortcut signing did not produce an Apple artifact")
PY
