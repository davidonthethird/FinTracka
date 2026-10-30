#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "src"))

from fintracka.remote_models import RemoteSnapshotV1
from fintracka.remote_snapshot import serialize_remote_snapshot, snapshot_digest

fixture = root / "tests" / "fixtures" / "remote_snapshot_v1.json"
raw = fixture.read_bytes().strip()
document = json.loads(raw)
canonical = serialize_remote_snapshot(RemoteSnapshotV1.model_validate(document))
if raw != canonical:
    raise SystemExit("remote snapshot fixture is not canonical")
for forbidden in (
    "access_token", "external_connection_id", "keychain_account", "notes",
    "raw_payload", "sanitized_json",
):
    if f'"{forbidden}"'.encode() in canonical:
        raise SystemExit(f"remote snapshot fixture contains forbidden field: {forbidden}")
print(f"remote snapshot contract verified: {snapshot_digest(canonical)}")
