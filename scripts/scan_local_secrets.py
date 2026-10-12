#!/usr/bin/env python3
"""Fail without echoing values if configured secrets appear outside Keychain."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = Path.home() / "Library" / "Application Support" / "FinTracka"
SERVICE = "com.fintracka.provider"
KNOWN_REFS = {
    "plaid:production:client_id",
    "plaid:production:secret",
    "plaid:sandbox:client_id",
    "plaid:sandbox:secret",
    "google:oauth:client_config",
    "google:oauth:credentials",
}
GENERIC_PATTERNS = (
    re.compile(rb"access-(?:sandbox|development|production)-[A-Za-z0-9_-]{8,}"),
    re.compile(rb"GOCSPX-[A-Za-z0-9_-]{8,}"),
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
)
SKIP_PARTS = {".git", ".venv", "node_modules", ".pytest_cache", "__pycache__"}


def _keychain_value(reference: str) -> str | None:
    result = subprocess.run(
        ["security", "find-generic-password", "-s", SERVICE, "-a", reference, "-w"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.rstrip("\n") if result.returncode == 0 else None


def _references() -> set[str]:
    references = set(KNOWN_REFS)
    database = DATA / "fintracka.sqlite3"
    if not database.is_file():
        return references
    try:
        connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
        references.update(
            row[0]
            for row in connection.execute(
                "SELECT value FROM app_metadata WHERE key LIKE '%_ref' UNION SELECT keychain_account FROM connection_secret_refs"
            )
            if row[0]
        )
        connection.close()
    except sqlite3.Error:
        pass
    return references


def _secret_fragments() -> set[bytes]:
    fragments: set[bytes] = set()
    for reference in _references():
        value = _keychain_value(reference)
        if not value:
            continue
        candidates = [value]
        try:
            parsed = json.loads(value)
            config = parsed.get("installed", parsed) if isinstance(parsed, dict) else {}
            if isinstance(config, dict):
                candidates.extend(str(config[key]) for key in ("client_id", "client_secret") if config.get(key))
        except (json.JSONDecodeError, AttributeError):
            pass
        fragments.update(candidate.encode() for candidate in candidates if len(candidate) >= 8)
    return fragments


def _files() -> list[Path]:
    roots = [ROOT, DATA]
    files: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for directory, names, filenames in os.walk(root):
            names[:] = [name for name in names if name not in SKIP_PARTS]
            files.extend(Path(directory) / name for name in filenames)
    return files


def main() -> int:
    secrets = _secret_fragments()
    findings: list[str] = []
    for path in _files():
        try:
            content = path.read_bytes()
        except (OSError, MemoryError):
            continue
        if any(secret in content for secret in secrets) or any(pattern.search(content) for pattern in GENERIC_PATTERNS):
            findings.append(str(path))

    history = subprocess.run(
        ["git", "log", "-p", "--all", "--no-ext-diff", "--"],
        cwd=ROOT,
        capture_output=True,
        check=False,
    ).stdout
    if any(secret in history for secret in secrets) or any(pattern.search(history) for pattern in GENERIC_PATTERNS):
        findings.append("git history")

    if findings:
        print("Sensitive value or credential pattern found in:", file=sys.stderr)
        for finding in sorted(set(findings)):
            print(f"- {finding}", file=sys.stderr)
        return 1
    print("Secret scan passed; no configured secret values or known credential patterns found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
