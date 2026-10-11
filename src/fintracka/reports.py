from __future__ import annotations

import calendar
import sqlite3
from dataclasses import dataclass
from datetime import date


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


@dataclass(frozen=True)
class LedgerEntry:
    transaction_id: str
    local_date: str
    amount_minor: int
    category_id: str | None
    category: str | None
    category_type: str | None
    reporting_behavior: str | None


def cash_flow(connection: sqlite3.Connection, month: str) -> CashFlow:
    start, end = month_bounds(month)
    income = 0
    spending = 0
    for entry in ledger_entries(connection, start, end, account_flag="include_overview"):
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
        SELECT a.nature, b.current_minor
        FROM accounts a
        JOIN account_balance_snapshots b ON b.account_id = a.id
        WHERE a.include_overview = 1 AND a.status = 'active' AND a.currency = 'USD'
          AND b.currency = 'USD'
          AND b.observed_at = (
              SELECT MAX(latest.observed_at)
              FROM account_balance_snapshots latest
              WHERE latest.account_id = a.id
          )
        """
    ).fetchall()
    cash = sum(row["current_minor"] for row in balances if row["nature"] == "asset")
    liabilities = sum(row["current_minor"] for row in balances if row["nature"] == "liability")
    flow = cash_flow(connection, month)
    return Overview(cash, liabilities, cash - liabilities, flow.income_minor, flow.spending_minor)


def ledger_entries(
    connection: sqlite3.Connection,
    start: str,
    end: str,
    *,
    account_flag: str,
) -> list[LedgerEntry]:
    if account_flag not in {"include_overview", "include_budget", "include_export", "include_net"}:
        raise ValueError("invalid account inclusion flag")
    rows = connection.execute(
        f"""
        WITH report_rows AS (
            SELECT t.id transaction_id, t.local_date, t.amount_minor, t.category_id
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            WHERE t.has_splits = 0 AND t.tombstoned = 0 AND t.pending = 0
              AND t.currency = 'USD' AND a.currency = 'USD' AND a.{account_flag} = 1
              AND t.local_date BETWEEN ? AND ?
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
        (start, end, start, end),
    ).fetchall()
    return [LedgerEntry(**dict(row)) for row in rows]


def month_bounds(month: str) -> tuple[str, str]:
    try:
        year, month_number = (int(part) for part in month.split("-"))
        last_day = calendar.monthrange(year, month_number)[1]
    except (ValueError, TypeError) as error:
        raise ValueError("month must be YYYY-MM") from error
    return date(year, month_number, 1).isoformat(), date(year, month_number, last_day).isoformat()

