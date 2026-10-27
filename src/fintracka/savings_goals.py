from __future__ import annotations

import sqlite3
import json
from dataclasses import dataclass
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
