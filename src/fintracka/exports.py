from __future__ import annotations

import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from openpyxl import Workbook, load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill

from fintracka.ids import new_id
from fintracka.reports import spending_by_category

SHEET_ORDER = (
    "Transactions",
    "Accounts",
    "Balances",
    "Balance History",
    "Categories",
    "Auto-categorization Rules",
    "Monthly Budget",
    "Yearly Budget",
    "Spending Trends",
    "_FinTrackaMetadata",
)


class SheetsGateway(Protocol):
    def replace_sheet(self, name: str, rows: list[list[object]], batch_size: int) -> None: ...
    def protect_sheet(self, name: str, warning: str) -> None: ...


def export_excel(connection: sqlite3.Connection, destination: str | Path) -> Path:
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination.parent.chmod(0o700)
    snapshot = _consistent_snapshot(connection)
    workbook = Workbook()
    workbook.remove(workbook.active)
    for name in SHEET_ORDER:
        sheet = workbook.create_sheet(name)
        for row in snapshot[name]:
            sheet.append(row)
        _format_sheet(sheet)
        if name == "_FinTrackaMetadata":
            sheet.sheet_state = "hidden"
    descriptor, temporary_name = tempfile.mkstemp(prefix=".fintracka-export-", suffix=".xlsx", dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        workbook.save(temporary)
        workbook.close()
        validation = load_workbook(temporary, read_only=True, data_only=False)
        try:
            if tuple(validation.sheetnames) != SHEET_ORDER:
                raise ValueError("export validation failed: sheet set changed")
        finally:
            validation.close()
        temporary.chmod(0o600)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    _audit(connection, "excel_export", str(destination))
    return destination


def export_google(
    connection: sqlite3.Connection,
    gateway: SheetsGateway,
    *,
    batch_size: int = 500,
) -> None:
    if batch_size < 1:
        raise ValueError("batch size must be positive")
    snapshot = _consistent_snapshot(connection)
    warning = "Edited locally in FinTracka; this sheet is overwritten on sync."
    for name in SHEET_ORDER:
        gateway.replace_sheet(name, snapshot[name], batch_size)
        gateway.protect_sheet(name, warning)
    _audit(connection, "google_sheets_export", "app_owned_workbook")


def _consistent_snapshot(connection: sqlite3.Connection) -> dict[str, list[list[object]]]:
    try:
        connection.execute("BEGIN")
        snapshot = build_snapshot(connection)
        connection.commit()
        return snapshot
    except Exception:
        connection.rollback()
        raise


def build_snapshot(connection: sqlite3.Connection) -> dict[str, list[list[object]]]:
    database_id = connection.execute("SELECT value FROM app_metadata WHERE key = 'database_instance_id'").fetchone()
    if database_id is None:
        value = new_id()
        connection.execute("INSERT INTO app_metadata (key, value) VALUES ('database_instance_id', ?)", (value,))
        database_id = (value,)
    sheets: dict[str, list[list[object]]] = {}
    sheets["Transactions"] = _rows(
        ["FinTracka ID", "Date", "Account", "Amount (minor units)", "Currency", "Description", "Merchant", "Category", "Notes", "Pending", "Last updated"],
        connection.execute(
            """
            SELECT t.id, t.local_date, a.name, t.amount_minor, t.currency,
                   t.provider_description, COALESCE(t.user_merchant, t.provider_merchant),
                   c.name, t.notes, t.pending, t.updated_at
            FROM transactions t JOIN accounts a ON a.id = t.account_id
            LEFT JOIN categories c ON c.id = t.category_id
            WHERE t.tombstoned = 0 AND a.include_export = 1
            ORDER BY t.local_date, t.id
            """
        ),
    )
    sheets["Accounts"] = _rows(
        ["FinTracka ID", "Name", "Nickname", "Type", "Subtype", "Nature", "Currency", "Status", "Last updated"],
        connection.execute(
            "SELECT id, name, nickname, type, subtype, nature, currency, status, updated_at FROM accounts WHERE include_export = 1 ORDER BY nature, name, id"
        ),
    )
    sheets["Balances"] = _rows(
        ["FinTracka ID", "Account", "Observed at", "Current (minor units)", "Available (minor units)", "Currency", "Source"],
        connection.execute(
            """
            SELECT b.id, a.name, b.observed_at, b.current_minor, b.available_minor, b.currency, b.source
            FROM account_balance_snapshots b JOIN accounts a ON a.id = b.account_id
            WHERE a.include_export = 1 AND b.observed_at = (
                SELECT MAX(latest.observed_at) FROM account_balance_snapshots latest WHERE latest.account_id = a.id
            ) ORDER BY a.name, b.id
            """
        ),
    )
    sheets["Balance History"] = _rows(
        ["FinTracka ID", "Account", "Observed at", "Current (minor units)", "Available (minor units)", "Currency", "Source"],
        connection.execute(
            "SELECT b.id, a.name, b.observed_at, b.current_minor, b.available_minor, b.currency, b.source FROM account_balance_snapshots b JOIN accounts a ON a.id = b.account_id WHERE a.include_export = 1 ORDER BY b.observed_at, a.name, b.id"
        ),
    )
    sheets["Categories"] = _rows(
        ["FinTracka ID", "Group", "Category", "Type", "Reporting behavior", "Archived", "Last updated"],
        connection.execute(
            "SELECT c.id, g.name, c.name, c.category_type, c.reporting_behavior, c.archived, c.updated_at FROM categories c LEFT JOIN category_groups g ON g.id = c.group_id ORDER BY c.sort_order, c.name, c.id"
        ),
    )
    sheets["Auto-categorization Rules"] = _rows(
        ["FinTracka ID", "Priority", "Name", "Enabled", "Conditions", "Category", "Last updated"],
        connection.execute(
            "SELECT r.id, r.priority, r.name, r.enabled, r.conditions_json, c.name, r.updated_at FROM categorization_rules r JOIN categories c ON c.id = r.category_id ORDER BY r.priority, r.id"
        ),
    )
    sheets["Monthly Budget"] = _rows(
        ["FinTracka ID", "Month", "Category", "Target (minor units)", "Currency", "Last updated"],
        connection.execute(
            "SELECT t.category_id || ':' || t.month, t.month, c.name, t.amount_minor, t.currency, c.updated_at FROM tracking_budget_targets t JOIN categories c ON c.id = t.category_id ORDER BY t.month, c.sort_order, c.name"
        ),
    )
    sheets["Yearly Budget"] = _rows(
        ["FinTracka ID", "Year", "Category", "Target (minor units)", "Currency", "Last updated"],
        connection.execute(
            "SELECT t.category_id || ':' || substr(t.month, 1, 4), substr(t.month, 1, 4), c.name, SUM(t.amount_minor), t.currency, MAX(c.updated_at) FROM tracking_budget_targets t JOIN categories c ON c.id = t.category_id GROUP BY t.category_id, substr(t.month, 1, 4), c.name, t.currency ORDER BY substr(t.month, 1, 4), c.sort_order, c.name"
        ),
    )
    trends: list[list[object]] = [["FinTracka ID", "Month", "Category", "Spending (minor units)", "Last updated"]]
    months = [row[0] for row in connection.execute("SELECT DISTINCT substr(local_date, 1, 7) FROM transactions WHERE tombstoned = 0 ORDER BY 1")]
    exported_at = _now()
    for month in months:
        for row in spending_by_category(connection, month):
            trends.append([f"{row['category_id']}:{month}", month, row["category"], row["amount_minor"], exported_at])
    sheets["Spending Trends"] = trends
    row_counts = {name: max(len(rows) - 1, 0) for name, rows in sheets.items()}
    sheets["_FinTrackaMetadata"] = [
        ["Key", "Value"],
        ["schema_version", connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]],
        ["database_instance_id", database_id[0]],
        ["exported_at", exported_at],
        *[[f"rows:{name}", count] for name, count in row_counts.items()],
    ]
    return sheets


def _rows(headers: list[str], cursor: sqlite3.Cursor) -> list[list[object]]:
    return [headers, *[[_safe(value) for value in row] for row in cursor]]


def _safe(value: object) -> object:
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def _format_sheet(sheet) -> None:  # type: ignore[no-untyped-def]
    sheet.sheet_view.showGridLines = False
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    header_fill = PatternFill("solid", fgColor="142638")
    for cell in sheet[1]:
        cell.fill = header_fill
        cell.font = Font(name="Avenir Next", size=10, bold=True, color="FFFFFF")
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for column in sheet.columns:
        values = [len(str(cell.value)) if cell.value is not None else 0 for cell in column]
        sheet.column_dimensions[column[0].column_letter].width = min(max(max(values, default=8) + 2, 10), 42)
        for cell in column[1:]:
            cell.font = Font(name="Avenir Next", size=10, color="142638")
            cell.alignment = Alignment(vertical="center")
    sheet["A1"].comment = Comment(
        "Edited locally in FinTracka; this sheet is overwritten on sync.", "FinTracka"
    )
    sheet.protection.sheet = True


def _audit(connection: sqlite3.Connection, action: str, entity_id: str) -> None:
    connection.execute(
        "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'system', ?, 'export', ?, ?)",
        (new_id(), action, entity_id, _now()),
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
