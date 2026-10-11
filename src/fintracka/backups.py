from __future__ import annotations

import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def backup_database(source_path: str | Path, backup_directory: str | Path, *, keep: int = 30) -> Path:
    source_path = Path(source_path)
    backup_directory = Path(backup_directory)
    backup_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    destination = backup_directory / f"fintracka-{timestamp}.sqlite3"
    descriptor, temporary_name = tempfile.mkstemp(prefix=".fintracka-backup-", dir=backup_directory)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        source = sqlite3.connect(source_path)
        target = sqlite3.connect(temporary)
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
        _verify(temporary)
        temporary.chmod(0o600)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    backups = sorted(backup_directory.glob("fintracka-*.sqlite3"), reverse=True)
    for expired in backups[max(keep, 1) :]:
        expired.unlink()
    return destination


def restore_database(source_backup: str | Path, target_path: str | Path, *, verify: bool = True) -> Path:
    source_backup = Path(source_backup)
    target_path = Path(target_path)
    if target_path.exists():
        raise FileExistsError("restore target already exists")
    if verify:
        _verify(source_backup)
    target_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".fintracka-restore-", dir=target_path.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        source = sqlite3.connect(source_backup)
        target = sqlite3.connect(temporary)
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
        if verify:
            _verify(temporary)
        temporary.chmod(0o600)
        os.replace(temporary, target_path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return target_path


def _verify(path: Path) -> None:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        result = connection.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        connection.close()
    if result != "ok":
        raise sqlite3.DatabaseError(f"backup integrity check failed: {result}")

