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
        _sync_file(destination)
        _sync_directory(backup_directory)
    finally:
        if temporary.exists():
            temporary.unlink()
    backups = sorted(backup_directory.glob("fintracka-*.sqlite3"), reverse=True)
    retained_days: set[str] = set()
    expired: list[Path] = []
    for backup in backups:
        day = backup.name.removeprefix("fintracka-")[:8]
        if day in retained_days or len(retained_days) >= max(keep, 1):
            expired.append(backup)
        else:
            retained_days.add(day)
    for expired_backup in expired:
        expired_backup.unlink()
    if expired:
        _sync_directory(backup_directory)
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
        _sync_file(target_path)
        _sync_directory(target_path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()
    return target_path


def _verify(path: Path) -> None:
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
    try:
        result = connection.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        connection.close()
    if result != "ok":
        raise sqlite3.DatabaseError(f"backup integrity check failed: {result}")


def _sync_file(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
