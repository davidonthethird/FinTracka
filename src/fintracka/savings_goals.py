from __future__ import annotations

import sqlite3
import json
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import date, datetime, timezone

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
        SELECT COALESCE(SUM(current_value_minor), 0) FROM manual_assets
        WHERE active = 1 AND currency = 'USD' AND kind = 'investment'
          AND (savings_pool IS NULL OR savings_pool = 'retirement')
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
    investment_rows = connection.execute(
        """
        SELECT id, title, owner, current_value_minor FROM manual_assets
        WHERE active = 1 AND currency = 'USD' AND kind = 'investment'
          AND (savings_pool IS NULL OR savings_pool = 'retirement')
        ORDER BY owner, title, id
        """
    ).fetchall()
    for priority, asset in enumerate(investment_rows, start=10):
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
) -> None:
    before = _goal(connection, goal_id)
    _require_current(before, expected_updated_at, "savings goal")
    name = _validate_goal_fields(
        connection, name, before["pool"], owner, icon_key, color_key,
        before["activation_month"], parent_id, linked_category_id, 0,
        current_goal_id=goal_id,
    )
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


def archive_savings_goal(
    connection: sqlite3.Connection, goal_id: str, expected_updated_at: str
) -> None:
    before = _goal(connection, goal_id)
    _require_current(before, expected_updated_at, "savings goal")
    if not before["active"]:
        return
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
    now = _now()
    connection.execute(
        "UPDATE accounts SET savings_pool = ?, updated_at = ? WHERE id = ?",
        (pool, now, account_id),
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
    now = _now()
    connection.execute(
        "UPDATE manual_assets SET savings_pool = ?, savings_goal_id = ?, updated_at = ? WHERE id = ?",
        (pool, goal_id, now, asset_id),
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
    if connection.execute(
        "SELECT 1 FROM savings_ledger_entries WHERE source_key = ? OR instr(source_key, ? || ':') = 1",
        (prefix, prefix),
    ).fetchone():
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
                row.allocated_minor, f"{prefix}:goal:{row.goal_id}", now,
            )
    if preview.unallocated_minor:
        _allocation_entry(
            connection, movement_id, transaction, "unallocated", None,
            preview.unallocated_minor, f"{prefix}:unallocated", now,
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
    goal_id: str,
    pool: str,
    amount_minor: int,
    month: str,
    now: str,
    *,
    manual_asset_id: str | None = None,
) -> None:
    if amount_minor == 0:
        return
    connection.execute(
        """
        INSERT INTO savings_ledger_entries
        (id, movement_id, pool, bucket_type, goal_id, amount_minor, currency,
         event_type, effective_date, month, source_key, manual_asset_id, actor,
         explanation, created_at)
        VALUES (?, ?, ?, 'goal', ?, ?, 'USD', 'opening', ?, ?, ?, ?, 'system',
                'Opening savings allocation', ?)
        """,
        (
            new_id(), new_id(), pool, goal_id, amount_minor, month + "-01", month,
            f"opening:{goal_id}", manual_asset_id, now,
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
