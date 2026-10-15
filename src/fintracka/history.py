from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class HistoryCoverage:
    requested_months: int
    usable_months: tuple[str, ...]
    earliest_usable_month: str | None


def usable_history_months(
    connection: sqlite3.Connection,
    selected_month: str,
    requested_months: int,
    spending_owner: str | None = None,
) -> HistoryCoverage:
    del spending_owner  # Coverage is conservative across all included household accounts.
    requested = tuple(
        _shift_month(selected_month, -offset)
        for offset in range(requested_months, 0, -1)
    )
    row = connection.execute(
        """
        SELECT MAX(pc.history_available_from)
        FROM provider_connections pc
        JOIN accounts a ON a.connection_id = pc.id
        WHERE pc.provider = 'plaid' AND pc.status IN ('active', 'repair')
          AND pc.history_available_from IS NOT NULL
          AND a.status = 'active' AND a.include_budget = 1 AND a.hidden = 0
        """
    ).fetchone()
    if row is None or row[0] is None:
        return HistoryCoverage(requested_months, requested, requested[0] if requested else None)
    boundary = date.fromisoformat(row[0])
    first_complete = (
        f"{boundary.year:04d}-{boundary.month:02d}"
        if boundary.day == 1
        else _shift_month(f"{boundary.year:04d}-{boundary.month:02d}", 1)
    )
    usable = tuple(month for month in requested if month >= first_complete)
    return HistoryCoverage(requested_months, usable, usable[0] if usable else None)


def _shift_month(month: str, delta: int) -> str:
    year, number = (int(part) for part in month.split("-"))
    absolute = year * 12 + number - 1 + delta
    return f"{absolute // 12:04d}-{absolute % 12 + 1:02d}"
