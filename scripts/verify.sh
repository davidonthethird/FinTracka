#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -n "${FINTRACKA_PYTHON:-}" ]; then
    PYTHON_BIN=$FINTRACKA_PYTHON
elif [ -x "$PROJECT_ROOT/.venv/bin/python" ]; then
    PYTHON_BIN="$PROJECT_ROOT/.venv/bin/python"
elif [ -x "$PROJECT_ROOT/../../.venv/bin/python" ]; then
    PYTHON_BIN="$PROJECT_ROOT/../../.venv/bin/python"
else
    PYTHON_BIN=python3
fi

cd "$PROJECT_ROOT"
"$PYTHON_BIN" -m pytest -q
"$PYTHON_BIN" -m pip check
"$PYTHON_BIN" -m pip_audit
"$PYTHON_BIN" scripts/verify_remote_snapshot.py

cd "$PROJECT_ROOT/remote"
npm run test:ci
npm run typecheck
npm audit --audit-level=high

cd "$PROJECT_ROOT/frontend"
npm test -- --run
npm run typecheck
npm run build
npm run build:viewer
PATH="$(dirname -- "$PYTHON_BIN"):$PATH" npm run test:e2e
npm audit --audit-level=high
