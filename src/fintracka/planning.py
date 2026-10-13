from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from fintracka.ids import new_id
from fintracka.reports import ledger_entries, month_bounds


class PlanningError(ValueError):
    def __init__(self, message: str, *, minimum_minor: int | None = None) -> None:
        super().__init__(message)
        self.minimum_minor = minimum_minor


@dataclass(frozen=True)
class PlanningIncome:
    source_id: str
    title: str
    income_type: str
    amount_minor: int
    updated_at: str


@dataclass(frozen=True)
class PlanningTrendPoint:
    month: str
    amount_minor: int


@dataclass(frozen=True)
class PlanningCategory:
    category_id: str
    category: str
    historical_average_minor: int
    target_minor: int
    actual_minor: int
    remaining_minor: int
    status: str
    trend: tuple[PlanningTrendPoint, ...]
    transaction_ids: tuple[str, ...]
    tzedaka_minimum_minor: int


@dataclass(frozen=True)
class PlanningSnapshot:
    month: str
    average_months: int
    spending_owner: str | None
    incomes: tuple[PlanningIncome, ...]
    planned_income_total_minor: int
    salary_total_minor: int
    tzedaka_minimum_minor: int
    target_total_minor: int
    surplus_shortfall_minor: int
    categories: tuple[PlanningCategory, ...]


def create_income_source(
    connection: sqlite3.Connection,
    title: str,
    income_type: str,
    amount_minor: int,
    effective_month: str,
) -> str:
    _validate_income(title, income_type, amount_minor, effective_month)
    source_id = new_id()
    now = _now()
    connection.execute(
        "INSERT INTO planning_income_sources (id, created_at, updated_at) VALUES (?, ?, ?)",
        (source_id, now, now),
    )
    connection.execute(
        """
        INSERT INTO planning_income_versions
        (id, source_id, effective_month, title, income_type, amount_minor, currency, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'USD', 1, ?, ?)
        """,
        (new_id(), source_id, effective_month, title.strip(), income_type, amount_minor, now, now),
    )
    _audit(connection, "planning_income_create", "planning_income", source_id, now)
    return source_id


def set_income_version(
    connection: sqlite3.Connection,
    source_id: str,
    title: str,
    income_type: str,
    amount_minor: int,
    effective_month: str,
    active: bool,
) -> None:
    _validate_income(title, income_type, amount_minor, effective_month)
    _require_source(connection, source_id)
    now = _now()
    connection.execute(
        """
        INSERT INTO planning_income_versions
        (id, source_id, effective_month, title, income_type, amount_minor, currency, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)
        ON CONFLICT(source_id, effective_month) DO UPDATE SET
            title = excluded.title, income_type = excluded.income_type,
            amount_minor = excluded.amount_minor, active = excluded.active,
            updated_at = excluded.updated_at
        """,
        (new_id(), source_id, effective_month, title.strip(), income_type, amount_minor, int(active), now, now),
    )
    connection.execute("UPDATE planning_income_sources SET updated_at = ? WHERE id = ?", (now, source_id))
    _audit(connection, "planning_income_version_set", "planning_income", source_id, now)


def set_income_override(
    connection: sqlite3.Connection,
    source_id: str,
    month: str,
    amount_minor: int | None,
) -> None:
    _validate_month(month)
    _require_source(connection, source_id)
    now = _now()
    if amount_minor is None:
        connection.execute(
            "DELETE FROM planning_income_overrides WHERE source_id = ? AND month = ?",
            (source_id, month),
        )
    else:
        _validate_amount(amount_minor)
        connection.execute(
            """
            INSERT INTO planning_income_overrides (source_id, month, amount_minor, currency, updated_at)
            VALUES (?, ?, ?, 'USD', ?)
            ON CONFLICT(source_id, month) DO UPDATE SET
                amount_minor = excluded.amount_minor, updated_at = excluded.updated_at
            """,
            (source_id, month, amount_minor, now),
        )
    connection.execute("UPDATE planning_income_sources SET updated_at = ? WHERE id = ?", (now, source_id))
    _audit(connection, "planning_income_override_set", "planning_income", source_id, now)


def set_recurring_target(
    connection: sqlite3.Connection,
    category_id: str,
    amount_minor: int,
    effective_month: str,
) -> None:
    _validate_target(connection, category_id, amount_minor, effective_month)
    now = _now()
    connection.execute(
        """
        INSERT INTO planning_target_versions
        (id, category_id, effective_month, amount_minor, currency, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'USD', ?, ?)
        ON CONFLICT(category_id, effective_month) DO UPDATE SET
            amount_minor = excluded.amount_minor, updated_at = excluded.updated_at
        """,
        (new_id(), category_id, effective_month, amount_minor, now, now),
    )
    _audit(connection, "planning_target_set", "budget", category_id, now)


def set_target_override(
    connection: sqlite3.Connection,
    category_id: str,
    month: str,
    amount_minor: int | None,
) -> None:
    _validate_month(month)
    _require_expense_category(connection, category_id)
    now = _now()
    if amount_minor is None:
        connection.execute(
            "DELETE FROM planning_target_overrides WHERE category_id = ? AND month = ?",
            (category_id, month),
        )
    else:
        _validate_target(connection, category_id, amount_minor, month)
        connection.execute(
            """
            INSERT INTO planning_target_overrides (category_id, month, amount_minor, currency, updated_at)
            VALUES (?, ?, ?, 'USD', ?)
            ON CONFLICT(category_id, month) DO UPDATE SET
                amount_minor = excluded.amount_minor, updated_at = excluded.updated_at
            """,
            (category_id, month, amount_minor, now),
        )
    _audit(connection, "planning_target_override_set", "budget", category_id, now)


def planning_snapshot(
    connection: sqlite3.Connection,
    month: str,
    average_months: int,
    spending_owner: str | None = None,
) -> PlanningSnapshot:
    _validate_month(month)
    if not 1 <= average_months <= 12:
        raise PlanningError("average_months must be between 1 and 12")
    if spending_owner not in {None, "David", "Ariela", "Shared"}:
        raise PlanningError("invalid spending owner")
    incomes = _effective_incomes(connection, month)
    salary_total = sum(row.amount_minor for row in incomes if row.income_type == "Salary")
    planned_total = sum(row.amount_minor for row in incomes)
    tzedaka_minimum = (salary_total + 9) // 10
    historical_months = tuple(_shift_month(month, -offset) for offset in range(average_months, 0, -1))
    first_start, _ = month_bounds(historical_months[0])
    _, selected_end = month_bounds(month)
    activity: dict[tuple[str, str], int] = {}
    transaction_ids: dict[str, set[str]] = {}
    for entry in ledger_entries(
        connection, first_start, selected_end, account_flag="include_budget"
    ):
        if (
            entry.category_id is None
            or entry.category_type != "expense"
            or entry.reporting_behavior == "excluded"
            or (spending_owner is not None and entry.spending_owner != spending_owner)
        ):
            continue
        entry_month = entry.local_date[:7]
        key = (entry.category_id, entry_month)
        activity[key] = activity.get(key, 0) - entry.amount_minor
        if entry_month == month:
            transaction_ids.setdefault(entry.category_id, set()).add(entry.transaction_id)
    targets = _effective_targets(connection, month)
    category_rows = connection.execute(
        """
        SELECT c.id, c.name
        FROM categories c LEFT JOIN category_groups g ON g.id = c.group_id
        WHERE c.archived = 0 AND c.category_type = 'expense'
        ORDER BY COALESCE(g.sort_order, 999), c.sort_order, c.name, c.id
        """
    ).fetchall()
    categories: list[PlanningCategory] = []
    for row in category_rows:
        category_id = row["id"]
        trend = tuple(
            PlanningTrendPoint(item_month, activity.get((category_id, item_month), 0))
            for item_month in historical_months
        )
        historical_total = sum(point.amount_minor for point in trend)
        historical_average = _round_average(historical_total, average_months)
        target = targets.get(category_id, 0)
        minimum = tzedaka_minimum if row["name"] == "Tzedaka" else 0
        target = max(target, minimum)
        actual = activity.get((category_id, month), 0)
        remaining = target - actual
        status = "no_target" if target == 0 else ("overspent" if remaining < 0 else "on_track")
        categories.append(
            PlanningCategory(
                category_id,
                row["name"],
                historical_average,
                target,
                actual,
                remaining,
                status,
                trend,
                tuple(sorted(transaction_ids.get(category_id, set()))),
                minimum,
            )
        )
    target_total = sum(row.target_minor for row in categories)
    return PlanningSnapshot(
        month,
        average_months,
        spending_owner,
        incomes,
        planned_total,
        salary_total,
        tzedaka_minimum,
        target_total,
        planned_total - target_total,
        tuple(categories),
    )


def _effective_incomes(connection: sqlite3.Connection, month: str) -> tuple[PlanningIncome, ...]:
    rows = connection.execute(
        """
        WITH ranked AS (
            SELECT v.*, ROW_NUMBER() OVER (
                PARTITION BY v.source_id ORDER BY v.effective_month DESC
            ) position
            FROM planning_income_versions v
            WHERE v.effective_month <= ? AND v.currency = 'USD'
        )
        SELECT r.source_id, r.title, r.income_type,
               COALESCE(o.amount_minor, r.amount_minor) amount_minor,
               CASE WHEN o.updated_at IS NOT NULL AND o.updated_at > r.updated_at
                    THEN o.updated_at ELSE r.updated_at END updated_at
        FROM ranked r
        LEFT JOIN planning_income_overrides o
          ON o.source_id = r.source_id AND o.month = ? AND o.currency = 'USD'
        WHERE r.position = 1 AND r.active = 1
        ORDER BY r.title, r.source_id
        """,
        (month, month),
    ).fetchall()
    return tuple(PlanningIncome(**dict(row)) for row in rows)


def _effective_targets(connection: sqlite3.Connection, month: str) -> dict[str, int]:
    rows = connection.execute(
        """
        WITH ranked AS (
            SELECT v.*, ROW_NUMBER() OVER (
                PARTITION BY v.category_id ORDER BY v.effective_month DESC
            ) position
            FROM planning_target_versions v
            WHERE v.effective_month <= ? AND v.currency = 'USD'
        )
        SELECT c.id category_id, COALESCE(o.amount_minor, r.amount_minor, 0) amount_minor
        FROM categories c
        LEFT JOIN ranked r ON r.category_id = c.id AND r.position = 1
        LEFT JOIN planning_target_overrides o
          ON o.category_id = c.id AND o.month = ? AND o.currency = 'USD'
        WHERE c.archived = 0 AND c.category_type = 'expense'
        """,
        (month, month),
    ).fetchall()
    return {row["category_id"]: row["amount_minor"] for row in rows}


def _validate_target(
    connection: sqlite3.Connection,
    category_id: str,
    amount_minor: int,
    month: str,
) -> None:
    _validate_month(month)
    _validate_amount(amount_minor)
    name = _require_expense_category(connection, category_id)
    if name == "Tzedaka":
        minimum = (sum(
            row.amount_minor
            for row in _effective_incomes(connection, month)
            if row.income_type == "Salary"
        ) + 9) // 10
        if amount_minor < minimum:
            raise PlanningError(
                "Tzedaka target is below the Salary minimum",
                minimum_minor=minimum,
            )


def _require_expense_category(connection: sqlite3.Connection, category_id: str) -> str:
    row = connection.execute(
        "SELECT name FROM categories WHERE id = ? AND archived = 0 AND category_type = 'expense'",
        (category_id,),
    ).fetchone()
    if row is None:
        raise PlanningError("active expense category not found")
    return row["name"]


def _require_source(connection: sqlite3.Connection, source_id: str) -> None:
    if connection.execute(
        "SELECT 1 FROM planning_income_sources WHERE id = ?", (source_id,)
    ).fetchone() is None:
        raise PlanningError("planned income source not found")


def _validate_income(title: str, income_type: str, amount_minor: int, month: str) -> None:
    _validate_month(month)
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120:
        raise PlanningError("income title is required")
    if income_type not in {"Salary", "Custom"}:
        raise PlanningError("invalid income type")
    _validate_amount(amount_minor)


def _validate_amount(amount_minor: int) -> None:
    if isinstance(amount_minor, bool) or not isinstance(amount_minor, int) or amount_minor < 0:
        raise PlanningError("amount must be a nonnegative integer")


def _validate_month(month: str) -> None:
    try:
        month_bounds(month)
    except (TypeError, ValueError) as error:
        raise PlanningError("month must use YYYY-MM") from error


def _shift_month(month: str, delta: int) -> str:
    year, number = (int(part) for part in month.split("-"))
    absolute = year * 12 + number - 1 + delta
    return f"{absolute // 12:04d}-{absolute % 12 + 1:02d}"


def _round_average(total: int, count: int) -> int:
    if total >= 0:
        return (total + count // 2) // count
    return -((-total + count // 2) // count)


def _audit(
    connection: sqlite3.Connection,
    action: str,
    entity_type: str,
    entity_id: str,
    now: str,
) -> None:
    connection.execute(
        """
        INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at)
        VALUES (?, 'user', ?, ?, ?, ?)
        """,
        (new_id(), action, entity_type, entity_id, now),
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
