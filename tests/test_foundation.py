from __future__ import annotations

import sqlite3
import uuid
from datetime import date
from pathlib import Path

import pytest

from fintracka.dates import local_date
from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.money import MoneyError, minor_units


def test_ids_are_uuid7_and_sort_in_creation_order() -> None:
    first = new_id()
    second = new_id()

    assert uuid.UUID(first).version == 7
    assert uuid.UUID(second).version == 7
    assert first < second


def test_money_conversion_is_exact_and_rejects_ambiguous_input() -> None:
    assert minor_units("12.34", "USD") == 1234
    assert minor_units("-0.01", "USD") == -1
    assert minor_units(7, "USD") == 700

    with pytest.raises(MoneyError):
        minor_units(0.1, "USD")
    with pytest.raises(MoneyError):
        minor_units("1.001", "USD")
    with pytest.raises(MoneyError):
        minor_units("1.00", "usd")


def test_provider_instant_derives_new_york_reporting_date() -> None:
    assert local_date("2026-01-01T03:30:00Z") == date(2025, 12, 31)
    assert local_date("2026-07-01T04:30:00+00:00") == date(2026, 7, 1)


def test_connection_enables_safety_pragmas(tmp_path: Path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    try:
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert connection.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
        assert connection.execute("PRAGMA synchronous").fetchone()[0] == 1
    finally:
        connection.close()


def test_migrations_are_idempotent_and_install_core_constraints(tmp_path: Path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    try:
        migrate(connection)
        migrate(connection)

        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {
            "accounts",
            "transactions",
            "transaction_external_ids",
            "transaction_splits",
            "audit_events",
            "schema_migrations",
        } <= tables
        assert connection.execute(
            "SELECT COUNT(*) FROM schema_migrations"
        ).fetchone()[0] == 2

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO institutions (id, provider, external_id, name, created_at)
                VALUES ('x', 'synthetic', 'bank', 'Bank', '2026-10-11T00:00:00Z')
                """
            )
    finally:
        connection.close()
