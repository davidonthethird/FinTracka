from __future__ import annotations

import sqlite3
import stat
from concurrent.futures import ThreadPoolExecutor
from importlib.resources import files
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
        ] == list(range(1, 21))
        starter_categories = {
            row[0]
            for row in connection.execute("SELECT name FROM categories WHERE archived = 0")
        }
        assert {"Salary", "Groceries", "Housing", "Credit card payment", "Refunds & reimbursements"} <= starter_categories
        tzedaka = connection.execute(
            "SELECT c.id, g.name FROM categories c JOIN category_groups g ON g.id = c.group_id WHERE c.name = 'Tzedaka'"
        ).fetchone()
        assert tuple(tzedaka) == ("01a13243-efa9-7b54-b1f7-dea052230fcb", "Tzedaka")
        assert connection.execute("SELECT 1 FROM categories WHERE name = 'Giving'").fetchone() is None
        manual = connection.execute(
            """
            SELECT pc.provider, a.name, a.include_overview, a.include_budget, a.include_net, a.include_export
            FROM accounts a JOIN provider_connections pc ON pc.id = a.connection_id
            WHERE pc.provider = 'manual'
            """
        ).fetchone()
        assert tuple(manual) == ("manual", "Manual cash", 1, 1, 0, 1)
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

        source_id = new_id()
        connection.execute(
            "INSERT INTO planning_income_sources (id, created_at, updated_at) VALUES (?, '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')",
            (source_id,),
        )
        invalid_versions = (
            ("2026-1", "Salary", 100),
            ("2026-10", "Gift", 100),
            ("2026-10", "Salary", -1),
        )
        for month, income_type, amount in invalid_versions:
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute(
                    """
                    INSERT INTO planning_income_versions
                    (id, source_id, effective_month, title, income_type, amount_minor, currency, active, created_at, updated_at)
                    VALUES (?, ?, ?, 'Pay', ?, ?, 'USD', 1, '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')
                    """,
                    (new_id(), source_id, month, income_type, amount),
                )
        transaction_id = new_id()
        connection.execute(
            """
            INSERT INTO transactions
            (id, account_id, local_date, amount_minor, currency, provider_description, created_at, updated_at)
            VALUES (?, '01a13243-efa9-7b54-b1f7-dea052230fd1', '2026-10-13', -100, 'USD', 'Cash',
                    '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')
            """,
            (transaction_id,),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("UPDATE transactions SET is_cash_withdrawal = 2 WHERE id = ?", (transaction_id,))
    finally:
        connection.close()


def test_plaid_profile_migration_preserves_legacy_ledger_and_reference_metadata(
    tmp_path: Path,
) -> None:
    path = tmp_path / "legacy.sqlite3"
    connection = connect(path)
    try:
        _migrate_through(connection, 12)
        now = "2026-10-26T12:00:00Z"
        institution_id, connection_id, account_id, transaction_id = [new_id() for _ in range(4)]
        connection.execute(
            "INSERT INTO institutions VALUES (?, 'plaid', 'ins-legacy', 'Legacy bank', ?)",
            (institution_id, now),
        )
        connection.execute(
            """
            INSERT INTO provider_connections
            (id, provider, external_connection_id, institution_id, status, created_at,
             updated_at, environment, history_available_from)
            VALUES (?, 'plaid', 'item-legacy', ?, 'active', ?, ?, 'production', '2026-08-01')
            """,
            (connection_id, institution_id, now, now),
        )
        connection.execute(
            "INSERT INTO provider_checkpoints VALUES (?, 'cursor-legacy', ?)",
            (connection_id, now),
        )
        connection.execute(
            """
            INSERT INTO accounts
            (id, connection_id, provider_account_id, name, type, subtype, nature,
             currency, spending_owner, created_at, updated_at)
            VALUES (?, ?, 'checking-legacy', 'Checking', 'depository', 'checking',
                    'asset', 'USD', 'Shared', ?, ?)
            """,
            (account_id, connection_id, now, now),
        )
        connection.execute(
            """
            INSERT INTO transactions
            (id, account_id, local_date, amount_minor, currency, provider_description,
             created_at, updated_at)
            VALUES (?, ?, '2026-10-25', -1234, 'USD', 'Legacy purchase', ?, ?)
            """,
            (transaction_id, account_id, now, now),
        )
        legacy_metadata = {
            "plaid.environment": "production",
            "plaid.sandbox.client_id_ref": "legacy-sandbox-client",
            "plaid.sandbox.secret_ref": "legacy-sandbox-secret",
            "plaid.production.client_id_ref": "legacy-production-client",
            "plaid.production.secret_ref": "legacy-production-secret",
        }
        connection.executemany(
            "INSERT INTO app_metadata (key, value) VALUES (?, ?)", legacy_metadata.items()
        )
        before = {
            "connections": connection.execute("SELECT COUNT(*) FROM provider_connections").fetchone()[0],
            "accounts": connection.execute("SELECT COUNT(*) FROM accounts").fetchone()[0],
            "transactions": connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0],
            "total": connection.execute("SELECT SUM(amount_minor) FROM transactions").fetchone()[0],
        }

        migrate(connection)

        assert connection.execute(
            "SELECT credential_profile FROM provider_connections WHERE id = ?", (connection_id,)
        ).fetchone()[0] == "david"
        assert connection.execute(
            "SELECT cursor FROM provider_checkpoints WHERE connection_id = ?", (connection_id,)
        ).fetchone()[0] == "cursor-legacy"
        assert connection.execute("SELECT id FROM accounts WHERE id = ?", (account_id,)).fetchone()[0] == account_id
        assert connection.execute(
            "SELECT id FROM transactions WHERE id = ?", (transaction_id,)
        ).fetchone()[0] == transaction_id
        assert {
            "connections": connection.execute("SELECT COUNT(*) FROM provider_connections").fetchone()[0],
            "accounts": connection.execute("SELECT COUNT(*) FROM accounts").fetchone()[0],
            "transactions": connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0],
            "total": connection.execute("SELECT SUM(amount_minor) FROM transactions").fetchone()[0],
        } == before
        migrated = dict(
            connection.execute(
                "SELECT key, value FROM app_metadata WHERE key LIKE 'plaid.profile.david.%'"
            )
        )
        assert migrated == {
            "plaid.profile.david.environment": "production",
            "plaid.profile.david.sandbox.client_id_ref": "legacy-sandbox-client",
            "plaid.profile.david.sandbox.secret_ref": "legacy-sandbox-secret",
            "plaid.profile.david.production.client_id_ref": "legacy-production-client",
            "plaid.profile.david.production.secret_ref": "legacy-production-secret",
        }
        all_metadata = dict(
            connection.execute("SELECT key, value FROM app_metadata WHERE key LIKE 'plaid.%'")
        )
        assert all(all_metadata[key] == value for key, value in legacy_metadata.items())
    finally:
        connection.close()


def test_planning_migration_preserves_giving_identity_and_legacy_target(tmp_path: Path) -> None:
    connection = connect(tmp_path / "legacy.sqlite3")
    try:
        _migrate_through(connection, 7)
        giving_id = connection.execute("SELECT id FROM categories WHERE name = 'Giving'").fetchone()[0]
        institution_id, connection_id, account_id, transaction_id, rule_id = [new_id() for _ in range(5)]
        now = "2026-10-13T00:00:00Z"
        connection.execute(
            "INSERT INTO institutions VALUES (?, 'synthetic', 'legacy-bank', 'Legacy bank', ?)",
            (institution_id, now),
        )
        connection.execute(
            """
            INSERT INTO provider_connections
            (id, provider, external_connection_id, institution_id, status, created_at, updated_at, environment)
            VALUES (?, 'synthetic', 'legacy-item', ?, 'active', ?, ?, NULL)
            """,
            (connection_id, institution_id, now, now),
        )
        connection.execute(
            """
            INSERT INTO accounts
            (id, connection_id, provider_account_id, name, type, nature, currency, created_at, updated_at)
            VALUES (?, ?, 'legacy-account', 'Legacy checking', 'depository', 'asset', 'USD', ?, ?)
            """,
            (account_id, connection_id, now, now),
        )
        connection.execute(
            """
            INSERT INTO transactions
            (id, account_id, local_date, amount_minor, currency, provider_description, category_id, category_source, created_at, updated_at)
            VALUES (?, ?, '2026-10-01', -1800, 'USD', 'CHARITY', ?, 'manual', ?, ?)
            """,
            (transaction_id, account_id, giving_id, now, now),
        )
        connection.execute(
            """
            INSERT INTO categorization_rules
            (id, name, priority, conditions_json, category_id, created_at, updated_at)
            VALUES (?, 'Giving rule', 10, '{"description_contains":"CHARITY"}', ?, ?, ?)
            """,
            (rule_id, giving_id, now, now),
        )
        connection.execute(
            "INSERT INTO tracking_budget_targets VALUES (?, '2026-10', 50000, 'USD')",
            (giving_id,),
        )

        migrate(connection)

        assert tuple(connection.execute(
            "SELECT id, name FROM categories WHERE id = ?", (giving_id,)
        ).fetchone()) == (giving_id, "Tzedaka")
        assert connection.execute("SELECT category_id FROM transactions WHERE id = ?", (transaction_id,)).fetchone()[0] == giving_id
        assert connection.execute("SELECT category_id FROM categorization_rules WHERE id = ?", (rule_id,)).fetchone()[0] == giving_id
        assert tuple(connection.execute(
            "SELECT category_id, month, amount_minor, currency FROM planning_target_overrides"
        ).fetchone()) == (giving_id, "2026-10", 50000, "USD")
    finally:
        connection.close()


def test_migrations_009_and_010_add_and_backfill_subcategories(tmp_path: Path) -> None:
    connection = connect(tmp_path / "legacy.sqlite3")
    try:
        _migrate_through(connection, 8)
        now = "2026-10-13T12:00:00Z"
        institution_id, connection_id, checking_id, savings_id, transaction_id = [
            new_id() for _ in range(5)
        ]
        connection.execute(
            "INSERT INTO institutions VALUES (?, 'plaid', 'ins-history', 'History bank', ?)",
            (institution_id, now),
        )
        connection.execute(
            """
            INSERT INTO provider_connections
            (id, provider, external_connection_id, institution_id, status, created_at, updated_at, environment)
            VALUES (?, 'plaid', 'item-history', ?, 'active', ?, ?, 'production')
            """,
            (connection_id, institution_id, now, now),
        )
        for account_id, external_id, name, subtype in (
            (checking_id, "checking", "Checking", "checking"),
            (savings_id, "savings", "Savings", "savings"),
        ):
            connection.execute(
                """
                INSERT INTO accounts
                (id, connection_id, provider_account_id, name, type, subtype, nature,
                 currency, spending_owner, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'depository', ?, 'asset', 'USD', 'Shared', ?, ?)
                """,
                (account_id, connection_id, external_id, name, subtype, now, now),
            )
        shopping_id = connection.execute(
            "SELECT id FROM categories WHERE name = 'Shopping'"
        ).fetchone()[0]
        dining_id = connection.execute(
            "SELECT id FROM categories WHERE name = 'Dining'"
        ).fetchone()[0]
        connection.execute(
            """
            INSERT INTO transactions
            (id, account_id, local_date, amount_minor, currency, provider_description,
             provider_merchant, category_id, category_source, created_at, updated_at)
            VALUES (?, ?, '2026-07-01', -1000, 'USD', 'OLD PURCHASE', 'Lowe''s', ?, 'provider', ?, ?)
            """,
            (transaction_id, checking_id, shopping_id, now, now),
        )
        before_categories = {
            row[0] for row in connection.execute("SELECT id FROM categories")
        }

        _apply_migration(connection, 9)
        manual_transaction_id = new_id()
        clothing_id = connection.execute(
            "SELECT id FROM subcategories WHERE category_id = ? AND name = 'Clothing'",
            (shopping_id,),
        ).fetchone()[0]
        connection.execute(
            """
            INSERT INTO transactions
            (id, account_id, local_date, amount_minor, currency, provider_description,
             provider_merchant, category_id, category_source, subcategory_id,
             subcategory_source, created_at, updated_at)
            VALUES (?, ?, '2026-07-02', -2000, 'USD', 'MANUAL PURCHASE', 'Macy''s',
                    ?, 'manual', ?, 'manual', ?, ?)
            """,
            (manual_transaction_id, checking_id, shopping_id, clothing_id, now, now),
        )
        before_transactions = {
            row[0] for row in connection.execute("SELECT id FROM transactions")
        }

        migrate(connection)

        assert [
            row[0]
            for row in connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            )
        ] == list(range(1, 21))
        assert connection.execute(
            "SELECT history_available_from FROM provider_connections WHERE id = ?",
            (connection_id,),
        ).fetchone()[0] == "2026-07-01"
        assert [
            row[0]
            for row in connection.execute(
                "SELECT include_savings FROM accounts WHERE id IN (?, ?) ORDER BY name",
                (checking_id, savings_id),
            )
        ] == [0, 1]
        assert {row[0] for row in connection.execute("SELECT id FROM transactions")} == before_transactions
        assert {row[0] for row in connection.execute("SELECT id FROM categories")} == (
            before_categories | {"01a13243-efa9-7b54-b1f7-dea052230fd2"}
        )
        assert connection.execute("SELECT COUNT(*) FROM transaction_subcategory_rules").fetchone()[0] >= 40
        assert tuple(connection.execute(
            """
            SELECT s.name, t.subcategory_source
            FROM transactions t JOIN subcategories s ON s.id = t.subcategory_id
            WHERE t.id = ?
            """,
            (transaction_id,),
        ).fetchone()) == ("Home improvement", "provider")
        assert tuple(connection.execute(
            "SELECT subcategory_id, subcategory_source FROM transactions WHERE id = ?",
            (manual_transaction_id,),
        ).fetchone()) == (clothing_id, "manual")
        assert connection.execute(
            """
            SELECT COUNT(*) FROM subcategories s JOIN categories c ON c.id = s.category_id
            WHERE c.name = 'Shopping' AND s.name IN ('Clothing', 'Home improvement', 'General')
            """
        ).fetchone()[0] == 3

        clothing_id = connection.execute(
            """
            SELECT s.id FROM subcategories s JOIN categories c ON c.id = s.category_id
            WHERE c.name = 'Shopping' AND s.name = 'Clothing'
            """
        ).fetchone()[0]
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE transactions SET category_id = ?, subcategory_id = ? WHERE id = ?",
                (dining_id, clothing_id, transaction_id),
            )

        for owner, kind, amount in (
            ("Nobody", "savings", 100),
            ("Shared", "collectible", 100),
            ("Shared", "investment", -1),
        ):
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute(
                    """
                    INSERT INTO manual_assets
                    (id, title, kind, owner, current_value_minor, currency, as_of_date,
                     active, created_at, updated_at)
                    VALUES (?, 'Asset', ?, ?, ?, 'USD', '2026-10-13', 1, ?, ?)
                    """,
                    (new_id(), kind, owner, amount, now, now),
                )
    finally:
        connection.close()


def test_migration_014_preserves_existing_savings_data_and_adds_goal_constraints(
    tmp_path: Path,
) -> None:
    connection = connect(tmp_path / "legacy-savings.sqlite3")
    try:
        _migrate_through(connection, 13)
        now = "2026-10-26T12:00:00Z"
        institution_id, provider_id, account_id, asset_id = [new_id() for _ in range(4)]
        connection.execute(
            "INSERT INTO institutions VALUES (?, 'plaid', 'ins-savings', 'Savings bank', ?)",
            (institution_id, now),
        )
        connection.execute(
            """
            INSERT INTO provider_connections
            (id, provider, external_connection_id, institution_id, status, created_at,
             updated_at, environment, credential_profile)
            VALUES (?, 'plaid', 'item-savings', ?, 'active', ?, ?, 'production', 'david')
            """,
            (provider_id, institution_id, now, now),
        )
        connection.execute(
            """
            INSERT INTO accounts
            (id, connection_id, provider_account_id, name, type, subtype, nature,
             currency, include_savings, created_at, updated_at)
            VALUES (?, ?, 'joint-savings', 'Joint savings', 'depository', 'savings',
                    'asset', 'USD', 1, ?, ?)
            """,
            (account_id, provider_id, now, now),
        )
        connection.execute(
            """
            INSERT INTO manual_assets
            (id, title, kind, owner, current_value_minor, currency, as_of_date,
             active, created_at, updated_at)
            VALUES (?, 'David Roth IRA', 'investment', 'David', 123400, 'USD',
                    '2026-10-26', 1, ?, ?)
            """,
            (asset_id, now, now),
        )

        migrate(connection)
        migrate(connection)

        assert connection.execute("SELECT name FROM accounts WHERE id = ?", (account_id,)).fetchone()[0] == "Joint savings"
        assert connection.execute("SELECT title FROM manual_assets WHERE id = ?", (asset_id,)).fetchone()[0] == "David Roth IRA"
        assert connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 20
        assert {
            "savings_settings",
            "savings_goals",
            "savings_goal_target_versions",
            "savings_goal_overflow_rules",
            "savings_ledger_entries",
            "savings_month_reviews",
        } <= {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        assert {row[1] for row in connection.execute("PRAGMA table_info(accounts)")} >= {"savings_pool"}
        assert {row[1] for row in connection.execute("PRAGMA table_info(manual_assets)")} >= {
            "savings_pool", "savings_goal_id"
        }
        assert "overall_target_minor" in {
            row[1] for row in connection.execute("PRAGMA table_info(savings_goals)")
        }

        for table in ("accounts", "manual_assets"):
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute(f"UPDATE {table} SET savings_pool = 'brokerage'")

        valid_goal = new_id()
        connection.execute(
            """
            INSERT INTO savings_goals
            (id, name, pool, owner, icon_key, color_key, priority, active,
             activation_month, created_at, updated_at)
            VALUES (?, 'Emergency', 'regular', 'Shared', 'shield', 'blue', 1, 1,
                    '2026-10', ?, ?)
            """,
            (valid_goal, now, now),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE savings_goals SET overall_target_minor = 0 WHERE id = ?",
                (valid_goal,),
            )
        invalid_rows = (
            ("Nobody", "shield", "blue", "USD"),
            ("Shared", "unknown", "blue", "USD"),
            ("Shared", "shield", "invisible", "USD"),
        )
        for owner, icon, color, _currency in invalid_rows:
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute(
                    """
                    INSERT INTO savings_goals
                    (id, name, pool, owner, icon_key, color_key, priority, active,
                     activation_month, created_at, updated_at)
                    VALUES (?, 'Invalid', 'regular', ?, ?, ?, 2, 1, '2026-10', ?, ?)
                    """,
                    (new_id(), owner, icon, color, now, now),
                )

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO savings_ledger_entries
                (id, movement_id, pool, bucket_type, goal_id, amount_minor, currency,
                 event_type, effective_date, month, source_key, actor, created_at)
                VALUES (?, ?, 'regular', 'goal', ?, 100, 'usd', 'opening',
                        '2026-10-26', '2026-10', 'opening:bad-currency', 'system', ?)
                """,
                (new_id(), new_id(), valid_goal, now),
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO savings_ledger_entries
                (id, movement_id, pool, bucket_type, amount_minor, currency,
                 event_type, effective_date, month, source_key, actor, created_at)
                VALUES (?, ?, 'regular', 'unallocated', 100, 'USD', 'invented',
                        '2026-10-26', '2026-10', 'invalid:event', 'system', ?)
                """,
                (new_id(), new_id(), now),
            )
    finally:
        connection.close()


def test_migration_016_backfills_existing_emergency_overall_target(tmp_path: Path) -> None:
    connection = connect(tmp_path / "legacy-goals.sqlite3")
    try:
        _migrate_through(connection, 15)
        now = "2026-10-27T12:00:00Z"
        emergency_id = new_id()
        connection.execute(
            """
            INSERT INTO savings_goals
            (id, name, pool, owner, icon_key, color_key, priority, active,
             activation_month, created_at, updated_at)
            VALUES (?, 'Emergency', 'regular', 'Shared', 'shield', 'blue', 1, 1,
                    '2026-10', ?, ?)
            """,
            (emergency_id, now, now),
        )

        _apply_migration(connection, 16)

        assert connection.execute(
            "SELECT overall_target_minor FROM savings_goals WHERE id = ?",
            (emergency_id,),
        ).fetchone()[0] == 2_500_000
    finally:
        connection.close()


def test_migration_014_creates_pre_migration_backup(tmp_path: Path) -> None:
    database_path = tmp_path / "ledger.sqlite3"
    connection = connect(database_path)
    try:
        _migrate_through(connection, 13)
        migrate(connection)
    finally:
        connection.close()

    backups = list((tmp_path / "backups").glob("fintracka-pre-migration-014-*.sqlite3"))
    assert len(backups) == 1
    backup = connect(backups[0])
    try:
        assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert backup.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 13
    finally:
        backup.close()


def _migrate_through(connection: sqlite3.Connection, maximum_version: int) -> None:
    connection.execute(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
    )
    migration_root = files("fintracka").joinpath("migrations")
    for resource in sorted(migration_root.iterdir(), key=lambda item: item.name):
        if resource.suffix != ".sql":
            continue
        version = int(resource.name.split("_", 1)[0])
        if version > maximum_version:
            continue
        _apply_migration(connection, version)


def _apply_migration(connection: sqlite3.Connection, version: int) -> None:
    migration_root = files("fintracka").joinpath("migrations")
    resource = next(
        item for item in migration_root.iterdir()
        if item.suffix == ".sql" and int(item.name.split("_", 1)[0]) == version
    )
    name = resource.name.replace("'", "''")
    connection.executescript(
        "BEGIN IMMEDIATE;\n"
        + resource.read_text(encoding="utf-8")
        + f"\nINSERT INTO schema_migrations VALUES ({version}, '{name}', '2026-10-13T00:00:00Z');\nCOMMIT;"
    )

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
