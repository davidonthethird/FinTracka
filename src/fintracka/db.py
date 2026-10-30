from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from importlib.resources import files
from pathlib import Path

from fintracka.backups import backup_connection


def connect(path: str | Path) -> sqlite3.Connection:
    # FastAPI may create a sync dependency and run its endpoint in different
    # worker threads. Each request still owns its connection; this only permits
    # that request-scoped handoff.
    connection = sqlite3.connect(path, timeout=5, isolation_level=None, check_same_thread=False)
    if str(path) != ":memory:" and not str(path).startswith("file:"):
        Path(path).chmod(0o600)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def migrate(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
        """
    )
    migration_root = files("fintracka").joinpath("migrations")
    applied = {
        row[0] for row in connection.execute("SELECT version FROM schema_migrations")
    }
    for resource in sorted(migration_root.iterdir(), key=lambda item: item.name):
        if resource.suffix != ".sql":
            continue
        version = int(resource.name.split("_", 1)[0])
        if version in applied:
            continue
        if version in {13, 14, 15, 16, 17, 18, 19, 20}:
            database_file = connection.execute("PRAGMA database_list").fetchone()[2]
            if database_file:
                database_path = Path(database_file)
                timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
                backup_connection(
                    connection,
                    database_path.parent / "backups",
                    filename=f"fintracka-pre-migration-{version:03d}-{timestamp}.sqlite3",
                )
        name = resource.name.replace("'", "''")
        script = resource.read_text(encoding="utf-8")
        connection.executescript(
            "BEGIN IMMEDIATE;\n"
            + script
            + f"\nINSERT INTO schema_migrations VALUES ({version}, '{name}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));\n"
            + "COMMIT;"
        )
