from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.savings_goals import (
    SavingsGoalConflict,
    SavingsGoalError,
    archive_savings_goal,
    assign_account_pool,
    assign_manual_asset_pool,
    create_savings_goal,
    delete_unused_savings_goal,
    initialization_preview,
    initialize_goal_ledger,
    reorder_savings_goals,
    update_savings_goal,
)


@pytest.fixture
def ledger(tmp_path: Path) -> sqlite3.Connection:
    connection = connect(tmp_path / "savings-goals.sqlite3")
    migrate(connection)
    yield connection
    connection.close()


@pytest.mark.parametrize(
    ("balance_minor", "emergency_minor", "general_minor"),
    (
        (2_000_000, 2_000_000, 0),
        (2_500_000, 2_500_000, 0),
        (3_000_000, 2_500_000, 500_000),
    ),
)
def test_initialization_allocates_25000_to_emergency_then_general(
    ledger: sqlite3.Connection,
    balance_minor: int,
    emergency_minor: int,
    general_minor: int,
) -> None:
    account_id = _add_savings_account(ledger, balance_minor)
    asset_id = _add_manual_investment(ledger, 123_400)

    preview = initialization_preview(ledger, "2026-10")
    assert preview.regular_balance_minor == balance_minor
    assert preview.emergency_minor == emergency_minor
    assert preview.general_minor == general_minor
    assert preview.retirement_balance_minor == 123_400

    initialize_goal_ledger(ledger, "2026-10", balance_minor)
    first_entry_count = ledger.execute("SELECT COUNT(*) FROM savings_ledger_entries").fetchone()[0]
    initialize_goal_ledger(ledger, "2026-10", balance_minor)

    balances = {
        row["name"]: row["balance_minor"]
        for row in ledger.execute(
            """
            SELECT g.name, COALESCE(SUM(e.amount_minor), 0) balance_minor
            FROM savings_goals g
            LEFT JOIN savings_ledger_entries e ON e.goal_id = g.id
            GROUP BY g.id, g.name
            """
        )
    }
    assert balances["Emergency"] == emergency_minor
    assert balances["General Savings"] == general_minor
    assert sum(value for name, value in balances.items() if name.endswith("Roth IRA")) == 123_400
    assert ledger.execute("SELECT COUNT(*) FROM savings_ledger_entries").fetchone()[0] == first_entry_count
    assert ledger.execute("SELECT savings_pool FROM accounts WHERE id = ?", (account_id,)).fetchone()[0] == "regular"
    assert tuple(
        ledger.execute(
            "SELECT savings_pool, savings_goal_id FROM manual_assets WHERE id = ?", (asset_id,)
        ).fetchone()
    )[0] == "retirement"
    assert ledger.execute(
        "SELECT COUNT(*) FROM savings_ledger_entries WHERE month < '2026-10'"
    ).fetchone()[0] == 0


def test_initialization_rejects_changed_regular_balance(ledger: sqlite3.Connection) -> None:
    _add_savings_account(ledger, 3_000_000)

    with pytest.raises(SavingsGoalConflict, match="balance changed"):
        initialize_goal_ledger(ledger, "2026-10", 2_999_999)

    assert ledger.execute("SELECT COUNT(*) FROM savings_settings").fetchone()[0] == 0
    assert ledger.execute("SELECT COUNT(*) FROM savings_goals").fetchone()[0] == 0


def test_goal_lifecycle_validates_hierarchy_fields_and_unique_category_link(
    ledger: sqlite3.Connection,
) -> None:
    shopping_id = ledger.execute("SELECT id FROM categories WHERE name = 'Shopping'").fetchone()[0]
    parent_id = create_savings_goal(
        ledger, name="Lifestyle reserve", pool="regular", owner="Shared",
        icon_key="wallet", color_key="navy", activation_month="2026-10",
    )
    child_id = create_savings_goal(
        ledger, name="Shopping", pool="regular", owner="Shared",
        icon_key="shopping_bag", color_key="pink", activation_month="2026-10",
        parent_id=parent_id, linked_category_id=shopping_id, monthly_target_minor=50_000,
    )

    with pytest.raises(SavingsGoalError, match="one level"):
        create_savings_goal(
            ledger, name="Clothing", pool="regular", owner="Shared",
            icon_key="shopping_bag", color_key="pink", activation_month="2026-10",
            parent_id=child_id,
        )
    with pytest.raises(SavingsGoalError, match="already linked"):
        create_savings_goal(
            ledger, name="Duplicate shopping", pool="regular", owner="Shared",
            icon_key="shopping_bag", color_key="blue", activation_month="2026-10",
            linked_category_id=shopping_id,
        )
    for changes in (
        {"name": ""}, {"owner": "Nobody"}, {"icon_key": "unknown"},
        {"color_key": "invisible"},
    ):
        values = {
            "name": "Goal", "pool": "regular", "owner": "Shared",
            "icon_key": "wallet", "color_key": "blue", "activation_month": "2026-10",
            **changes,
        }
        with pytest.raises(SavingsGoalError):
            create_savings_goal(ledger, **values)


def test_goal_updates_conflict_archive_history_delete_unused_reorder_and_audit(
    ledger: sqlite3.Connection,
) -> None:
    _add_savings_account(ledger, 3_000_000)
    initialize_goal_ledger(ledger, "2026-10", 3_000_000)
    emergency = ledger.execute("SELECT * FROM savings_goals WHERE name = 'Emergency'").fetchone()
    spare_id = create_savings_goal(
        ledger, name="Vacation", pool="regular", owner="Shared",
        icon_key="palm_tree", color_key="orange", activation_month="2026-10",
    )

    with pytest.raises(SavingsGoalConflict, match="changed"):
        update_savings_goal(
            ledger, spare_id, "stale", name="Trip", owner="Shared",
            icon_key="palm_tree", color_key="orange", parent_id=None,
            linked_category_id=None,
        )
    spare = ledger.execute("SELECT * FROM savings_goals WHERE id = ?", (spare_id,)).fetchone()
    update_savings_goal(
        ledger, spare_id, spare["updated_at"], name="Trip", owner="Shared",
        icon_key="palm_tree", color_key="orange", parent_id=None,
        linked_category_id=None,
    )
    delete_unused_savings_goal(
        ledger, spare_id,
        ledger.execute("SELECT updated_at FROM savings_goals WHERE id = ?", (spare_id,)).fetchone()[0],
    )
    assert ledger.execute("SELECT 1 FROM savings_goals WHERE id = ?", (spare_id,)).fetchone() is None

    with pytest.raises(SavingsGoalError, match="history"):
        delete_unused_savings_goal(ledger, emergency["id"], emergency["updated_at"])
    archive_savings_goal(ledger, emergency["id"], emergency["updated_at"])
    assert ledger.execute("SELECT active FROM savings_goals WHERE id = ?", (emergency["id"],)).fetchone()[0] == 0

    active_ids = [row[0] for row in ledger.execute(
        "SELECT id FROM savings_goals WHERE pool = 'regular' AND active = 1 ORDER BY priority, id"
    )]
    settings_revision = ledger.execute("SELECT updated_at FROM savings_settings WHERE id = 1").fetchone()[0]
    reorder_savings_goals(ledger, "regular", list(reversed(active_ids)), settings_revision)
    assert [row[0] for row in ledger.execute(
        "SELECT id FROM savings_goals WHERE pool = 'regular' AND active = 1 ORDER BY priority, id"
    )] == list(reversed(active_ids))
    assert {row[0] for row in ledger.execute(
        "SELECT action FROM audit_events WHERE entity_type = 'savings_goal'"
    )} >= {"savings_goal_create", "savings_goal_update", "savings_goal_delete", "savings_goal_archive"}


def test_pool_assignments_require_current_revision_and_compatible_goal(
    ledger: sqlite3.Connection,
) -> None:
    account_id = _add_savings_account(ledger, 100_000)
    asset_id = _add_manual_investment(ledger, 200_000)
    goal_id = create_savings_goal(
        ledger, name="David retirement", pool="retirement", owner="David",
        icon_key="chart", color_key="purple", activation_month="2026-10",
    )
    account_revision = ledger.execute("SELECT updated_at FROM accounts WHERE id = ?", (account_id,)).fetchone()[0]
    asset_revision = ledger.execute("SELECT updated_at FROM manual_assets WHERE id = ?", (asset_id,)).fetchone()[0]

    with pytest.raises(SavingsGoalConflict):
        assign_account_pool(ledger, account_id, "regular", "stale")
    assign_account_pool(ledger, account_id, "regular", account_revision)
    assign_manual_asset_pool(ledger, asset_id, "retirement", goal_id, asset_revision)

    assert ledger.execute("SELECT savings_pool FROM accounts WHERE id = ?", (account_id,)).fetchone()[0] == "regular"
    assert tuple(ledger.execute(
        "SELECT savings_pool, savings_goal_id FROM manual_assets WHERE id = ?", (asset_id,)
    ).fetchone()) == ("retirement", goal_id)


def _add_savings_account(connection: sqlite3.Connection, balance_minor: int) -> str:
    now = "2026-10-26T12:00:00Z"
    institution_id, provider_id, account_id = new_id(), new_id(), new_id()
    connection.execute(
        "INSERT INTO institutions VALUES (?, 'synthetic', ?, 'Savings bank', ?)",
        (institution_id, f"institution-{account_id}", now),
    )
    connection.execute(
        """
        INSERT INTO provider_connections
        (id, provider, external_connection_id, institution_id, status, created_at, updated_at)
        VALUES (?, 'synthetic', ?, ?, 'active', ?, ?)
        """,
        (provider_id, f"connection-{account_id}", institution_id, now, now),
    )
    connection.execute(
        """
        INSERT INTO accounts
        (id, connection_id, provider_account_id, name, type, subtype, nature,
         currency, include_savings, created_at, updated_at)
        VALUES (?, ?, ?, 'Joint savings', 'depository', 'savings', 'asset',
                'USD', 1, ?, ?)
        """,
        (account_id, provider_id, f"savings-{account_id}", now, now),
    )
    connection.execute(
        """
        INSERT INTO account_balance_snapshots
        (id, account_id, observed_at, current_minor, currency, source)
        VALUES (?, ?, ?, ?, 'USD', 'synthetic')
        """,
        (new_id(), account_id, now, balance_minor),
    )
    return account_id


def _add_manual_investment(connection: sqlite3.Connection, value_minor: int) -> str:
    asset_id = new_id()
    now = "2026-10-26T12:00:00Z"
    connection.execute(
        """
        INSERT INTO manual_assets
        (id, title, kind, owner, current_value_minor, currency, as_of_date,
         active, created_at, updated_at)
        VALUES (?, 'David Roth IRA', 'investment', 'David', ?, 'USD',
                '2026-10-26', 1, ?, ?)
        """,
        (asset_id, value_minor, now, now),
    )
    return asset_id
