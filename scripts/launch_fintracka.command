#!/bin/zsh
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_URL="http://127.0.0.1:8787"

if curl --silent --fail "$APP_URL/api/v1/health" >/dev/null 2>&1; then
  cd "$PROJECT_DIR"
  if [[ -x .venv/bin/python ]]; then
    echo "Syncing FinTracka before opening..."
    .venv/bin/python -m fintracka.cli sync || echo "Sync could not finish; opening FinTracka with the data already stored locally."
  fi
  open -a "Google Chrome" "$APP_URL"
  exit 0
fi

trap 'status=$?; if (( status != 0 )); then echo; echo "FinTracka could not start. Press Return to close."; read; fi' EXIT

cd "$PROJECT_DIR"
if [[ ! -x .venv/bin/python ]]; then
  echo "FinTracka's Python environment is missing: $PROJECT_DIR/.venv"
  exit 1
fi

echo "Preparing the latest FinTracka interface..."
npm --prefix frontend run build
echo "Starting FinTracka. Keep this window open; press Control-C to stop."
exec .venv/bin/python -m fintracka.cli serve --open-chrome
