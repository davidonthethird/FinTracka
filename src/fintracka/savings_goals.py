from __future__ import annotations

import sqlite3
import json
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone

from fintracka.ids import new_id


class SavingsGoalError(ValueError):
    pass


class SavingsGoalConflict(SavingsGoalError):
    pass


ICON_KEYS = frozenset({
    "piggy_bank", "shield", "palm_tree", "shopping_bag", "gamepad",
    "house", "gift", "car", "chart", "wallet", "coins",
})
COLOR_KEYS = frozenset({"blue", "green", "orange", "pink", "purple", "teal", "navy"})
POOLS = frozenset({"regular", "retirement"})
OWNERS = frozenset({"David", "Ariela", "Shared"})


@dataclass(frozen=True)
class SavingsInitializationPreview:
    activation_month: str
    regular_balance_minor: int
    emergency_minor: int
    general_minor: int
    retirement_balance_minor: int


@dataclass(frozen=True)
class AllocationPlanRow:
    goal_id: str
    monthly_target_minor: int
    locked: bool
    priority: int


@dataclass(frozen=True)
class AllocationPreviewRow:
    goal_id: str
    target_minor: int
    basis_points: int
    allocated_minor: int


@dataclass(frozen=True)
class AllocationPreview:
    pool: str
    month: str
    contribution_minor: int
    planned_minor: int
    unallocated_minor: int
    rows: tuple[AllocationPreviewRow, ...]


@dataclass(frozen=True)
class SavingsMonthPoint:
    month: str
    opening_minor: int
    additions_minor: int
    spending_draw_minor: int
    withdrawals_minor: int
    earnings_minor: int
    valuation_minor: int
    adjustments_minor: int
    closing_minor: int


@dataclass(frozen=True)
class SavingsGoalView:
    goal_id: str
    name: str
    pool: str
    owner: str
    parent_id: str | None
    linked_category_id: str | None
    icon_key: str
    color_key: str
    priority: int
    locked: bool
    active: bool
    monthly_target_minor: int
    balance_minor: int
    expected_to_date_minor: int
    funded_basis_points: int | None
    ahead_minor: int
    months: tuple[SavingsMonthPoint, ...]
    updated_at: str


@dataclass(frozen=True)
class SavingsGoalOverview:
    activation_month: str
    through_month: str
    plan_updated_at: str
    owner: str | None
    regular_minor: int
    retirement_minor: int
    combined_minor: int
    unallocated_minor: int
    pending_transfer_minor: int
    regular_reconciliation_minor: int
    retirement_reconciliation_minor: int
    goals: tuple[SavingsGoalView, ...]


@dataclass(frozen=True)
class SavingsGoalDetail:
    goal_id: str
    name: str
    pool: str
    owner: str
    balance_minor: int
    monthly_target_minor: int
    months: tuple[SavingsMonthPoint, ...]


@dataclass(frozen=True)
class SavingsMonthReview:
    month: str
    target_spending_minor: int
    actual_spending_minor: int
    cash_surplus_minor: int
    suggested_minor: int
    matched_minor: int
    status: str
    matched_transaction_id: str | None
    created_at: str
    updated_at: str


def initialization_preview(
    connection: sqlite3.Connection, activation_month: str
) -> SavingsInitializationPreview:
    _validate_month(activation_month)
    regular = connection.execute(
        """
        SELECT COALESCE(SUM(COALESCE((
            SELECT b.current_minor FROM account_balance_snapshots b
            WHERE b.account_id = a.id ORDER BY b.observed_at DESC, b.id DESC LIMIT 1
        ), 0)), 0)
        FROM accounts a
        WHERE a.include_savings = 1 AND a.status = 'active' AND a.hidden = 0
          AND a.currency = 'USD' AND a.subtype = 'savings'
          AND (a.savings_pool IS NULL OR a.savings_pool = 'regular')
        """
    ).fetchone()[0]
    retirement = connection.execute(
        """
        SELECT COALESCE((
            SELECT SUM(current_value_minor) FROM manual_assets
            WHERE active = 1 AND currency = 'USD' AND kind = 'investment'
              AND savings_pool = 'retirement'
        ), 0) + COALESCE((
            SELECT SUM(COALESCE((
                SELECT b.current_minor FROM account_balance_snapshots b
                WHERE b.account_id = a.id ORDER BY b.observed_at DESC, b.id DESC LIMIT 1
            ), 0)) FROM accounts a
            WHERE a.savings_pool = 'retirement' AND a.status = 'active'
              AND a.hidden = 0 AND a.currency = 'USD'
        ), 0)
        """
    ).fetchone()[0]
    emergency = min(regular, 2_500_000)
    return SavingsInitializationPreview(
        activation_month, regular, emergency, regular - emergency, retirement
    )


def initialize_goal_ledger(
    connection: sqlite3.Connection,
    activation_month: str,
    expected_regular_balance_minor: int,
) -> None:
    _validate_month(activation_month)
    if connection.execute("SELECT 1 FROM savings_settings WHERE id = 1").fetchone():
        return
    preview = initialization_preview(connection, activation_month)
    if preview.regular_balance_minor != expected_regular_balance_minor:
        raise SavingsGoalConflict("savings balance changed; refresh and retry")
    now = _now()
    connection.execute(
        "INSERT INTO savings_settings VALUES (1, ?, ?, ?)",
        (activation_month, now, now),
    )
    connection.execute(
        """
        UPDATE accounts SET savings_pool = 'regular', updated_at = ?
        WHERE include_savings = 1 AND status = 'active' AND hidden = 0
          AND currency = 'USD' AND subtype = 'savings'
          AND savings_pool IS NULL
        """,
        (now,),
    )
    initial_regular_accounts = connection.execute(
        """
        SELECT id FROM accounts
        WHERE include_savings = 1 AND status = 'active' AND hidden = 0
          AND currency = 'USD' AND subtype = 'savings' AND savings_pool = 'regular'
        """
    ).fetchall()
    emergency_id = _insert_goal(
        connection, "Emergency", "regular", "Shared", "shield", "blue",
        activation_month, 10, now,
    )
    general_id = _insert_goal(
        connection, "General Savings", "regular", "Shared", "piggy_bank", "green",
        activation_month, 20, now,
    )
    _opening_entry(connection, emergency_id, "regular", preview.emergency_minor, activation_month, now)
    _opening_entry(connection, general_id, "regular", preview.general_minor, activation_month, now)
    retirement_accounts = connection.execute(
        """
        SELECT a.id, COALESCE(NULLIF(a.nickname, ''), a.name) title,
               a.spending_owner owner, COALESCE((
                   SELECT b.current_minor FROM account_balance_snapshots b
                   WHERE b.account_id = a.id
                   ORDER BY b.observed_at DESC, b.id DESC LIMIT 1
               ), 0) current_value_minor
        FROM accounts a
        WHERE a.savings_pool = 'retirement' AND a.status = 'active'
          AND a.hidden = 0 AND a.currency = 'USD'
        ORDER BY owner, title, a.id
        """
    ).fetchall()
    for priority, account in enumerate(retirement_accounts, start=10):
        goal_id = _insert_goal(
            connection, account["title"], "retirement", account["owner"], "chart", "purple",
            activation_month, priority, now,
        )
        _opening_entry(
            connection, goal_id, "retirement", account["current_value_minor"],
            activation_month, now, source_key=f"opening:account:{account['id']}",
        )
    investment_rows = connection.execute(
        """
        SELECT id, title, owner, current_value_minor FROM manual_assets
        WHERE active = 1 AND currency = 'USD' AND kind = 'investment'
          AND savings_pool = 'retirement'
        ORDER BY owner, title, id
        """
    ).fetchall()
    for priority, asset in enumerate(investment_rows, start=10 + len(retirement_accounts)):
        goal_id = _insert_goal(
            connection, asset["title"], "retirement", asset["owner"], "chart", "purple",
            activation_month, priority, now,
        )
        connection.execute(
            "UPDATE manual_assets SET savings_pool = 'retirement', savings_goal_id = ?, updated_at = ? WHERE id = ?",
            (goal_id, now, asset["id"]),
        )
        _opening_entry(
            connection, goal_id, "retirement", asset["current_value_minor"], activation_month,
            now, manual_asset_id=asset["id"],
        )
    for account in initial_regular_accounts:
        _audit(
            connection, "savings_account_opening_included", "account", account["id"], now
        )
    _audit(connection, "savings_initialize", "savings_settings", "1", now)


def create_savings_goal(
    connection: sqlite3.Connection,
    *,
    name: str,
    pool: str,
    owner: str,
    icon_key: str,
    color_key: str,
    activation_month: str,
    parent_id: str | None = None,
    linked_category_id: str | None = None,
    priority: int | None = None,
    monthly_target_minor: int = 0,
) -> str:
    name = _validate_goal_fields(
        connection, name, pool, owner, icon_key, color_key, activation_month,
        parent_id, linked_category_id, monthly_target_minor,
    )
    if priority is None:
        priority = connection.execute(
            "SELECT COALESCE(MAX(priority), 0) + 10 FROM savings_goals WHERE pool = ?",
            (pool,),
        ).fetchone()[0]
    if isinstance(priority, bool) or not isinstance(priority, int) or priority < 0:
        raise SavingsGoalError("priority must be a nonnegative integer")
    now = _now()
    goal_id = new_id()
    try:
        connection.execute(
            """
            INSERT INTO savings_goals
            (id, parent_id, name, pool, owner, icon_key, color_key,
             linked_category_id, priority, active, activation_month, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            """,
            (
                goal_id, parent_id, name, pool, owner, icon_key, color_key,
                linked_category_id, priority, activation_month, now, now,
            ),
        )
    except sqlite3.IntegrityError as error:
        if linked_category_id is not None:
            raise SavingsGoalError("Planning category is already linked to a savings goal") from error
        raise SavingsGoalError("invalid savings goal") from error
    connection.execute(
        """
        INSERT INTO savings_goal_target_versions
        (id, goal_id, effective_month, monthly_target_minor, currency, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'USD', ?, ?)
        """,
        (new_id(), goal_id, activation_month, monthly_target_minor, now, now),
    )
    _audit(connection, "savings_goal_create", "savings_goal", goal_id, now)
    return goal_id


def update_savings_goal(
    connection: sqlite3.Connection,
    goal_id: str,
    expected_updated_at: str,
    *,
    name: str,
    owner: str,
    icon_key: str,
    color_key: str,
    parent_id: str | None,
    linked_category_id: str | None,
    monthly_target_minor: int | None = None,
    effective_month: str | None = None,
) -> None:
    before = _goal(connection, goal_id)
    _require_current(before, expected_updated_at, "savings goal")
    name = _validate_goal_fields(
        connection, name, before["pool"], owner, icon_key, color_key,
        before["activation_month"], parent_id, linked_category_id, 0,
        current_goal_id=goal_id,
    )
    if (monthly_target_minor is None) != (effective_month is None):
        raise SavingsGoalError("monthly target and effective month must be supplied together")
    if monthly_target_minor is not None:
        _validate_month(effective_month or "")
        if isinstance(monthly_target_minor, bool) or monthly_target_minor < 0:
            raise SavingsGoalError("monthly target must be a nonnegative integer")
    if before["linked_category_id"] is not None and before["linked_category_id"] != linked_category_id:
        _clear_goal_draws(connection, goal_id)
    now = _now()
    try:
        connection.execute(
            """
            UPDATE savings_goals SET parent_id = ?, name = ?, owner = ?, icon_key = ?,
                color_key = ?, linked_category_id = ?, updated_at = ? WHERE id = ?
            """,
            (parent_id, name, owner, icon_key, color_key, linked_category_id, now, goal_id),
        )
    except sqlite3.IntegrityError as error:
        raise SavingsGoalError("Planning category is already linked to a savings goal") from error
    _audit(
        connection, "savings_goal_update", "savings_goal", goal_id, now,
        dict(before), dict(_goal(connection, goal_id)),
    )
    if monthly_target_minor is not None:
        connection.execute(
            """
            INSERT INTO savings_goal_target_versions
            (id, goal_id, effective_month, monthly_target_minor, currency, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'USD', ?, ?)
            ON CONFLICT(goal_id, effective_month) DO UPDATE SET
                monthly_target_minor = excluded.monthly_target_minor,
                updated_at = excluded.updated_at
            """,
            (new_id(), goal_id, effective_month, monthly_target_minor, now, now),
        )
        connection.execute("UPDATE savings_settings SET updated_at = ? WHERE id = 1", (now,))


def archive_savings_goal(
    connection: sqlite3.Connection, goal_id: str, expected_updated_at: str
) -> None:
    before = _goal(connection, goal_id)
    _require_current(before, expected_updated_at, "savings goal")
    if not before["active"]:
        return
    if before["linked_category_id"] is not None:
        _clear_goal_draws(connection, goal_id)
    now = _now()
    connection.execute(
        "UPDATE savings_goals SET active = 0, linked_category_id = NULL, updated_at = ? WHERE id = ?",
        (now, goal_id),
    )
    _audit(
        connection, "savings_goal_archive", "savings_goal", goal_id, now,
        dict(before), dict(_goal(connection, goal_id)),
    )


def delete_unused_savings_goal(
    connection: sqlite3.Connection, goal_id: str, expected_updated_at: str
) -> None:
    before = _goal(connection, goal_id)
    _require_current(before, expected_updated_at, "savings goal")
    used = connection.execute(
        "SELECT EXISTS(SELECT 1 FROM savings_ledger_entries WHERE goal_id = ?) OR EXISTS(SELECT 1 FROM savings_goals WHERE parent_id = ?)",
        (goal_id, goal_id),
    ).fetchone()[0]
    if used:
        raise SavingsGoalError("savings goal has history; archive it instead")
    now = _now()
    connection.execute("DELETE FROM savings_goal_target_versions WHERE goal_id = ?", (goal_id,))
    connection.execute("DELETE FROM savings_goals WHERE id = ?", (goal_id,))
    _audit(connection, "savings_goal_delete", "savings_goal", goal_id, now, dict(before), None)


def reorder_savings_goals(
    connection: sqlite3.Connection,
    pool: str,
    ordered_goal_ids: list[str],
    expected_updated_at: str,
) -> None:
    _validate_pool(pool)
    settings = connection.execute("SELECT * FROM savings_settings WHERE id = 1").fetchone()
    if settings is None:
        raise SavingsGoalError("savings goal ledger is not initialized")
    _require_current(settings, expected_updated_at, "savings plan")
    existing = [
        row[0] for row in connection.execute(
            "SELECT id FROM savings_goals WHERE pool = ? AND active = 1 ORDER BY priority, id",
            (pool,),
        )
    ]
    if len(ordered_goal_ids) != len(set(ordered_goal_ids)) or set(ordered_goal_ids) != set(existing):
        raise SavingsGoalError("ordered goals must contain every active goal in the pool exactly once")
    now = _now()
    for priority, goal_id in enumerate(ordered_goal_ids, start=1):
        connection.execute(
            "UPDATE savings_goals SET priority = ?, updated_at = ? WHERE id = ?",
            (priority, now, goal_id),
        )
    connection.execute("UPDATE savings_settings SET updated_at = ? WHERE id = 1", (now,))
    _audit(connection, "savings_goal_reorder", "savings_settings", "1", now)


def assign_account_pool(
    connection: sqlite3.Connection,
    account_id: str,
    pool: str | None,
    expected_updated_at: str,
) -> None:
    _validate_optional_pool(pool)
    row = connection.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if row is None:
        raise SavingsGoalError("account not found")
    _require_current(row, expected_updated_at, "account")
    changed = row["savings_pool"] != pool
    has_history = connection.execute(
        """
        SELECT 1 FROM savings_ledger_entries WHERE source_key = ?
        UNION ALL
        SELECT 1 FROM audit_events
        WHERE action = 'savings_account_opening_included'
          AND entity_type = 'account' AND entity_id = ?
        LIMIT 1
        """,
        (f"opening:account:{account_id}", account_id),
    ).fetchone()
    if changed and has_history:
        raise SavingsGoalConflict("account has savings history; undo it before reassigning")
    now = _now()
    connection.execute(
        "UPDATE accounts SET savings_pool = ?, updated_at = ? WHERE id = ?",
        (pool, now, account_id),
    )
    settings = connection.execute(
        "SELECT activation_month FROM savings_settings WHERE id = 1"
    ).fetchone()
    balance = connection.execute(
        "SELECT current_minor FROM account_balance_snapshots WHERE account_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1",
        (account_id,),
    ).fetchone()
    if changed and settings and pool is not None and balance and balance[0] > 0:
        goal_id = None
        if pool == "retirement":
            priority = connection.execute(
                "SELECT COALESCE(MAX(priority), 0) + 1 FROM savings_goals WHERE pool = 'retirement'"
            ).fetchone()[0]
            goal_id = _insert_goal(
                connection, (row["nickname"] or row["name"] or "Retirement")[:120],
                pool, row["spending_owner"], "chart", "purple",
                settings["activation_month"], priority, now,
            )
        _opening_entry(
            connection, goal_id, pool, balance[0], settings["activation_month"], now,
            source_key=f"opening:account:{account_id}",
        )
    _audit(connection, "savings_account_pool_set", "account", account_id, now, dict(row), None)


def assign_manual_asset_pool(
    connection: sqlite3.Connection,
    asset_id: str,
    pool: str | None,
    goal_id: str | None,
    expected_updated_at: str,
) -> None:
    _validate_optional_pool(pool)
    row = connection.execute("SELECT * FROM manual_assets WHERE id = ?", (asset_id,)).fetchone()
    if row is None:
        raise SavingsGoalError("manual asset not found")
    _require_current(row, expected_updated_at, "manual asset")
    if goal_id is not None:
        goal = _goal(connection, goal_id)
        if pool is None or goal["pool"] != pool:
            raise SavingsGoalError("asset goal must belong to its savings pool")
    changed = row["savings_pool"] != pool or row["savings_goal_id"] != goal_id
    has_history = connection.execute(
        "SELECT 1 FROM savings_ledger_entries WHERE manual_asset_id = ? LIMIT 1", (asset_id,)
    ).fetchone()
    if changed and has_history:
        raise SavingsGoalConflict("asset has savings history; undo it before reassigning")
    now = _now()
    connection.execute(
        "UPDATE manual_assets SET savings_pool = ?, savings_goal_id = ?, updated_at = ? WHERE id = ?",
        (pool, goal_id, now, asset_id),
    )
    settings = connection.execute(
        "SELECT activation_month FROM savings_settings WHERE id = 1"
    ).fetchone()
    if changed and settings and pool is not None and row["current_value_minor"]:
        _opening_entry(
            connection, goal_id, pool, row["current_value_minor"],
            settings["activation_month"], now, manual_asset_id=asset_id,
        )
    _audit(connection, "savings_asset_pool_set", "manual_asset", asset_id, now, dict(row), None)


def set_allocation_plan(
    connection: sqlite3.Connection,
    pool: str,
    effective_month: str,
    rows: Sequence[AllocationPlanRow],
    expected_updated_at: str,
) -> None:
    _validate_pool(pool)
    _validate_month(effective_month)
    settings = connection.execute("SELECT * FROM savings_settings WHERE id = 1").fetchone()
    if settings is None:
        raise SavingsGoalError("savings goal ledger is not initialized")
    _require_current(settings, expected_updated_at, "savings plan")
    active_leaf_ids = {
        row[0]
        for row in connection.execute(
            """
            SELECT g.id FROM savings_goals g
            WHERE g.pool = ? AND g.active = 1
              AND NOT EXISTS (SELECT 1 FROM savings_goals c WHERE c.parent_id = g.id AND c.active = 1)
            """,
            (pool,),
        )
    }
    row_ids = [row.goal_id for row in rows]
    if len(row_ids) != len(set(row_ids)) or set(row_ids) != active_leaf_ids:
        raise SavingsGoalError("allocation rows must contain every active leaf goal exactly once")
    if len({row.priority for row in rows}) != len(rows):
        raise SavingsGoalError("allocation priorities must be unique")
    for row in rows:
        if (
            isinstance(row.monthly_target_minor, bool)
            or not isinstance(row.monthly_target_minor, int)
            or row.monthly_target_minor < 0
            or isinstance(row.priority, bool)
            or not isinstance(row.priority, int)
            or row.priority < 0
        ):
            raise SavingsGoalError("targets and priorities must be nonnegative integers")
        if not isinstance(row.locked, bool):
            raise SavingsGoalError("locked must be a boolean")
    now = _now()
    for row in rows:
        connection.execute(
            "UPDATE savings_goals SET locked = ?, priority = ?, updated_at = ? WHERE id = ?",
            (int(row.locked), row.priority, now, row.goal_id),
        )
        connection.execute(
            """
            INSERT INTO savings_goal_target_versions
            (id, goal_id, effective_month, monthly_target_minor, currency, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'USD', ?, ?)
            ON CONFLICT(goal_id, effective_month) DO UPDATE SET
                monthly_target_minor = excluded.monthly_target_minor,
                updated_at = excluded.updated_at
            """,
            (new_id(), row.goal_id, effective_month, row.monthly_target_minor, now, now),
        )
    connection.execute("UPDATE savings_settings SET updated_at = ? WHERE id = 1", (now,))
    _audit(connection, "savings_allocation_plan_set", "savings_settings", "1", now)


def allocation_preview(
    connection: sqlite3.Connection, pool: str, month: str, contribution_minor: int
) -> AllocationPreview:
    _validate_pool(pool)
    _validate_month(month)
    if (
        isinstance(contribution_minor, bool)
        or not isinstance(contribution_minor, int)
        or contribution_minor < 0
    ):
        raise SavingsGoalError("contribution must be a nonnegative integer")
    plan = _allocation_rows(connection, pool, month)
    if not plan:
        return AllocationPreview(pool, month, contribution_minor, 0, contribution_minor, ())
    targets = [row.monthly_target_minor for row in plan]
    basis_points = _exact_shares(10_000, targets, [row.priority for row in plan])
    funded = {
        row["goal_id"]: row["amount_minor"]
        for row in connection.execute(
            """
            SELECT goal_id, COALESCE(SUM(amount_minor), 0) amount_minor
            FROM savings_ledger_entries
            WHERE pool = ? AND month = ? AND bucket_type = 'goal'
              AND event_type IN ('deposit', 'allocation', 'review')
              AND NOT EXISTS (
                  SELECT 1 FROM savings_ledger_entries r
                  WHERE r.reverses_entry_id = savings_ledger_entries.id
              )
            GROUP BY goal_id
            """,
            (pool, month),
        )
    }
    allocations = [0] * len(plan)
    remaining = contribution_minor
    for index, row in enumerate(plan):
        shortfall = max(row.monthly_target_minor - funded.get(row.goal_id, 0), 0)
        amount = min(shortfall, remaining)
        allocations[index] += amount
        remaining -= amount
    if remaining:
        extra = _exact_shares(remaining, targets, [row.priority for row in plan])
        allocations = [current + addition for current, addition in zip(allocations, extra, strict=True)]
        remaining = 0
    return AllocationPreview(
        pool,
        month,
        contribution_minor,
        sum(targets),
        remaining,
        tuple(
            AllocationPreviewRow(row.goal_id, row.monthly_target_minor, basis, allocation)
            for row, basis, allocation in zip(plan, basis_points, allocations, strict=True)
        ),
    )


def allocate_contribution(connection: sqlite3.Connection, transaction_id: str) -> None:
    transaction = connection.execute(
        """
        SELECT t.*, a.savings_pool FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        WHERE t.id = ?
        """,
        (transaction_id,),
    ).fetchone()
    if transaction is None:
        raise SavingsGoalError("transaction not found")
    if (
        transaction["savings_pool"] not in POOLS
        or transaction["amount_minor"] <= 0
        or transaction["pending"]
        or transaction["tombstoned"]
    ):
        return
    prefix = f"transaction:{transaction_id}"
    if _active_source_entries(connection, prefix):
        return
    preview = allocation_preview(
        connection,
        transaction["savings_pool"],
        transaction["local_date"][:7],
        transaction["amount_minor"],
    )
    movement_id = new_id()
    now = _now()
    for row in preview.rows:
        if row.allocated_minor:
            _allocation_entry(
                connection, movement_id, transaction, "goal", row.goal_id,
                row.allocated_minor, f"{prefix}:goal:{row.goal_id}:{movement_id}", now,
            )
    if preview.unallocated_minor:
        _allocation_entry(
            connection, movement_id, transaction, "unallocated", None,
            preview.unallocated_minor, f"{prefix}:unallocated:{movement_id}", now,
        )


def record_savings_earnings(connection: sqlite3.Connection, transaction: sqlite3.Row) -> None:
    prefix = f"transaction:{transaction['id']}"
    if _active_source_entries(connection, prefix):
        return
    now = _now()
    movement_id = new_id()
    connection.execute(
        """
        INSERT INTO savings_ledger_entries
        (id, movement_id, pool, bucket_type, amount_minor, currency, event_type,
         effective_date, month, source_key, source_transaction_id, actor,
         explanation, created_at)
        VALUES (?, ?, ?, 'unallocated', ?, 'USD', 'earnings', ?, ?, ?, ?,
                'system', 'Savings account earnings', ?)
        """,
        (
            new_id(), movement_id, transaction["savings_pool"], transaction["amount_minor"],
            transaction["local_date"], transaction["local_date"][:7],
            f"{prefix}:earnings:{movement_id}",
            transaction["id"], now,
        ),
    )


def reverse_source_events(
    connection: sqlite3.Connection, source_key: str, reason: str
) -> None:
    entries = connection.execute(
        """
        SELECT e.* FROM savings_ledger_entries e
        WHERE (e.source_key = ? OR instr(e.source_key, ? || ':') = 1)
          AND e.event_type != 'reversal'
          AND NOT EXISTS (
              SELECT 1 FROM savings_ledger_entries r WHERE r.reverses_entry_id = e.id
          )
        ORDER BY e.created_at, e.id
        """,
        (source_key, source_key),
    ).fetchall()
    now = _now()
    for entry in entries:
        connection.execute(
            """
            INSERT INTO savings_ledger_entries
            (id, movement_id, pool, bucket_type, goal_id, amount_minor, currency,
             event_type, effective_date, month, source_key, source_transaction_id,
             source_review_month, manual_asset_id, reverses_entry_id, actor,
             explanation, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'USD', 'reversal', ?, ?, ?, ?, ?, ?, ?,
                    'system', ?, ?)
            """,
            (
                new_id(), new_id(), entry["pool"], entry["bucket_type"], entry["goal_id"],
                -entry["amount_minor"], entry["effective_date"], entry["month"],
                f"reversal:{entry['id']}", entry["source_transaction_id"],
                entry["source_review_month"], entry["manual_asset_id"], entry["id"],
                reason, now,
            ),
        )


def reconcile_savings_draws(connection: sqlite3.Connection, through_month: str) -> None:
    _validate_month(through_month)
    settings = connection.execute("SELECT activation_month FROM savings_settings WHERE id = 1").fetchone()
    if settings is None:
        return
    from fintracka.planning import planning_snapshot

    month = settings["activation_month"]
    while month <= through_month:
        snapshot = planning_snapshot(connection, month, 12)
        planning_categories = {row.category_id: row for row in snapshot.categories}
        goals = connection.execute(
            """
            SELECT * FROM savings_goals
            WHERE active = 1 AND pool = 'regular' AND linked_category_id IS NOT NULL
            ORDER BY priority, id
            """
        ).fetchall()
        for goal in goals:
            category = planning_categories.get(goal["linked_category_id"])
            if category is None:
                continue
            desired = max(category.actual_minor - category.target_minor, 0)
            current_draw = -connection.execute(
                """
                SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries
                WHERE goal_id = ? AND month = ? AND event_type = 'spending_draw'
                """,
                (goal["id"], month),
            ).fetchone()[0]
            current_balance = connection.execute(
                "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE goal_id = ?",
                (goal["id"],),
            ).fetchone()[0]
            capped = min(desired, max(current_balance + current_draw, 0))
            change = capped - current_draw
            if change:
                _reverse_settlements_for_goal_month(connection, goal["id"], month)
                effective_date = _latest_transaction_date(
                    connection, category.transaction_ids, month
                )
                _append_draw(connection, goal["id"], month, effective_date, change)
        month = _next_month(month)


def reconcile_savings_transactions(
    connection: sqlite3.Connection, transaction_ids: Sequence[str]
) -> None:
    settings = connection.execute(
        "SELECT activation_month FROM savings_settings WHERE id = 1"
    ).fetchone()
    if settings is None:
        return
    for transaction_id in transaction_ids:
        transaction = connection.execute(
            """
            SELECT t.*, a.savings_pool, c.category_type FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            LEFT JOIN categories c ON c.id = t.category_id
            WHERE t.id = ?
            """,
            (transaction_id,),
        ).fetchone()
        if transaction is None:
            continue
        prefix = f"transaction:{transaction_id}"
        active_entries = _active_source_entries(connection, prefix)
        account_opening = connection.execute(
            "SELECT created_at FROM savings_ledger_entries WHERE source_key = ?",
            (f"opening:account:{transaction['account_id']}",),
        ).fetchone()
        if (
            transaction["tombstoned"] or transaction["user_archived"]
            or transaction["pending"] or transaction["savings_pool"] not in POOLS
            or transaction["amount_minor"] == 0
            or transaction["local_date"][:7] < settings["activation_month"]
            or (account_opening and transaction["created_at"] <= account_opening["created_at"])
        ):
            reverse_source_events(connection, prefix, "transaction removed from savings")
            continue
        transfer = transaction["category_type"] == "transfer" or (
            transaction["provider_category_primary"] or ""
        ).startswith("TRANSFER")
        expected_event = "allocation" if transaction["amount_minor"] > 0 and transfer else (
            "earnings" if transaction["amount_minor"] > 0 else None
        )
        if active_entries and _source_entries_match_transaction(
            active_entries, transaction, expected_event
        ):
            continue
        if active_entries:
            reverse_source_events(connection, prefix, "provider transaction changed")
        if transaction["amount_minor"] > 0:
            if transfer:
                allocate_contribution(connection, transaction_id)
            else:
                record_savings_earnings(connection, transaction)
        elif transaction["amount_minor"] < 0:
            _settle_exact_withdrawal(connection, transaction)

    for review in connection.execute(
        "SELECT month FROM savings_month_reviews WHERE status = 'waiting'"
    ).fetchall():
        generate_month_review(connection, review["month"])


def assign_savings_withdrawal(
    connection: sqlite3.Connection,
    transaction_id: str,
    destination: str,
    goal_id: str | None,
    expected_updated_at: str,
) -> None:
    transaction = connection.execute(
        """
        SELECT t.*, a.savings_pool FROM transactions t
        JOIN accounts a ON a.id = t.account_id WHERE t.id = ?
        """,
        (transaction_id,),
    ).fetchone()
    if transaction is None:
        raise SavingsGoalError("transaction not found")
    _require_current(transaction, expected_updated_at, "transaction")
    if transaction["savings_pool"] not in POOLS or transaction["amount_minor"] >= 0:
        raise SavingsGoalError("transaction is not a savings withdrawal")
    if destination not in {"goal", "unallocated", "pending_transfer"}:
        raise SavingsGoalError("invalid savings withdrawal destination")
    if destination == "goal":
        goal = _goal(connection, goal_id or "")
        if goal["pool"] != transaction["savings_pool"]:
            raise SavingsGoalError("withdrawal goal belongs to another savings pool")
    elif goal_id is not None:
        raise SavingsGoalError("system bucket withdrawals cannot include a goal")
    prefix = f"transaction:{transaction_id}"
    if _active_source_entries(connection, prefix):
        raise SavingsGoalConflict("withdrawal is already assigned")
    if destination == "pending_transfer":
        if transaction["savings_pool"] != "regular":
            raise SavingsGoalError("only Regular Savings can settle a pending transfer")
        pending = connection.execute(
            "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE pool = 'regular' AND bucket_type = 'pending_transfer'"
        ).fetchone()[0]
        if pending < -transaction["amount_minor"]:
            raise SavingsGoalError("withdrawal exceeds the pending transfer balance")
    if destination == "goal":
        balance = connection.execute(
            "SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries WHERE goal_id = ?",
            (goal_id,),
        ).fetchone()[0]
        if balance < -transaction["amount_minor"]:
            raise SavingsGoalError("withdrawal exceeds the savings goal balance")
    _withdrawal_entry(
        connection, transaction, destination, goal_id, f"{prefix}:manual:{new_id()}"
    )


def savings_goal_overview(
    connection: sqlite3.Connection, month: str, owner: str | None = None
) -> SavingsGoalOverview:
    _validate_month(month)
    if owner not in {None, *OWNERS}:
        raise SavingsGoalError("invalid savings goal owner")
    settings = connection.execute("SELECT * FROM savings_settings WHERE id = 1").fetchone()
    if settings is None:
        raise SavingsGoalError("savings goal ledger is not initialized")
    goal_rows = connection.execute(
        "SELECT * FROM savings_goals WHERE activation_month <= ? ORDER BY pool, priority, id",
        (month,),
    ).fetchall()
    if owner:
        goal_rows = [row for row in goal_rows if row["owner"] == owner]
    goals = tuple(_goal_view(connection, row, settings["activation_month"], month) for row in goal_rows)
    regular = sum(goal.balance_minor for goal in goals if goal.pool == "regular")
    retirement = sum(goal.balance_minor for goal in goals if goal.pool == "retirement")
    system = {
        (row["pool"], row["bucket_type"]): row["amount_minor"]
        for row in connection.execute(
            """
            SELECT pool, bucket_type, COALESCE(SUM(amount_minor), 0) amount_minor
            FROM savings_ledger_entries
            WHERE month <= ? AND bucket_type != 'goal'
            GROUP BY pool, bucket_type
            """,
            (month,),
        )
    }
    connected_regular = connection.execute(
        """
        SELECT COALESCE(SUM(COALESCE((
            SELECT current_minor FROM account_balance_snapshots b
            WHERE b.account_id = a.id ORDER BY observed_at DESC, b.id DESC LIMIT 1
        ), 0)), 0) FROM accounts a
        WHERE a.savings_pool = 'regular' AND a.status = 'active' AND a.hidden = 0
        """
    ).fetchone()[0]
    manual_regular = connection.execute(
        """
        SELECT COALESCE(SUM(current_value_minor), 0) FROM manual_assets
        WHERE active = 1 AND savings_pool = 'regular'
        """
    ).fetchone()[0]
    actual_retirement = connection.execute(
        """
        SELECT COALESCE((
            SELECT SUM(current_value_minor) FROM manual_assets
            WHERE active = 1 AND savings_pool = 'retirement'
        ), 0) + COALESCE((
            SELECT SUM(COALESCE((
                SELECT b.current_minor FROM account_balance_snapshots b
                WHERE b.account_id = a.id ORDER BY b.observed_at DESC, b.id DESC LIMIT 1
            ), 0)) FROM accounts a
            WHERE a.savings_pool = 'retirement' AND a.status = 'active' AND a.hidden = 0
        ), 0)
        """
    ).fetchone()[0]
    regular_unallocated = system.get(("regular", "unallocated"), 0)
    retirement_unallocated = system.get(("retirement", "unallocated"), 0)
    unallocated = regular_unallocated + retirement_unallocated
    pending = system.get(("regular", "pending_transfer"), 0)
    return SavingsGoalOverview(
        settings["activation_month"], month, settings["updated_at"], owner, regular, retirement,
        regular + retirement, unallocated, pending,
        connected_regular + manual_regular - regular - regular_unallocated - pending,
        actual_retirement - retirement - retirement_unallocated,
        goals,
    )


def savings_goal_detail(
    connection: sqlite3.Connection, goal_id: str, through_month: str
) -> SavingsGoalDetail:
    _validate_month(through_month)
    goal = _goal(connection, goal_id)
    view = _goal_view(connection, goal, goal["activation_month"], through_month)
    return SavingsGoalDetail(
        view.goal_id, view.name, view.pool, view.owner, view.balance_minor,
        view.monthly_target_minor, view.months,
    )


def record_retirement_valuation(
    connection: sqlite3.Connection,
    asset_id: str,
    current_value_minor: int,
    as_of_date: str,
    expected_updated_at: str,
) -> str:
    if isinstance(current_value_minor, bool) or not isinstance(current_value_minor, int) or current_value_minor < 0:
        raise SavingsGoalError("valuation must be a nonnegative integer")
    try:
        date.fromisoformat(as_of_date)
    except (TypeError, ValueError) as error:
        raise SavingsGoalError("date must use YYYY-MM-DD") from error
    asset = connection.execute("SELECT * FROM manual_assets WHERE id = ?", (asset_id,)).fetchone()
    if asset is None:
        raise SavingsGoalError("manual asset not found")
    _require_current(asset, expected_updated_at, "manual asset")
    if asset["savings_pool"] not in POOLS:
        raise SavingsGoalError("asset is not assigned to a savings pool")
    delta = current_value_minor - asset["current_value_minor"]
    now = _now()
    connection.execute(
        "UPDATE manual_assets SET current_value_minor = ?, as_of_date = ?, updated_at = ? WHERE id = ?",
        (current_value_minor, as_of_date, now, asset_id),
    )
    if delta == 0:
        return ""
    event_id = new_id()
    connection.execute(
        """
        INSERT INTO savings_ledger_entries
        (id, movement_id, pool, bucket_type, goal_id, amount_minor, currency,
         event_type, effective_date, month, source_key, manual_asset_id, actor,
         explanation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?,
                'user', ?, ?)
        """,
        (
            event_id, new_id(), asset["savings_pool"],
            "goal" if asset["savings_goal_id"] is not None else "unallocated",
            asset["savings_goal_id"], delta,
            "valuation" if asset["savings_pool"] == "retirement" else "adjustment",
            as_of_date, as_of_date[:7],
            f"valuation:{asset_id}:{as_of_date}:{event_id}", asset_id,
            "Retirement valuation update" if asset["savings_pool"] == "retirement"
            else "Manual savings value update",
            now,
        ),
    )
    return event_id


def undo_savings_event(connection: sqlite3.Connection, event_id: str, reason: str) -> str:
    event = connection.execute(
        "SELECT * FROM savings_ledger_entries WHERE id = ?", (event_id,)
    ).fetchone()
    if event is None:
        raise SavingsGoalError("savings event not found")
    if event["event_type"] == "reversal" or connection.execute(
        "SELECT 1 FROM savings_ledger_entries WHERE reverses_entry_id = ?", (event_id,)
    ).fetchone():
        raise SavingsGoalConflict("savings event is already reversed")
    reversal_id = new_id()
    connection.execute(
        """
        INSERT INTO savings_ledger_entries
        (id, movement_id, pool, bucket_type, goal_id, amount_minor, currency,
         event_type, effective_date, month, source_key, source_transaction_id,
         source_review_month, manual_asset_id, reverses_entry_id, actor,
         explanation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'USD', 'reversal', ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)
        """,
        (
            reversal_id, new_id(), event["pool"], event["bucket_type"], event["goal_id"],
            -event["amount_minor"], event["effective_date"], event["month"],
            f"reversal:{event_id}", event["source_transaction_id"],
            event["source_review_month"], event["manual_asset_id"], event_id,
            reason.strip() or "Undo savings event", _now(),
        ),
    )
    return reversal_id


def generate_month_review(connection: sqlite3.Connection, month: str) -> SavingsMonthReview:
    _validate_month(month)
    settings = connection.execute(
        "SELECT activation_month FROM savings_settings WHERE id = 1"
    ).fetchone()
    if settings is None:
        raise SavingsGoalError("savings goal ledger is not initialized")
    if month < settings["activation_month"]:
        raise SavingsGoalError("review month predates savings activation")
    if month >= date.today().strftime("%Y-%m"):
        raise SavingsGoalError("review month must be closed")
    existing = connection.execute(
        "SELECT * FROM savings_month_reviews WHERE month = ?", (month,)
    ).fetchone()
    if existing and existing["status"] in {"added", "ignored"}:
        return SavingsMonthReview(**dict(existing))
    from fintracka.planning import planning_snapshot

    snapshot = planning_snapshot(connection, month, 12)
    raw_suggested = max(snapshot.target_total_minor - snapshot.actual_total_minor, 0)
    unallocated = connection.execute(
        """
        SELECT COALESCE(SUM(amount_minor), 0) FROM savings_ledger_entries
        WHERE pool = 'regular' AND bucket_type = 'unallocated'
        """
    ).fetchone()[0]
    candidate = _review_deposit_candidate(connection, month, raw_suggested)
    available = max(max(unallocated, 0), candidate["amount_minor"] if candidate else 0)
    suggested = min(raw_suggested, available) if available else raw_suggested
    status = "pending" if suggested > 0 and available > 0 else "waiting"
    candidate_id = candidate["id"] if candidate else None
    if existing and (
        existing["target_spending_minor"], existing["actual_spending_minor"],
        existing["cash_surplus_minor"], existing["suggested_minor"],
        existing["status"], existing["matched_transaction_id"],
    ) == (
        snapshot.target_total_minor, snapshot.actual_total_minor, available,
        suggested, status, candidate_id,
    ):
        return SavingsMonthReview(**dict(existing))
    now = _now()
    if existing:
        connection.execute(
            """
            UPDATE savings_month_reviews
            SET target_spending_minor = ?, actual_spending_minor = ?, cash_surplus_minor = ?,
                suggested_minor = ?, status = ?, matched_transaction_id = ?, updated_at = ?
            WHERE month = ?
            """,
            (
                snapshot.target_total_minor, snapshot.actual_total_minor, available,
                suggested, status, candidate_id, now, month,
            ),
        )
    else:
        connection.execute(
            """
            INSERT INTO savings_month_reviews
            (month, target_spending_minor, actual_spending_minor, cash_surplus_minor,
             suggested_minor, matched_minor, status, matched_transaction_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
            """,
            (
                month, snapshot.target_total_minor, snapshot.actual_total_minor,
                available, suggested, status, candidate_id,
                now, now,
            ),
        )
    after = connection.execute(
        "SELECT * FROM savings_month_reviews WHERE month = ?", (month,)
    ).fetchone()
    _audit(
        connection, "savings_review_generate", "savings_month_review", month, now,
        dict(existing) if existing else None, dict(after),
    )
    return SavingsMonthReview(**dict(after))


def accept_month_review(
    connection: sqlite3.Connection, month: str, expected_updated_at: str
) -> None:
    review = connection.execute("SELECT * FROM savings_month_reviews WHERE month = ?", (month,)).fetchone()
    if review is None:
        raise SavingsGoalError("savings month review not found")
    _require_current(review, expected_updated_at, "savings month review")
    if review["status"] == "added":
        return
    amount = review["suggested_minor"]
    if amount <= 0:
        raise SavingsGoalError("no savings are available to add")
    allocation_month = _next_month(month)
    now = _now()
    source = f"review:{month}"
    matched_allocated = review["matched_transaction_id"] and connection.execute(
        """
        SELECT COALESCE(SUM(e.amount_minor), 0) FROM savings_ledger_entries e
        WHERE e.source_transaction_id = ? AND e.bucket_type = 'goal'
          AND e.event_type != 'reversal'
          AND NOT EXISTS (SELECT 1 FROM savings_ledger_entries r WHERE r.reverses_entry_id = e.id)
        """,
        (review["matched_transaction_id"],),
    ).fetchone()[0] >= amount
    if not matched_allocated:
        preview = allocation_preview(connection, "regular", allocation_month, amount)
        if preview.rows:
            movement = new_id()
            connection.execute(
                """
                INSERT INTO savings_ledger_entries
                (id, movement_id, pool, bucket_type, amount_minor, currency, event_type,
                 effective_date, month, source_key, source_review_month, actor, explanation, created_at)
                VALUES (?, ?, 'regular', 'unallocated', ?, 'USD', 'review', ?, ?, ?, ?,
                        'user', 'Allocate prior month savings', ?)
                """,
                (new_id(), movement, -amount, allocation_month + "-01", allocation_month, source + ":source", month, now),
            )
            for row in preview.rows:
                if row.allocated_minor:
                    connection.execute(
                        """
                        INSERT INTO savings_ledger_entries
                        (id, movement_id, pool, bucket_type, goal_id, amount_minor, currency,
                         event_type, effective_date, month, source_key, source_review_month,
                         actor, explanation, created_at)
                        VALUES (?, ?, 'regular', 'goal', ?, ?, 'USD', 'review', ?, ?, ?, ?,
                                'user', 'Allocate prior month savings', ?)
                        """,
                        (
                            new_id(), movement, row.goal_id, row.allocated_minor,
                            allocation_month + "-01", allocation_month,
                            f"{source}:goal:{row.goal_id}", month, now,
                        ),
                    )
    connection.execute(
        "UPDATE savings_month_reviews SET matched_minor = ?, status = 'added', updated_at = ? WHERE month = ?",
        (amount, now, month),
    )
    after = connection.execute(
        "SELECT * FROM savings_month_reviews WHERE month = ?", (month,)
    ).fetchone()
    _audit(
        connection, "savings_review_accept", "savings_month_review", month, now,
        dict(review), dict(after),
    )


def ignore_month_review(
    connection: sqlite3.Connection, month: str, expected_updated_at: str
) -> None:
    review = connection.execute("SELECT * FROM savings_month_reviews WHERE month = ?", (month,)).fetchone()
    if review is None:
        raise SavingsGoalError("savings month review not found")
    _require_current(review, expected_updated_at, "savings month review")
    if review["status"] == "added":
        raise SavingsGoalConflict("an added review cannot be ignored")
    now = _now()
    connection.execute(
        "UPDATE savings_month_reviews SET status = 'ignored', updated_at = ? WHERE month = ?",
        (now, month),
    )
    after = connection.execute(
        "SELECT * FROM savings_month_reviews WHERE month = ?", (month,)
    ).fetchone()
    _audit(
        connection, "savings_review_ignore", "savings_month_review", month, now,
        dict(review), dict(after),
    )


def rebalance_allocation(
    rows: Sequence[AllocationPlanRow], edited_goal_id: str, desired_basis_points: int
) -> tuple[AllocationPlanRow, ...]:
    if not 0 <= desired_basis_points <= 10_000:
        raise SavingsGoalError("allocation percentage must be between 0 and 10000 basis points")
    if not rows or edited_goal_id not in {row.goal_id for row in rows}:
        raise SavingsGoalError("edited savings goal is not in the allocation plan")
    total = sum(row.monthly_target_minor for row in rows)
    if total <= 0:
        raise SavingsGoalError("a nonzero monthly plan is required for percentage editing")
    result = list(rows)
    edited_index = next(index for index, row in enumerate(result) if row.goal_id == edited_goal_id)
    result[edited_index] = replace(result[edited_index], locked=False)
    if sum(not row.locked for row in result) < 2:
        other_index = max(
            (index for index, row in enumerate(result) if index != edited_index),
            key=lambda index: (result[index].priority, result[index].goal_id),
        )
        result[other_index] = replace(result[other_index], locked=False)
    edited_target = (total * desired_basis_points + 5_000) // 10_000
    fixed = sum(
        row.monthly_target_minor
        for index, row in enumerate(result)
        if row.locked and index != edited_index
    )
    if edited_target + fixed > total:
        raise SavingsGoalError("locked targets leave too little room for that percentage")
    flexible_indices = [
        index for index, row in enumerate(result)
        if not row.locked and index != edited_index
    ]
    remaining = total - fixed - edited_target
    weights = [result[index].monthly_target_minor for index in flexible_indices]
    redistributed = _exact_shares(
        remaining,
        weights if sum(weights) else [1] * len(weights),
        [result[index].priority for index in flexible_indices],
    )
    result[edited_index] = replace(result[edited_index], monthly_target_minor=edited_target)
    for index, target in zip(flexible_indices, redistributed, strict=True):
        result[index] = replace(result[index], monthly_target_minor=target)
    return tuple(result)


def _allocation_rows(
    connection: sqlite3.Connection, pool: str, month: str
) -> tuple[AllocationPlanRow, ...]:
    return tuple(
        AllocationPlanRow(
            row["id"], row["monthly_target_minor"], bool(row["locked"]), row["priority"]
        )
        for row in connection.execute(
            """
            SELECT g.id, g.locked, g.priority,
                   COALESCE((
                       SELECT v.monthly_target_minor
                       FROM savings_goal_target_versions v
                       WHERE v.goal_id = g.id AND v.effective_month <= ?
                       ORDER BY v.effective_month DESC LIMIT 1
                   ), 0) monthly_target_minor
            FROM savings_goals g
            WHERE g.pool = ? AND g.active = 1
              AND NOT EXISTS (
                  SELECT 1 FROM savings_goals c
                  WHERE c.parent_id = g.id AND c.active = 1
              )
            ORDER BY g.priority, g.id
            """,
            (month, pool),
        )
        if row["monthly_target_minor"] > 0
    )


def _goal_view(
    connection: sqlite3.Connection,
    goal: sqlite3.Row,
    activation_month: str,
    through_month: str,
) -> SavingsGoalView:
    entries = connection.execute(
        "SELECT * FROM savings_ledger_entries WHERE goal_id = ? AND month <= ? ORDER BY effective_date, created_at, id",
        (goal["id"], through_month),
    ).fetchall()
    points: list[SavingsMonthPoint] = []
    running = 0
    month = max(activation_month, goal["activation_month"])
    expected = 0
    latest_target = 0
    while month <= through_month:
        target_row = connection.execute(
            """
            SELECT monthly_target_minor FROM savings_goal_target_versions
            WHERE goal_id = ? AND effective_month <= ?
            ORDER BY effective_month DESC LIMIT 1
            """,
            (goal["id"], month),
        ).fetchone()
        latest_target = target_row[0] if target_row else 0
        expected += latest_target
        month_entries = [entry for entry in entries if entry["month"] == month]
        opening = running
        additions = sum(
            entry["amount_minor"] for entry in month_entries
            if entry["event_type"] in {"opening", "deposit", "allocation", "review"}
            and entry["amount_minor"] > 0
        )
        spending = -sum(
            entry["amount_minor"] for entry in month_entries
            if entry["event_type"] == "spending_draw" and entry["amount_minor"] < 0
        )
        withdrawals = -sum(
            entry["amount_minor"] for entry in month_entries
            if entry["event_type"] in {"withdrawal", "settlement"} and entry["amount_minor"] < 0
        )
        earnings = sum(entry["amount_minor"] for entry in month_entries if entry["event_type"] == "earnings")
        valuation = sum(entry["amount_minor"] for entry in month_entries if entry["event_type"] == "valuation")
        accounted = additions - spending - withdrawals + earnings + valuation
        total = sum(entry["amount_minor"] for entry in month_entries)
        adjustments = total - accounted
        running += total
        points.append(
            SavingsMonthPoint(
                month, opening, additions, spending, withdrawals, earnings,
                valuation, adjustments, running,
            )
        )
        month = _next_month(month)
    progress = min(running * 10_000 // expected, 10_000) if expected > 0 else None
    return SavingsGoalView(
        goal["id"], goal["name"], goal["pool"], goal["owner"], goal["parent_id"], goal["linked_category_id"],
        goal["icon_key"], goal["color_key"], goal["priority"], bool(goal["locked"]),
        bool(goal["active"]), latest_target, running, expected, progress,
        max(running - expected, 0), tuple(points), goal["updated_at"],
    )


def _exact_shares(total: int, weights: Sequence[int], priorities: Sequence[int]) -> list[int]:
    weight_total = sum(weights)
    if total == 0:
        return [0] * len(weights)
    if weight_total <= 0 or len(weights) != len(priorities):
        raise SavingsGoalError("allocation weights must have a positive total")
    shares = [total * weight // weight_total for weight in weights]
    remainder = total - sum(shares)
    order = sorted(
        range(len(weights)),
        key=lambda index: (
            -(total * weights[index] % weight_total), priorities[index], index
        ),
    )
    for index in order[:remainder]:
        shares[index] += 1
    return shares


def _allocation_entry(
    connection: sqlite3.Connection,
    movement_id: str,
    transaction: sqlite3.Row,
    bucket_type: str,
    goal_id: str | None,
    amount_minor: int,
    source_key: str,
    now: str,
) -> None:
    connection.execute(
        """
        INSERT INTO savings_ledger_entries
        (id, movement_id, pool, bucket_type, goal_id, amount_minor, currency,
         event_type, effective_date, month, source_key, source_transaction_id,
         actor, explanation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'USD', 'allocation', ?, ?, ?, ?, 'system',
                'Allocated savings contribution', ?)
        """,
        (
            new_id(), movement_id, transaction["savings_pool"], bucket_type, goal_id,
            amount_minor, transaction["local_date"], transaction["local_date"][:7],
            source_key, transaction["id"], now,
        ),
    )


def _active_source_entries(
    connection: sqlite3.Connection, source_prefix: str
) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT e.* FROM savings_ledger_entries e
        WHERE (e.source_key = ? OR instr(e.source_key, ? || ':') = 1)
          AND e.event_type != 'reversal'
          AND NOT EXISTS (
              SELECT 1 FROM savings_ledger_entries r WHERE r.reverses_entry_id = e.id
          )
        ORDER BY e.id
        """,
        (source_prefix, source_prefix),
    ).fetchall()


def _source_entries_match_transaction(
    entries: Sequence[sqlite3.Row], transaction: sqlite3.Row, expected_event: str | None
) -> bool:
    return bool(entries) and all(
        row["pool"] == transaction["savings_pool"]
        and row["effective_date"] == transaction["local_date"]
        and (expected_event is None or row["event_type"] == expected_event)
        for row in entries
    ) and sum(row["amount_minor"] for row in entries) == transaction["amount_minor"]


def _reverse_settlements_for_goal_month(
    connection: sqlite3.Connection, goal_id: str, month: str
) -> None:
    source_keys = {
        row[0]
        for row in connection.execute(
            """
            SELECT s.source_key FROM savings_ledger_entries draw
            JOIN savings_ledger_entries s
              ON s.event_type = 'settlement' AND s.explanation = draw.movement_id
            WHERE draw.goal_id = ? AND draw.month = ? AND draw.event_type = 'spending_draw'
              AND NOT EXISTS (
                  SELECT 1 FROM savings_ledger_entries r WHERE r.reverses_entry_id = s.id
              )
            """,
            (goal_id, month),
        )
    }
    for source_key in source_keys:
        reverse_source_events(connection, source_key, "linked spending draw changed")


def _clear_goal_draws(connection: sqlite3.Connection, goal_id: str) -> None:
    draws = connection.execute(
        """
        SELECT month, -SUM(amount_minor) amount_minor, MAX(effective_date) effective_date
        FROM savings_ledger_entries
        WHERE goal_id = ? AND event_type = 'spending_draw'
        GROUP BY month HAVING SUM(amount_minor) != 0
        """,
        (goal_id,),
    ).fetchall()
    for draw in draws:
        _reverse_settlements_for_goal_month(connection, goal_id, draw["month"])
        _append_draw(
            connection, goal_id, draw["month"], draw["effective_date"], -draw["amount_minor"]
        )


def _review_deposit_candidate(
    connection: sqlite3.Connection, review_month: str, amount_minor: int
) -> sqlite3.Row | None:
    if amount_minor <= 0:
        return None
    deposit_month = _next_month(review_month)
    candidates = connection.execute(
        """
        SELECT DISTINCT t.id, t.amount_minor FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        JOIN savings_ledger_entries e ON e.source_transaction_id = t.id
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE a.savings_pool = 'regular' AND t.amount_minor >= ?
          AND t.local_date BETWEEN ? AND ? AND t.pending = 0
          AND t.tombstoned = 0 AND t.user_archived = 0
          AND (c.category_type = 'transfer' OR t.provider_category_primary LIKE 'TRANSFER%')
          AND e.event_type = 'allocation'
          AND NOT EXISTS (
              SELECT 1 FROM savings_ledger_entries r WHERE r.reverses_entry_id = e.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM savings_month_reviews review
              WHERE review.matched_transaction_id = t.id AND review.month != ?
          )
        ORDER BY t.local_date, t.id
        """,
        (amount_minor, deposit_month + "-01", _month_end(deposit_month), review_month),
    ).fetchall()
    return candidates[0] if len(candidates) == 1 else None


def _append_draw(
    connection: sqlite3.Connection,
    goal_id: str,
    month: str,
    effective_date: str,
    amount_minor: int,
) -> None:
    movement_id = new_id()
    now = _now()
    suffix = new_id()
    for bucket_type, linked_goal_id, amount in (
        ("goal", goal_id, -amount_minor),
        ("pending_transfer", None, amount_minor),
    ):
        connection.execute(
            """
            INSERT INTO savings_ledger_entries
            (id, movement_id, pool, bucket_type, goal_id, amount_minor, currency,
             event_type, effective_date, month, source_key, actor, explanation, created_at)
            VALUES (?, ?, 'regular', ?, ?, ?, 'USD', 'spending_draw', ?, ?, ?,
                    'system', 'Planning category overspend draw', ?)
            """,
            (
                new_id(), movement_id, bucket_type, linked_goal_id, amount,
                effective_date, month, f"draw:{month}:{goal_id}:{bucket_type}:{suffix}", now,
            ),
        )


def _settle_exact_withdrawal(connection: sqlite3.Connection, transaction: sqlite3.Row) -> None:
    prefix = f"transaction:{transaction['id']}"
    if _active_source_entries(connection, prefix):
        return
    amount = -transaction["amount_minor"]
    transaction_date = date.fromisoformat(transaction["local_date"])
    candidates = [
        row
        for row in connection.execute(
            """
            SELECT goal.goal_id, goal.month, MAX(goal.effective_date) effective_date,
                   MAX(pending.movement_id) movement_id,
                   SUM(pending.amount_minor) amount_minor
            FROM savings_ledger_entries goal
            JOIN savings_ledger_entries pending
              ON pending.movement_id = goal.movement_id
             AND pending.bucket_type = 'pending_transfer'
             AND pending.event_type = 'spending_draw'
            WHERE goal.pool = ? AND goal.bucket_type = 'goal'
              AND goal.event_type = 'spending_draw'
              AND NOT EXISTS (
                  SELECT 1 FROM savings_ledger_entries settlement
                  JOIN savings_ledger_entries settled_draw
                    ON settled_draw.movement_id = settlement.explanation
                   AND settled_draw.bucket_type = 'goal'
                   AND settled_draw.event_type = 'spending_draw'
                  WHERE settlement.event_type = 'settlement'
                    AND settled_draw.goal_id = goal.goal_id
                    AND settled_draw.month = goal.month
                    AND NOT EXISTS (
                        SELECT 1 FROM savings_ledger_entries reversal
                        WHERE reversal.reverses_entry_id = settlement.id
                    )
              )
            GROUP BY goal.goal_id, goal.month
            HAVING SUM(pending.amount_minor) = ?
            """,
            (transaction["savings_pool"], amount),
        )
        if 0 <= (transaction_date - date.fromisoformat(row["effective_date"])).days <= 7
    ]
    if len(candidates) != 1:
        return
    pending = candidates[0]
    now = _now()
    movement_id = new_id()
    connection.execute(
        """
        INSERT INTO savings_ledger_entries
        (id, movement_id, pool, bucket_type, amount_minor, currency, event_type,
         effective_date, month, source_key, source_transaction_id, actor,
         explanation, created_at)
        VALUES (?, ?, ?, 'pending_transfer', ?, 'USD', 'settlement', ?, ?, ?, ?,
                'system', ?, ?)
        """,
        (
            new_id(), movement_id, transaction["savings_pool"], -amount,
            transaction["local_date"], transaction["local_date"][:7],
            f"{prefix}:settlement:{movement_id}", transaction["id"], pending["movement_id"], now,
        ),
    )


def _withdrawal_entry(
    connection: sqlite3.Connection,
    transaction: sqlite3.Row,
    bucket_type: str,
    goal_id: str | None,
    source_key: str,
) -> None:
    connection.execute(
        """
        INSERT INTO savings_ledger_entries
        (id, movement_id, pool, bucket_type, goal_id, amount_minor, currency,
         event_type, effective_date, month, source_key, source_transaction_id,
         actor, explanation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'USD', 'withdrawal', ?, ?, ?, ?, 'user',
                'Assigned savings withdrawal', ?)
        """,
        (
            new_id(), new_id(), transaction["savings_pool"], bucket_type, goal_id,
            transaction["amount_minor"], transaction["local_date"],
            transaction["local_date"][:7], source_key, transaction["id"], _now(),
        ),
    )


def _latest_transaction_date(
    connection: sqlite3.Connection, transaction_ids: Sequence[str], month: str
) -> str:
    if transaction_ids:
        row = connection.execute(
            f"SELECT MAX(local_date) FROM transactions WHERE id IN ({','.join('?' for _ in transaction_ids)})",
            tuple(transaction_ids),
        ).fetchone()
        if row and row[0]:
            return row[0]
    next_month = date.fromisoformat(_next_month(month) + "-01")
    return (next_month - timedelta(days=1)).isoformat()


def _next_month(month: str) -> str:
    value = date.fromisoformat(month + "-01")
    if value.month == 12:
        return f"{value.year + 1:04d}-01"
    return f"{value.year:04d}-{value.month + 1:02d}"


def _month_end(month: str) -> str:
    return (date.fromisoformat(_next_month(month) + "-01") - timedelta(days=1)).isoformat()


def _insert_goal(
    connection: sqlite3.Connection,
    name: str,
    pool: str,
    owner: str,
    icon_key: str,
    color_key: str,
    activation_month: str,
    priority: int,
    now: str,
) -> str:
    goal_id = new_id()
    connection.execute(
        """
        INSERT INTO savings_goals
        (id, name, pool, owner, icon_key, color_key, priority, active,
         activation_month, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        """,
        (goal_id, name, pool, owner, icon_key, color_key, priority, activation_month, now, now),
    )
    connection.execute(
        """
        INSERT INTO savings_goal_target_versions
        (id, goal_id, effective_month, monthly_target_minor, currency, created_at, updated_at)
        VALUES (?, ?, ?, 0, 'USD', ?, ?)
        """,
        (new_id(), goal_id, activation_month, now, now),
    )
    _audit(connection, "savings_goal_create", "savings_goal", goal_id, now)
    return goal_id


def _opening_entry(
    connection: sqlite3.Connection,
    goal_id: str | None,
    pool: str,
    amount_minor: int,
    month: str,
    now: str,
    *,
    manual_asset_id: str | None = None,
    source_key: str | None = None,
) -> None:
    if amount_minor == 0:
        return
    bucket_type = "goal" if goal_id is not None else "unallocated"
    source_key = source_key or (
        f"opening:{goal_id}" if goal_id is not None else f"opening:asset:{manual_asset_id}"
    )
    connection.execute(
        """
        INSERT INTO savings_ledger_entries
        (id, movement_id, pool, bucket_type, goal_id, amount_minor, currency,
         event_type, effective_date, month, source_key, manual_asset_id, actor,
         explanation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'USD', 'opening', ?, ?, ?, ?, 'system',
                'Opening savings allocation', ?)
        """,
        (
            new_id(), new_id(), pool, bucket_type, goal_id, amount_minor,
            month + "-01", month, source_key, manual_asset_id, now,
        ),
    )


def _validate_month(month: str) -> None:
    try:
        parsed = date.fromisoformat(month + "-01")
    except (TypeError, ValueError) as error:
        raise SavingsGoalError("month must use YYYY-MM") from error
    if parsed.strftime("%Y-%m") != month:
        raise SavingsGoalError("month must use YYYY-MM")


def _validate_goal_fields(
    connection: sqlite3.Connection,
    name: str,
    pool: str,
    owner: str,
    icon_key: str,
    color_key: str,
    activation_month: str,
    parent_id: str | None,
    linked_category_id: str | None,
    monthly_target_minor: int,
    *,
    current_goal_id: str | None = None,
) -> str:
    name = name.strip() if isinstance(name, str) else ""
    if not 1 <= len(name) <= 120:
        raise SavingsGoalError("goal name must be between 1 and 120 characters")
    _validate_pool(pool)
    if owner not in OWNERS:
        raise SavingsGoalError("invalid savings goal owner")
    if icon_key not in ICON_KEYS:
        raise SavingsGoalError("invalid savings goal icon")
    if color_key not in COLOR_KEYS:
        raise SavingsGoalError("invalid savings goal color")
    _validate_month(activation_month)
    if (
        isinstance(monthly_target_minor, bool)
        or not isinstance(monthly_target_minor, int)
        or monthly_target_minor < 0
    ):
        raise SavingsGoalError("monthly target must be a nonnegative integer")
    if parent_id is not None:
        parent = _goal(connection, parent_id)
        if parent_id == current_goal_id or parent["parent_id"] is not None:
            raise SavingsGoalError("savings goals support only one level of subcategories")
        if parent["pool"] != pool:
            raise SavingsGoalError("parent goal must belong to the same savings pool")
    if linked_category_id is not None:
        category = connection.execute(
            "SELECT category_type FROM categories WHERE id = ?", (linked_category_id,)
        ).fetchone()
        if category is None or category["category_type"] != "expense":
            raise SavingsGoalError("linked Planning category must be an expense category")
        duplicate = connection.execute(
            """
            SELECT 1 FROM savings_goals
            WHERE active = 1 AND linked_category_id = ? AND id != COALESCE(?, '')
            """,
            (linked_category_id, current_goal_id),
        ).fetchone()
        if duplicate:
            raise SavingsGoalError("Planning category is already linked to a savings goal")
    return name


def _validate_pool(pool: str) -> None:
    if pool not in POOLS:
        raise SavingsGoalError("invalid savings pool")


def _validate_optional_pool(pool: str | None) -> None:
    if pool is not None:
        _validate_pool(pool)


def _goal(connection: sqlite3.Connection, goal_id: str) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM savings_goals WHERE id = ?", (goal_id,)).fetchone()
    if row is None:
        raise SavingsGoalError("savings goal not found")
    return row


def _require_current(row: sqlite3.Row, expected_updated_at: str, label: str) -> None:
    if row["updated_at"] != expected_updated_at:
        raise SavingsGoalConflict(f"{label} changed; refresh and retry")


def _audit(
    connection: sqlite3.Connection,
    action: str,
    entity_type: str,
    entity_id: str,
    now: str,
    before: dict[str, object] | None = None,
    after: dict[str, object] | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO audit_events
        (id, actor, action, entity_type, entity_id, occurred_at, before_json, after_json)
        VALUES (?, 'user', ?, ?, ?, ?, ?, ?)
        """,
        (
            new_id(), action, entity_type, entity_id, now,
            json.dumps(before, sort_keys=True) if before is not None else None,
            json.dumps(after, sort_keys=True) if after is not None else None,
        ),
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
