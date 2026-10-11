from __future__ import annotations

import sqlite3
from importlib.resources import files
from pathlib import Path


def connect(path: str | Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, timeout=5, isolation_level=None)
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
        name = resource.name.replace("'", "''")
        script = resource.read_text(encoding="utf-8")
        connection.executescript(
            "BEGIN IMMEDIATE;\n"
            + script
            + f"\nINSERT INTO schema_migrations VALUES ({version}, '{name}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));\n"
            + "COMMIT;"
        )

