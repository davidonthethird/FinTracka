from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from fintracka.ids import new_id
from fintracka.planning import planning_snapshot, set_target_override
from fintracka.reports import ledger_entries, month_bounds


@dataclass(frozen=True)
class TrackingRow:
    category_id: str
    category: str
    target_minor: int
    actual_minor: int
    variance_minor: int


@dataclass(frozen=True)
class EnvelopeRow:
    category_id: str
    category: str
    allocated_minor: int
    activity_minor: int
    available_minor: int


@dataclass(frozen=True)
class EnvelopeBudget:
    month: str
    starting_pool_minor: int
    available_to_assign_minor: int
    categories: list[EnvelopeRow]


def set_tracking_target(
    connection: sqlite3.Connection,
    category_id: str,
    month: str,
    amount_minor: int,
    currency: str = "USD",
) -> None:
    if currency != "USD":
        raise ValueError("tracking planning supports USD only")
    set_target_override(connection, category_id, month, amount_minor)


def set_envelope_allocation(
    connection: sqlite3.Connection,
    category_id: str,
    month: str,
    amount_minor: int,
    currency: str = "USD",
) -> None:
    month_bounds(month)
    connection.execute(
        "INSERT INTO envelope_allocations (category_id, month, amount_minor, currency) VALUES (?, ?, ?, ?) ON CONFLICT(category_id, month) DO UPDATE SET amount_minor = excluded.amount_minor, currency = excluded.currency",
        (category_id, month, amount_minor, currency),
    )
    _audit(connection, "envelope_allocation_set", category_id)


def set_envelope_month(
    connection: sqlite3.Connection,
    month: str,
    starting_pool_minor: int,
    currency: str = "USD",
) -> None:
    month_bounds(month)
    connection.execute(
        "INSERT INTO envelope_month_settings (month, starting_pool_minor, currency) VALUES (?, ?, ?) ON CONFLICT(month) DO UPDATE SET starting_pool_minor = excluded.starting_pool_minor, currency = excluded.currency",
        (month, starting_pool_minor, currency),
    )
    _audit(connection, "envelope_month_set", month)


def tracking_budget(connection: sqlite3.Connection, month: str) -> list[TrackingRow]:
    snapshot = planning_snapshot(connection, month, 1)
    return [
        TrackingRow(
            row.category_id,
            row.category,
            row.target_minor,
            row.actual_minor,
            row.remaining_minor,
        )
        for row in snapshot.categories
        if row.target_minor > 0
    ]


def tracking_year(connection: sqlite3.Connection, year: int) -> list[TrackingRow]:
    totals: dict[str, tuple[str, int, int]] = {}
    for number in range(1, 13):
        for row in planning_snapshot(connection, f"{year:04d}-{number:02d}", 1).categories:
            if row.target_minor == 0 and row.actual_minor == 0:
                continue
            name, target, actual = totals.get(row.category_id, (row.category, 0, 0))
            totals[row.category_id] = (name, target + row.target_minor, actual + row.actual_minor)
    return [
        TrackingRow(category_id, name, target, actual, target - actual)
        for category_id, (name, target, actual) in sorted(
            totals.items(), key=lambda item: (item[1][0], item[0])
        )
    ]


def envelope_budget(connection: sqlite3.Connection, month: str) -> EnvelopeBudget:
    _, end = month_bounds(month)
    allocation_rows = connection.execute(
        """
        SELECT a.category_id, c.name category,
               SUM(a.amount_minor) cumulative_allocation,
               SUM(CASE WHEN a.month = ? THEN a.amount_minor ELSE 0 END) current_allocation,
               MIN(a.month) first_month
        FROM envelope_allocations a
        JOIN categories c ON c.id = a.category_id
        WHERE a.month <= ? AND a.currency = 'USD'
        GROUP BY a.category_id, c.name
        ORDER BY c.sort_order, c.name
        """,
        (month, month),
    ).fetchall()
    categories: list[EnvelopeRow] = []
    for row in allocation_rows:
        start, _ = month_bounds(row["first_month"])
        cumulative_activity = _expense_activity(connection, start, end).get(row["category_id"], 0)
        current_start, current_end = month_bounds(month)
        current_activity = _expense_activity(connection, current_start, current_end).get(row["category_id"], 0)
        categories.append(
            EnvelopeRow(
                row["category_id"],
                row["category"],
                row["current_allocation"],
                current_activity,
                row["cumulative_allocation"] - cumulative_activity,
            )
        )
    setting = connection.execute(
        "SELECT starting_pool_minor FROM envelope_month_settings WHERE month = ? AND currency = 'USD'",
        (month,),
    ).fetchone()
    current_allocations = sum(row.allocated_minor for row in categories)
    starting_pool = setting[0] if setting else 0
    available_to_assign = starting_pool - current_allocations
    return EnvelopeBudget(month, starting_pool, available_to_assign, categories)


def _expense_activity(connection: sqlite3.Connection, start: str, end: str) -> dict[str, int]:
    totals: dict[str, int] = {}
    for entry in ledger_entries(connection, start, end, account_flag="include_budget"):
        if entry.category_id and entry.category_type == "expense" and entry.reporting_behavior != "excluded":
            totals[entry.category_id] = totals.get(entry.category_id, 0) - entry.amount_minor
    return totals


def _audit(connection: sqlite3.Connection, action: str, entity_id: str) -> None:
    connection.execute(
        "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'user', ?, 'budget', ?, ?)",
        (new_id(), action, entity_id, datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")),
    )
