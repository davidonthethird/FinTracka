from __future__ import annotations

import calendar
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class CashFlow:
    income_minor: int
    spending_minor: int
    net_minor: int


@dataclass(frozen=True)
class Overview:
    cash_minor: int
    card_liabilities_minor: int
    net_position_minor: int
    income_minor: int
    spending_minor: int
    cash_income_minor: int
    cash_spending_minor: int
    cash_transfer_minor: int
    opening_cash_minor: int | None


@dataclass(frozen=True)
class LedgerEntry:
    transaction_id: str
    local_date: str
    amount_minor: int
    category_id: str | None
    category: str | None
    category_type: str | None
    reporting_behavior: str | None


def cash_flow(
    connection: sqlite3.Connection,
    month: str,
    *,
    account_nature: str | None = None,
) -> CashFlow:
    start, end = month_bounds(month)
    income = 0
    spending = 0
    for entry in ledger_entries(
        connection,
        start,
        end,
        account_flag="include_overview",
        account_nature=account_nature,
    ):
        if entry.category_type == "transfer" or entry.reporting_behavior == "excluded":
            continue
        if entry.category_type == "income" or entry.reporting_behavior == "income" or (
            entry.category_id is None and entry.amount_minor > 0
        ):
            income += entry.amount_minor
        elif entry.category_type == "expense" or entry.amount_minor < 0:
            spending -= entry.amount_minor
    return CashFlow(income, spending, income - spending)


def spending_by_category(connection: sqlite3.Connection, month: str) -> list[dict[str, str | int]]:
    start, end = month_bounds(month)
    totals: dict[tuple[str | None, str], int] = {}
    for entry in ledger_entries(connection, start, end, account_flag="include_overview"):
        if entry.category_type != "expense" or entry.reporting_behavior == "excluded":
            continue
        key = (entry.category_id, entry.category or "Uncategorized")
        totals[key] = totals.get(key, 0) - entry.amount_minor
    return [
        {"category_id": category_id, "category": name, "amount_minor": amount}
        for (category_id, name), amount in sorted(totals.items(), key=lambda item: (-item[1], item[0][1]))
        if amount != 0
    ]


def overview(connection: sqlite3.Connection, month: str) -> Overview:
    balances = connection.execute(
        """
        SELECT a.nature, a.include_overview, a.include_net, b.current_minor
        FROM accounts a
        JOIN account_balance_snapshots b ON b.account_id = a.id
        WHERE (a.include_overview = 1 OR a.include_net = 1)
          AND a.status = 'active' AND a.currency = 'USD'
          AND b.currency = 'USD'
          AND b.observed_at = (
              SELECT MAX(latest.observed_at)
              FROM account_balance_snapshots latest
              WHERE latest.account_id = a.id
          )
        """
    ).fetchall()
    cash = sum(
        row["current_minor"]
        for row in balances
        if row["nature"] == "asset" and row["include_overview"]
    )
    liabilities = sum(
        row["current_minor"]
        for row in balances
        if row["nature"] == "liability" and row["include_overview"]
    )
    net_assets = sum(
        row["current_minor"]
        for row in balances
        if row["nature"] == "asset" and row["include_net"]
    )
    net_liabilities = sum(
        row["current_minor"]
        for row in balances
        if row["nature"] == "liability" and row["include_net"]
    )
    flow = cash_flow(connection, month)
    cash_activity = cash_flow(connection, month, account_nature="asset")
    start, end = month_bounds(month)
    cash_transfer = _cash_transfer_activity(connection, start, end)
    opening_cash = _opening_cash_balance(connection, start)
    return Overview(
        cash,
        liabilities,
        net_assets - net_liabilities,
        flow.income_minor,
        flow.spending_minor,
        cash_activity.income_minor,
        cash_activity.spending_minor,
        cash_transfer,
        opening_cash,
    )


def ledger_entries(
    connection: sqlite3.Connection,
    start: str,
    end: str,
    *,
    account_flag: str,
    account_nature: str | None = None,
) -> list[LedgerEntry]:
    if account_flag not in {"include_overview", "include_budget", "include_export", "include_net"}:
        raise ValueError("invalid account inclusion flag")
    if account_nature not in {None, "asset", "liability"}:
        raise ValueError("invalid account nature")
    nature_clause = " AND a.nature = ?" if account_nature else ""
    parameters: list[str] = [start, end]
    if account_nature:
        parameters.append(account_nature)
    parameters.extend((start, end))
    if account_nature:
        parameters.append(account_nature)
    rows = connection.execute(
        f"""
        WITH report_rows AS (
            SELECT t.id transaction_id, t.local_date, t.amount_minor, t.category_id
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            WHERE t.has_splits = 0 AND t.tombstoned = 0 AND t.pending = 0
              AND t.currency = 'USD' AND a.currency = 'USD' AND a.{account_flag} = 1
              AND t.local_date BETWEEN ? AND ?
              {nature_clause}
              AND NOT EXISTS (
                  SELECT 1 FROM transfer_links l
                  WHERE l.status = 'confirmed'
                    AND (l.transaction_a_id = t.id OR l.transaction_b_id = t.id)
              )
            UNION ALL
            SELECT t.id, t.local_date, s.amount_minor, COALESCE(s.category_id, t.category_id)
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            JOIN transaction_splits s ON s.parent_transaction_id = t.id
            WHERE t.has_splits = 1 AND t.tombstoned = 0 AND t.pending = 0
              AND t.currency = 'USD' AND a.currency = 'USD' AND a.{account_flag} = 1
              AND t.local_date BETWEEN ? AND ?
              {nature_clause}
              AND NOT EXISTS (
                  SELECT 1 FROM transfer_links l
                  WHERE l.status = 'confirmed'
                    AND (l.transaction_a_id = t.id OR l.transaction_b_id = t.id)
              )
        )
        SELECT r.transaction_id, r.local_date, r.amount_minor, r.category_id,
               c.name category, c.category_type, c.reporting_behavior
        FROM report_rows r
        LEFT JOIN categories c ON c.id = r.category_id
        ORDER BY r.local_date, r.transaction_id, r.amount_minor
        """,
        parameters,
    ).fetchall()
    return [LedgerEntry(**dict(row)) for row in rows]


def _cash_transfer_activity(connection: sqlite3.Connection, start: str, end: str) -> int:
    return int(
        connection.execute(
            """
            SELECT COALESCE(SUM(t.amount_minor), 0)
            FROM transfer_links l
            JOIN transactions t
              ON t.id = l.transaction_a_id OR t.id = l.transaction_b_id
            JOIN accounts a ON a.id = t.account_id
            WHERE l.status = 'confirmed' AND a.nature = 'asset'
              AND a.include_overview = 1 AND a.status = 'active'
              AND a.currency = 'USD' AND t.currency = 'USD'
              AND t.tombstoned = 0 AND t.pending = 0
              AND t.local_date BETWEEN ? AND ?
            """,
            (start, end),
        ).fetchone()[0]
    )


def _opening_cash_balance(connection: sqlite3.Connection, start: str) -> int | None:
    account_ids = [
        row["id"]
        for row in connection.execute(
            """
            SELECT id FROM accounts
            WHERE nature = 'asset' AND include_overview = 1
              AND status = 'active' AND currency = 'USD'
            ORDER BY id
            """
        )
    ]
    if not account_ids:
        return 0
    local_boundary = datetime.combine(
        date.fromisoformat(start),
        time.min,
        tzinfo=ZoneInfo("America/New_York"),
    )
    utc_boundary = local_boundary.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    total = 0
    for account_id in account_ids:
        row = connection.execute(
            """
            SELECT current_minor, observed_at FROM account_balance_snapshots
            WHERE account_id = ? AND currency = 'USD' AND observed_at <= ?
            ORDER BY observed_at DESC, id DESC LIMIT 1
            """,
            (account_id, utc_boundary),
        ).fetchone()
        if row is None:
            return None
        if row["observed_at"] != utc_boundary:
            return None
        total += row["current_minor"]
    return total


def month_bounds(month: str) -> tuple[str, str]:
    try:
        year, month_number = (int(part) for part in month.split("-"))
        last_day = calendar.monthrange(year, month_number)[1]
    except (ValueError, TypeError) as error:
        raise ValueError("month must be YYYY-MM") from error
    return date(year, month_number, 1).isoformat(), date(year, month_number, last_day).isoformat()
