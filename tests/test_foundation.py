from __future__ import annotations

import sqlite3
import stat
from concurrent.futures import ThreadPoolExecutor
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
        assert [
            row[0] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")
        ] == [1, 2, 3, 4, 5, 6]
        starter_categories = {
            row[0]
            for row in connection.execute("SELECT name FROM categories WHERE archived = 0")
        }
        assert {"Salary", "Groceries", "Housing", "Credit card payment", "Refunds & reimbursements"} <= starter_categories
        assert "environment" in {
            row[1] for row in connection.execute("PRAGMA table_info(provider_connections)")
        }

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO institutions (id, provider, external_id, name, created_at)
                VALUES ('x', 'synthetic', 'bank', 'Bank', '2026-10-11T00:00:00Z')
                """
            )
    finally:
        connection.close()

def test_request_connection_can_cross_fastapi_worker_threads(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    with ThreadPoolExecutor(max_workers=1) as executor:
        result = executor.submit(lambda: connection.execute("SELECT 1").fetchone()[0]).result()
    connection.close()
    assert result == 1


def test_database_file_permissions_are_owner_only(tmp_path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    connection.close()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
