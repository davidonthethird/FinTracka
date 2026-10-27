from __future__ import annotations

import sqlite3
from datetime import date
from pathlib import Path

import pytest

from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.savings_goals import (
    AllocationPlanRow,
    SavingsGoalConflict,
    SavingsGoalError,
    archive_savings_goal,
    assign_account_pool,
    assign_manual_asset_pool,
    create_savings_goal,
    delete_unused_savings_goal,
    accept_month_review,
    generate_month_review,
    initialization_preview,
    initialize_goal_ledger,
    allocate_contribution,
    allocation_preview,
    rebalance_allocation,
    reconcile_savings_draws,
    reconcile_savings_transactions,
    record_retirement_valuation,
    savings_goal_detail,
    savings_goal_overview,
    undo_savings_event,
    reverse_source_events,
    reorder_savings_goals,
    set_allocation_plan,
    update_savings_goal,
)
from fintracka.planning import set_recurring_target
from fintracka.savings import create_manual_asset, update_manual_asset


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
    asset = ledger.execute("SELECT * FROM manual_assets WHERE id = ?", (asset_id,)).fetchone()
    assign_manual_asset_pool(ledger, asset_id, "retirement", None, asset["updated_at"])

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


def test_retirement_assets_require_explicit_assignment_and_open_exactly_once(
    ledger: sqlite3.Connection,
) -> None:
    _add_savings_account(ledger, 0)
    asset_id = _add_manual_investment(ledger, 123_400)
    assert initialization_preview(ledger, "2026-10").retirement_balance_minor == 0
    asset = ledger.execute("SELECT * FROM manual_assets WHERE id = ?", (asset_id,)).fetchone()
    assign_manual_asset_pool(ledger, asset_id, "retirement", None, asset["updated_at"])
    assert initialization_preview(ledger, "2026-10").retirement_balance_minor == 123_400

    initialize_goal_ledger(ledger, "2026-10", 0)
    overview = savings_goal_overview(ledger, "2026-10")

    assert overview.retirement_minor == 123_400
    assert overview.retirement_reconciliation_minor == 0
    assert ledger.execute(
        "SELECT COUNT(*) FROM savings_ledger_entries WHERE manual_asset_id = ? AND event_type = 'opening'",
        (asset_id,),
    ).fetchone()[0] == 1


def test_connected_retirement_account_gets_opening_goal(
    ledger: sqlite3.Connection,
) -> None:
    _add_savings_account(ledger, 0)
    account_id = _add_savings_account(ledger, 123_400)
    ledger.execute(
        "UPDATE accounts SET name = 'Fidelity Roth IRA', subtype = 'investment', savings_pool = 'retirement', spending_owner = 'David' WHERE id = ?",
        (account_id,),
    )

    preview = initialization_preview(ledger, "2026-10")
    assert preview.retirement_balance_minor == 123_400
    initialize_goal_ledger(ledger, "2026-10", 0)
    overview = savings_goal_overview(ledger, "2026-10")

    assert overview.retirement_minor == 123_400
    assert overview.retirement_reconciliation_minor == 0
    assert any(
        goal.name == "Fidelity Roth IRA" and goal.owner == "David"
        for goal in overview.goals
    )


def test_post_initialization_connected_retirement_assignment_opens_goal(
    ledger: sqlite3.Connection,
) -> None:
    _add_savings_account(ledger, 0)
    initialize_goal_ledger(ledger, "2026-10", 0)
    account_id = _add_savings_account(ledger, 123_400)
    ledger.execute(
        "UPDATE accounts SET name = 'Fidelity Roth IRA', subtype = 'investment', spending_owner = 'David' WHERE id = ?",
        (account_id,),
    )
    account = ledger.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()

    assign_account_pool(ledger, account_id, "retirement", account["updated_at"])

    overview = savings_goal_overview(ledger, "2026-10")
    assert overview.retirement_minor == 123_400
    assert overview.retirement_reconciliation_minor == 0


def test_post_initialization_retirement_assignment_records_opening_value(
    ledger: sqlite3.Connection,
) -> None:
    _add_savings_account(ledger, 0)
    initialize_goal_ledger(ledger, "2026-10", 0)
    asset_id = _add_manual_investment(ledger, 200_000)
    goal_id = create_savings_goal(
        ledger, name="David Roth IRA", pool="retirement", owner="David",
        icon_key="chart", color_key="purple", activation_month="2026-10",
    )
    asset = ledger.execute("SELECT * FROM manual_assets WHERE id = ?", (asset_id,)).fetchone()

    assign_manual_asset_pool(ledger, asset_id, "retirement", goal_id, asset["updated_at"])

    assert savings_goal_detail(ledger, goal_id, "2026-10").balance_minor == 200_000
    assert savings_goal_overview(ledger, "2026-10").retirement_reconciliation_minor == 0


def test_assigned_manual_cash_is_included_in_regular_reconciliation(
    ledger: sqlite3.Connection,
) -> None:
    _add_savings_account(ledger, 0)
    initialize_goal_ledger(ledger, "2026-10", 0)
    goal_id = create_savings_goal(
        ledger, name="Cash reserve", pool="regular", owner="Shared",
        icon_key="piggy_bank", color_key="blue", activation_month="2026-10",
    )
    asset_id = create_manual_asset(
        ledger, "Home safe", "savings", "Shared", 75_000, "2026-10-26"
    )
    asset = ledger.execute("SELECT * FROM manual_assets WHERE id = ?", (asset_id,)).fetchone()

    assign_manual_asset_pool(ledger, asset_id, "regular", goal_id, asset["updated_at"])

    overview = savings_goal_overview(ledger, "2026-10")
    assert overview.regular_minor == 75_000
    assert overview.regular_reconciliation_minor == 0

    asset = ledger.execute("SELECT * FROM manual_assets WHERE id = ?", (asset_id,)).fetchone()
    update_manual_asset(
        ledger, asset_id, asset["updated_at"], "Home safe", "savings", "Shared",
        80_000, "2026-10-27",
    )
    assert savings_goal_overview(ledger, "2026-10").regular_reconciliation_minor == 0


def test_unassigned_manual_asset_opens_in_its_pool_unallocated_bucket(
    ledger: sqlite3.Connection,
) -> None:
    _add_savings_account(ledger, 0)
    initialize_goal_ledger(ledger, "2026-10", 0)
    regular_id = create_manual_asset(
        ledger, "Cash reserve", "savings", "Shared", 75_000, "2026-10-26"
    )
    retirement_id = create_manual_asset(
        ledger, "Unassigned IRA", "investment", "Ariela", 125_000, "2026-10-26"
    )
    for asset_id, pool in ((regular_id, "regular"), (retirement_id, "retirement")):
        asset = ledger.execute(
            "SELECT * FROM manual_assets WHERE id = ?", (asset_id,)
        ).fetchone()
        assign_manual_asset_pool(ledger, asset_id, pool, None, asset["updated_at"])

    overview = savings_goal_overview(ledger, "2026-10")

    assert overview.unallocated_minor == 200_000
    assert overview.regular_reconciliation_minor == 0
    assert overview.retirement_reconciliation_minor == 0

    asset = ledger.execute(
        "SELECT * FROM manual_assets WHERE id = ?", (retirement_id,)
    ).fetchone()
    update_manual_asset(
        ledger, retirement_id, asset["updated_at"], "Unassigned IRA", "investment",
        "Ariela", 130_000, "2026-10-27",
    )
    overview = savings_goal_overview(ledger, "2026-10")
    assert overview.unallocated_minor == 205_000
    assert overview.retirement_reconciliation_minor == 0


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


def test_allocation_priority_excess_replay_and_reversal(ledger: sqlite3.Connection) -> None:
    account_id = _add_savings_account(ledger, 0)
    initialize_goal_ledger(ledger, "2026-10", 0)
    goals = {
        row["name"]: row["id"]
        for row in ledger.execute("SELECT id, name FROM savings_goals WHERE pool = 'regular'")
    }
    fun_id = create_savings_goal(
        ledger, name="Fun", pool="regular", owner="Shared", icon_key="gamepad",
        color_key="purple", activation_month="2026-10",
    )
    revision = ledger.execute("SELECT updated_at FROM savings_settings WHERE id = 1").fetchone()[0]
    set_allocation_plan(
        ledger, "regular", "2026-10",
        [
            AllocationPlanRow(goals["Emergency"], 50_000, False, 1),
            AllocationPlanRow(goals["General Savings"], 40_000, False, 2),
            AllocationPlanRow(fun_id, 10_000, False, 3),
        ],
        revision,
    )

    preview = allocation_preview(ledger, "regular", "2026-10", 80_000)
    assert [(row.target_minor, row.basis_points, row.allocated_minor) for row in preview.rows] == [
        (50_000, 5_000, 50_000), (40_000, 4_000, 30_000), (10_000, 1_000, 0),
    ]
    assert preview.unallocated_minor == 0
    assert [row.allocated_minor for row in allocation_preview(
        ledger, "regular", "2026-10", 110_000
    ).rows] == [55_000, 44_000, 11_000]

    transaction_id = _add_savings_transaction(ledger, account_id, 80_000)
    allocate_contribution(ledger, transaction_id)
    allocate_contribution(ledger, transaction_id)
    entries = ledger.execute(
        "SELECT amount_minor FROM savings_ledger_entries WHERE source_transaction_id = ? AND reverses_entry_id IS NULL ORDER BY amount_minor DESC",
        (transaction_id,),
    ).fetchall()
    assert [row[0] for row in entries] == [50_000, 30_000]

    reverse_source_events(ledger, f"transaction:{transaction_id}", "provider removed")
    reverse_source_events(ledger, f"transaction:{transaction_id}", "provider removed")
    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE source_transaction_id = ?",
        (transaction_id,),
    ).fetchone()[0] == 0


def test_modified_contribution_reverses_stale_allocation_and_reallocates(
    ledger: sqlite3.Connection,
) -> None:
    account_id = _add_savings_account(ledger, 0)
    initialize_goal_ledger(ledger, "2026-10", 0)
    emergency = ledger.execute(
        "SELECT id FROM savings_goals WHERE name = 'Emergency'"
    ).fetchone()[0]
    general = ledger.execute(
        "SELECT id FROM savings_goals WHERE name = 'General Savings'"
    ).fetchone()[0]
    fun_id = create_savings_goal(
        ledger, name="Fun", pool="regular", owner="Shared", icon_key="gamepad",
        color_key="purple", activation_month="2026-10",
    )
    revision = ledger.execute(
        "SELECT updated_at FROM savings_settings WHERE id = 1"
    ).fetchone()[0]
    set_allocation_plan(
        ledger,
        "regular",
        "2026-10",
        [
            AllocationPlanRow(emergency, 50_000, False, 1),
            AllocationPlanRow(general, 40_000, False, 2),
            AllocationPlanRow(fun_id, 10_000, False, 3),
        ],
        revision,
    )
    transaction_id = _add_savings_transaction(ledger, account_id, 80_000)
    reconcile_savings_transactions(ledger, [transaction_id])

    ledger.execute(
        "UPDATE transactions SET amount_minor = ? WHERE id = ?",
        (90_000, transaction_id),
    )
    reconcile_savings_transactions(ledger, [transaction_id])

    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE source_transaction_id = ?",
        (transaction_id,),
    ).fetchone()[0] == 90_000
    assert [row[0] for row in ledger.execute(
        """
        SELECT COALESCE(SUM(e.amount_minor), 0) FROM savings_goals g
        LEFT JOIN savings_ledger_entries e ON e.goal_id = g.id
        WHERE g.id IN (?, ?, ?) GROUP BY g.id ORDER BY g.priority
        """,
        (emergency, general, fun_id),
    )] == [50_000, 40_000, 0]
    assert ledger.execute(
        "SELECT COUNT(*) FROM savings_ledger_entries WHERE source_transaction_id = ? AND event_type = 'reversal'",
        (transaction_id,),
    ).fetchone()[0] > 0


def test_non_transfer_credit_is_earnings_not_monthly_contribution(
    ledger: sqlite3.Connection,
) -> None:
    account_id = _add_savings_account(ledger, 0)
    initialize_goal_ledger(ledger, "2026-10", 0)
    transaction_id = _add_savings_transaction(ledger, account_id, 1_234, transfer=False)

    reconcile_savings_transactions(ledger, [transaction_id])

    row = ledger.execute(
        "SELECT event_type, bucket_type, amount_minor FROM savings_ledger_entries WHERE source_transaction_id = ?",
        (transaction_id,),
    ).fetchone()
    assert tuple(row) == ("earnings", "unallocated", 1_234)
    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE bucket_type = 'goal' AND event_type IN ('deposit', 'allocation', 'review')"
    ).fetchone()[0] == 0


def test_allocation_without_targets_stays_unallocated(ledger: sqlite3.Connection) -> None:
    _add_savings_account(ledger, 0)
    initialize_goal_ledger(ledger, "2026-10", 0)

    preview = allocation_preview(ledger, "regular", "2026-10", 12_345)

    assert preview.rows == ()
    assert preview.unallocated_minor == 12_345


def test_allocation_rounding_and_locked_rebalance_are_exact(ledger: sqlite3.Connection) -> None:
    rows = (
        AllocationPlanRow("a", 1, True, 1),
        AllocationPlanRow("b", 1, True, 2),
        AllocationPlanRow("c", 1, True, 3),
    )

    result = rebalance_allocation(rows, "a", 5_000)

    assert sum(row.monthly_target_minor for row in result) == 3
    assert result[0].locked is False
    assert result[1].locked is True
    assert result[2].locked is False
    assert [row.monthly_target_minor for row in result] == [2, 1, 0]

    # Lock All is stable until a slider is actually edited.
    assert rows == tuple(rows)


def test_spending_draw_caps_at_goal_balance_and_exact_withdrawal_settles(
    ledger: sqlite3.Connection,
) -> None:
    savings_account = _add_savings_account(ledger, 80_000)
    checking_account = _add_savings_account(ledger, 0)
    ledger.execute(
        "UPDATE accounts SET include_savings = 0, subtype = 'checking', savings_pool = NULL WHERE id = ?",
        (checking_account,),
    )
    initialize_goal_ledger(ledger, "2026-10", 80_000)
    shopping_id = ledger.execute("SELECT id FROM categories WHERE name = 'Shopping'").fetchone()[0]
    emergency = ledger.execute("SELECT * FROM savings_goals WHERE name = 'Emergency'").fetchone()
    update_savings_goal(
        ledger, emergency["id"], emergency["updated_at"], name="Shopping reserve",
        owner="Shared", icon_key="shopping_bag", color_key="pink", parent_id=None,
        linked_category_id=shopping_id,
    )
    set_recurring_target(ledger, shopping_id, 50_000, "2026-10")
    _add_transaction(ledger, checking_account, -150_000, "2026-10-20", shopping_id)

    reconcile_savings_draws(ledger, "2026-10")
    reconcile_savings_draws(ledger, "2026-10")

    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE goal_id = ?",
        (emergency["id"],),
    ).fetchone()[0] == 0
    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE bucket_type = 'pending_transfer'"
    ).fetchone()[0] == 80_000

    withdrawal_id = _add_transaction(ledger, savings_account, -80_000, "2026-10-24")
    reconcile_savings_transactions(ledger, [withdrawal_id])
    reconcile_savings_transactions(ledger, [withdrawal_id])
    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE bucket_type = 'pending_transfer'"
    ).fetchone()[0] == 0


def test_withdrawal_before_draw_does_not_settle_and_shrunk_draw_unsets_withdrawal(
    ledger: sqlite3.Connection,
) -> None:
    savings_account = _add_savings_account(ledger, 80_000)
    checking_account = _add_savings_account(ledger, 0)
    ledger.execute(
        "UPDATE accounts SET include_savings = 0, subtype = 'checking', savings_pool = NULL WHERE id = ?",
        (checking_account,),
    )
    initialize_goal_ledger(ledger, "2026-10", 80_000)
    shopping_id = ledger.execute("SELECT id FROM categories WHERE name = 'Shopping'").fetchone()[0]
    goal = ledger.execute("SELECT * FROM savings_goals WHERE name = 'Emergency'").fetchone()
    update_savings_goal(
        ledger, goal["id"], goal["updated_at"], name="Shopping reserve", owner="Shared",
        icon_key="shopping_bag", color_key="pink", parent_id=None,
        linked_category_id=shopping_id,
    )
    set_recurring_target(ledger, shopping_id, 50_000, "2026-10")
    purchase_id = _add_transaction(ledger, checking_account, -130_000, "2026-10-20", shopping_id)
    reconcile_savings_draws(ledger, "2026-10")

    early = _add_transaction(ledger, savings_account, -80_000, "2026-10-19")
    reconcile_savings_transactions(ledger, [early])
    assert ledger.execute(
        "SELECT COUNT(*) FROM savings_ledger_entries WHERE source_transaction_id = ?",
        (early,),
    ).fetchone()[0] == 0

    later = _add_transaction(ledger, savings_account, -80_000, "2026-10-24")
    reconcile_savings_transactions(ledger, [later])
    ledger.execute(
        "UPDATE transactions SET amount_minor = ? WHERE id = ?", (-100_000, purchase_id)
    )
    reconcile_savings_draws(ledger, "2026-10")

    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE bucket_type = 'pending_transfer'"
    ).fetchone()[0] == 50_000
    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE source_transaction_id = ?",
        (later,),
    ).fetchone()[0] == 0
    reconcile_savings_transactions(ledger, [later])
    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE bucket_type = 'pending_transfer'"
    ).fetchone()[0] == 50_000


def test_archiving_linked_goal_restores_draw_and_pending_transfer(
    ledger: sqlite3.Connection,
) -> None:
    savings_account = _add_savings_account(ledger, 10_000)
    checking_account = _add_savings_account(ledger, 0)
    ledger.execute(
        "UPDATE accounts SET include_savings = 0, subtype = 'checking', savings_pool = NULL WHERE id = ?",
        (checking_account,),
    )
    initialize_goal_ledger(ledger, "2026-10", 10_000)
    shopping_id = ledger.execute("SELECT id FROM categories WHERE name = 'Shopping'").fetchone()[0]
    goal = ledger.execute("SELECT * FROM savings_goals WHERE name = 'Emergency'").fetchone()
    update_savings_goal(
        ledger, goal["id"], goal["updated_at"], name="Shopping reserve", owner="Shared",
        icon_key="shopping_bag", color_key="pink", parent_id=None,
        linked_category_id=shopping_id,
    )
    set_recurring_target(ledger, shopping_id, 0, "2026-10")
    _add_transaction(ledger, checking_account, -5_000, "2026-10-20", shopping_id)
    reconcile_savings_draws(ledger, "2026-10")
    goal = ledger.execute("SELECT * FROM savings_goals WHERE id = ?", (goal["id"],)).fetchone()

    archive_savings_goal(ledger, goal["id"], goal["updated_at"])

    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE goal_id = ?",
        (goal["id"],),
    ).fetchone()[0] == 10_000
    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE bucket_type = 'pending_transfer'"
    ).fetchone()[0] == 0


def test_unlinking_goal_restores_prior_spending_draw(
    ledger: sqlite3.Connection,
) -> None:
    checking_account = _add_savings_account(ledger, 0)
    ledger.execute(
        "UPDATE accounts SET include_savings = 0, subtype = 'checking', savings_pool = NULL WHERE id = ?",
        (checking_account,),
    )
    _add_savings_account(ledger, 10_000)
    initialize_goal_ledger(ledger, "2026-10", 10_000)
    shopping_id = ledger.execute("SELECT id FROM categories WHERE name = 'Shopping'").fetchone()[0]
    goal = ledger.execute("SELECT * FROM savings_goals WHERE name = 'Emergency'").fetchone()
    update_savings_goal(
        ledger, goal["id"], goal["updated_at"], name="Shopping reserve", owner="Shared",
        icon_key="shopping_bag", color_key="pink", parent_id=None,
        linked_category_id=shopping_id,
    )
    _add_transaction(ledger, checking_account, -5_000, "2026-10-20", shopping_id)
    reconcile_savings_draws(ledger, "2026-10")
    goal = ledger.execute("SELECT * FROM savings_goals WHERE id = ?", (goal["id"],)).fetchone()

    update_savings_goal(
        ledger, goal["id"], goal["updated_at"], name="Shopping reserve", owner="Shared",
        icon_key="shopping_bag", color_key="pink", parent_id=None,
        linked_category_id=None,
    )

    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE goal_id = ?",
        (goal["id"],),
    ).fetchone()[0] == 10_000
    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE bucket_type = 'pending_transfer'"
    ).fetchone()[0] == 0


def test_month_review_refreshes_when_later_deposit_arrives_without_double_allocation(
    ledger: sqlite3.Connection,
) -> None:
    savings_account = _add_savings_account(ledger, 0)
    checking_account = _add_savings_account(ledger, 0)
    ledger.execute(
        "UPDATE accounts SET include_savings = 0, subtype = 'checking', savings_pool = NULL WHERE id = ?",
        (checking_account,),
    )
    initialize_goal_ledger(ledger, "2026-09", 0)
    shopping_id = ledger.execute("SELECT id FROM categories WHERE name = 'Shopping'").fetchone()[0]
    set_recurring_target(ledger, shopping_id, 300_000, "2026-09")
    _add_transaction(ledger, checking_account, -258_000, "2026-09-20", shopping_id)

    waiting = generate_month_review(ledger, "2026-09")
    assert waiting.status == "waiting"
    assert waiting.suggested_minor == 42_000

    deposit_id = _add_savings_transaction(
        ledger, savings_account, 42_000, local_date="2026-10-02"
    )
    reconcile_savings_transactions(ledger, [deposit_id])
    allocated_before = ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE source_transaction_id = ?",
        (deposit_id,),
    ).fetchone()[0]
    assert ledger.execute(
        "SELECT status FROM savings_month_reviews WHERE month = '2026-09'"
    ).fetchone()[0] == "pending"
    pending = generate_month_review(ledger, "2026-09")
    assert pending.status == "pending"
    assert pending.matched_transaction_id == deposit_id

    accept_month_review(ledger, "2026-09", pending.updated_at)

    assert ledger.execute(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE source_transaction_id = ?",
        (deposit_id,),
    ).fetchone()[0] == allocated_before
    assert tuple(ledger.execute(
        "SELECT status, matched_minor FROM savings_month_reviews WHERE month = '2026-09'"
    ).fetchone()) == ("added", 42_000)
    assert ledger.execute(
        "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'savings_month_review'"
    ).fetchone()[0] >= 2


def test_month_review_rejects_open_month(ledger: sqlite3.Connection) -> None:
    month = date.today().strftime("%Y-%m")
    _add_savings_account(ledger, 0)
    initialize_goal_ledger(ledger, month, 0)

    with pytest.raises(SavingsGoalError, match="closed"):
        generate_month_review(ledger, month)


def test_non_savings_withdrawal_never_changes_goal_balances(ledger: sqlite3.Connection) -> None:
    account_id = _add_savings_account(ledger, 10_000)
    initialize_goal_ledger(ledger, "2026-10", 10_000)
    ledger.execute(
        "UPDATE accounts SET savings_pool = NULL, include_savings = 0 WHERE id = ?", (account_id,)
    )
    withdrawal_id = _add_transaction(ledger, account_id, -5_000, "2026-10-26")
    before = ledger.execute("SELECT COUNT(*) FROM savings_ledger_entries").fetchone()[0]

    reconcile_savings_transactions(ledger, [withdrawal_id])

    assert ledger.execute("SELECT COUNT(*) FROM savings_ledger_entries").fetchone()[0] == before


def test_pre_activation_transactions_never_enter_savings_ledger(
    ledger: sqlite3.Connection,
) -> None:
    account_id = _add_savings_account(ledger, 0)
    initialize_goal_ledger(ledger, "2026-10", 0)
    transaction_id = _add_savings_transaction(
        ledger, account_id, 10_000, local_date="2026-09-30"
    )

    reconcile_savings_transactions(ledger, [transaction_id])

    assert ledger.execute(
        "SELECT COUNT(*) FROM savings_ledger_entries WHERE source_transaction_id = ?",
        (transaction_id,),
    ).fetchone()[0] == 0


def test_month_history_retirement_valuation_and_undo(ledger: sqlite3.Connection) -> None:
    _add_savings_account(ledger, 300_000)
    asset_id = _add_manual_investment(ledger, 100_000)
    asset = ledger.execute("SELECT * FROM manual_assets WHERE id = ?", (asset_id,)).fetchone()
    assign_manual_asset_pool(ledger, asset_id, "retirement", None, asset["updated_at"])
    initialize_goal_ledger(ledger, "2026-10", 300_000)
    asset = ledger.execute("SELECT * FROM manual_assets WHERE id = ?", (asset_id,)).fetchone()

    valuation_id = record_retirement_valuation(
        ledger, asset_id, 112_345, "2026-10-26", asset["updated_at"]
    )
    overview = savings_goal_overview(ledger, "2026-10")
    retirement = next(goal for goal in overview.goals if goal.pool == "retirement")

    assert overview.regular_minor == 300_000
    assert overview.retirement_minor == 112_345
    assert overview.combined_minor == 412_345
    assert retirement.months[-1].valuation_minor == 12_345
    assert savings_goal_detail(ledger, retirement.goal_id, "2026-10").balance_minor == 112_345

    undo_savings_event(ledger, valuation_id, "correct valuation")
    assert savings_goal_detail(ledger, retirement.goal_id, "2026-10").balance_minor == 100_000


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


def _add_savings_transaction(
    connection: sqlite3.Connection,
    account_id: str,
    amount_minor: int,
    *,
    local_date: str = "2026-10-26",
    transfer: bool = True,
) -> str:
    transaction_id = new_id()
    now = "2026-10-26T12:00:00Z"
    connection.execute(
        """
        INSERT INTO transactions
        (id, account_id, local_date, amount_minor, currency, provider_description,
         provider_category_primary, pending, tombstoned, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'USD', 'Savings transfer', ?, 0, 0, ?, ?)
        """,
        (
            transaction_id,
            account_id,
            local_date,
            amount_minor,
            "TRANSFER_IN" if transfer else "INCOME_INTEREST_EARNED",
            now,
            now,
        ),
    )
    return transaction_id


def _add_transaction(
    connection: sqlite3.Connection,
    account_id: str,
    amount_minor: int,
    local_date: str,
    category_id: str | None = None,
) -> str:
    transaction_id = new_id()
    now = "2026-10-26T12:00:00Z"
    connection.execute(
        """
        INSERT INTO transactions
        (id, account_id, local_date, amount_minor, currency, provider_description,
         pending, tombstoned, category_id, category_source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'USD', 'Test transaction', 0, 0, ?, ?, ?, ?)
        """,
        (
            transaction_id, account_id, local_date, amount_minor, category_id,
            "manual" if category_id else None, now, now,
        ),
    )
    return transaction_id


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
