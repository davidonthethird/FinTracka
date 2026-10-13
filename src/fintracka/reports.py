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
    off_bank_cash_spending_minor: int


@dataclass(frozen=True)
class LedgerEntry:
    transaction_id: str
    local_date: str
    amount_minor: int
    category_id: str | None
    category: str | None
    category_type: str | None
    reporting_behavior: str | None
    spending_owner: str


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


def spending_by_owner(connection: sqlite3.Connection, month: str) -> list[dict[str, str | int]]:
    start, end = month_bounds(month)
    totals = {"David": 0, "Ariela": 0, "Shared": 0}
    for entry in ledger_entries(connection, start, end, account_flag="include_overview"):
        if entry.category_type != "expense" or entry.reporting_behavior == "excluded":
            continue
        totals[entry.spending_owner] -= entry.amount_minor
    return [
        {"owner": owner, "amount_minor": totals[owner]}
        for owner in ("David", "Ariela", "Shared")
        if totals[owner] != 0
    ]


def cash_flow_paths(connection: sqlite3.Connection, month: str) -> dict[str, object]:
    start, end = month_bounds(month)
    ledger = ledger_entries(connection, start, end, account_flag="include_overview")
    transaction_ids = sorted({entry.transaction_id for entry in ledger})
    details: dict[str, sqlite3.Row] = {}
    if transaction_ids:
        details = {
            row["id"]: row
            for row in connection.execute(
                f"""
                SELECT id, provider_description description,
                       COALESCE(NULLIF(user_merchant, ''), NULLIF(provider_merchant, ''), provider_description) merchant,
                       notes
                FROM transactions
                WHERE id IN ({','.join('?' for _ in transaction_ids)})
                """,
                transaction_ids,
            )
        }
    groups = {
        row["id"]: (row["group_id"] or "ungrouped", row["group_name"] or "Other spending")
        for row in connection.execute(
            """
            SELECT c.id, c.group_id, g.name group_name
            FROM categories c LEFT JOIN category_groups g ON g.id = c.group_id
            """
        )
    }
    entries: list[dict[str, object]] = []
    income: dict[tuple[str, str], dict[str, object]] = {}
    expenses: dict[tuple[str, str, str, str], dict[str, object]] = {}
    for index, entry in enumerate(ledger):
        if entry.category_type == "transfer" or entry.reporting_behavior == "excluded":
            continue
        is_income = entry.category_type == "income" or entry.reporting_behavior == "income" or (
            entry.category_id is None and entry.amount_minor > 0
        )
        is_expense = not is_income and (entry.category_type == "expense" or entry.amount_minor < 0)
        if not is_income and not is_expense:
            continue
        detail = details[entry.transaction_id]
        entry_id = f"{entry.transaction_id}:{index}"
        entries.append(
            {
                "id": entry_id,
                "transaction_id": entry.transaction_id,
                "local_date": entry.local_date,
                "merchant": detail["merchant"],
                "description": detail["description"],
                "category": entry.category or "Uncategorized",
                "amount_minor": entry.amount_minor,
                "currency": "USD",
                "notes": detail["notes"],
            }
        )
        category_key = entry.category_id or ("uncategorized-income" if is_income else "uncategorized-expense")
        category_label = entry.category or "Uncategorized"
        if is_income:
            bucket = income.setdefault((category_key, category_label), {"amount": 0, "entry_ids": []})
            bucket["amount"] = int(bucket["amount"]) + entry.amount_minor
        else:
            group_id, group_label = groups.get(entry.category_id or "", ("ungrouped", "Other spending"))
            bucket = expenses.setdefault(
                (group_id, group_label, category_key, category_label),
                {"amount": 0, "entry_ids": []},
            )
            bucket["amount"] = int(bucket["amount"]) - entry.amount_minor
        cast_ids = bucket["entry_ids"]
        assert isinstance(cast_ids, list)
        cast_ids.append(entry_id)

    nodes: list[dict[str, object]] = []
    links: list[dict[str, object]] = []

    def add_node(identifier: str, label: str, kind: str, amount: int, entry_ids: list[str]) -> int:
        nodes.append({"id": identifier, "label": label, "kind": kind, "amount_minor": amount, "entry_ids": entry_ids})
        return len(nodes) - 1

    positive_income = [(*key, value) for key, value in income.items() if int(value["amount"]) > 0]
    positive_expenses = [(*key, value) for key, value in expenses.items() if int(value["amount"]) > 0]
    refund_buckets = [value for value in expenses.values() if int(value["amount"]) < 0]
    income_adjustments = [value for value in income.values() if int(value["amount"]) < 0]
    refund_total = -sum(int(value["amount"]) for value in refund_buckets)
    adjustment_total = -sum(int(value["amount"]) for value in income_adjustments)
    source_total = sum(int(value["amount"]) for *_, value in positive_income) + refund_total
    spending_total = sum(int(value["amount"]) for *_, value in positive_expenses)
    required_total = spending_total + adjustment_total
    funding_total = max(required_total - source_total, 0)
    retained_total = max(source_total - required_total, 0)
    hub_ids = [entry_id for *_, value in positive_income for entry_id in value["entry_ids"]]
    hub_ids.extend(entry_id for value in refund_buckets for entry_id in value["entry_ids"])
    hub = add_node("income", "Income", "hub", source_total + funding_total, hub_ids)

    for category_id, label, value in sorted(positive_income, key=lambda item: (-int(item[2]["amount"]), item[1])):
        amount = int(value["amount"])
        entry_ids = list(value["entry_ids"])
        source = add_node(f"income:{category_id}", label, "income", amount, entry_ids)
        links.append({"source": source, "target": hub, "amount_minor": amount, "entry_ids": entry_ids})
    if refund_total:
        entry_ids = [entry_id for value in refund_buckets for entry_id in value["entry_ids"]]
        source = add_node("refunds", "Refund offsets", "refund", refund_total, entry_ids)
        links.append({"source": source, "target": hub, "amount_minor": refund_total, "entry_ids": entry_ids})
    if funding_total:
        source = add_node("funding-gap", "Prior cash", "funding", funding_total, [])
        links.append({"source": source, "target": hub, "amount_minor": funding_total, "entry_ids": []})

    grouped: dict[tuple[str, str], list[tuple[str, str, dict[str, object]]]] = {}
    for group_id, group_label, category_id, category_label, value in positive_expenses:
        grouped.setdefault((group_id, group_label), []).append((category_id, category_label, value))
    for (group_id, group_label), categories in sorted(grouped.items(), key=lambda item: item[0][1]):
        amount = sum(int(value["amount"]) for _, _, value in categories)
        entry_ids = [entry_id for _, _, value in categories for entry_id in value["entry_ids"]]
        group = add_node(f"group:{group_id}", group_label, "expense_group", amount, entry_ids)
        links.append({"source": hub, "target": group, "amount_minor": amount, "entry_ids": entry_ids})
        for category_id, category_label, value in sorted(categories, key=lambda item: (-int(item[2]["amount"]), item[1])):
            category_amount = int(value["amount"])
            category_ids = list(value["entry_ids"])
            category = add_node(f"expense:{category_id}", category_label, "expense", category_amount, category_ids)
            links.append({"source": group, "target": category, "amount_minor": category_amount, "entry_ids": category_ids})
    if adjustment_total:
        entry_ids = [entry_id for value in income_adjustments for entry_id in value["entry_ids"]]
        target = add_node("income-adjustments", "Income adjustments", "adjustment", adjustment_total, entry_ids)
        links.append({"source": hub, "target": target, "amount_minor": adjustment_total, "entry_ids": entry_ids})
    if retained_total:
        target = add_node("retained", "Money retained", "retained", retained_total, hub_ids)
        links.append({"source": hub, "target": target, "amount_minor": retained_total, "entry_ids": hub_ids})
    return {"month": month, "nodes": nodes, "links": links, "entries": entries}


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
    off_bank_cash_spending = _off_bank_cash_spending(connection, start, end)
    return Overview(
        cash,
        liabilities,
        net_assets - net_liabilities,
        flow.income_minor,
        flow.spending_minor,
        cash_activity.income_minor,
        cash_activity.spending_minor - off_bank_cash_spending,
        cash_transfer,
        opening_cash,
        off_bank_cash_spending,
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
            SELECT t.id transaction_id, t.local_date, t.amount_minor, t.category_id,
                   COALESCE(t.spending_owner, a.spending_owner) spending_owner
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
            SELECT t.id, t.local_date, s.amount_minor, COALESCE(s.category_id, t.category_id),
                   COALESCE(t.spending_owner, a.spending_owner)
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
               c.name category, c.category_type, c.reporting_behavior, r.spending_owner
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
              AND EXISTS (
                  SELECT 1 FROM account_balance_snapshots snapshots
                  WHERE snapshots.account_id = accounts.id
              )
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


def _off_bank_cash_spending(connection: sqlite3.Connection, start: str, end: str) -> int:
    manual_ids = {
        row["id"]
        for row in connection.execute(
            """
            SELECT t.id FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            JOIN provider_connections pc ON pc.id = a.connection_id
            WHERE pc.provider = 'manual'
            """
        )
    }
    return sum(
        -entry.amount_minor
        for entry in ledger_entries(connection, start, end, account_flag="include_overview")
        if entry.transaction_id in manual_ids
        and entry.category_type == "expense"
        and entry.reporting_behavior != "excluded"
    )


def month_bounds(month: str) -> tuple[str, str]:
    try:
        year, month_number = (int(part) for part in month.split("-"))
        last_day = calendar.monthrange(year, month_number)[1]
    except (ValueError, TypeError) as error:
        raise ValueError("month must be YYYY-MM") from error
    return date(year, month_number, 1).isoformat(), date(year, month_number, last_day).isoformat()
