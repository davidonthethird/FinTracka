from __future__ import annotations

import sqlite3
from datetime import date, datetime, timezone

from fintracka.ids import new_id


class ManualCashError(ValueError):
    pass


def create_manual_cash(
    connection: sqlite3.Connection,
    title: str,
    amount_minor: int,
    category_id: str,
    local_date: str,
    spending_owner: str,
) -> str:
    title, amount_minor, local_date, spending_owner = _validate(
        connection, title, amount_minor, category_id, local_date, spending_owner
    )
    account = connection.execute(
        """
        SELECT a.id FROM accounts a
        JOIN provider_connections pc ON pc.id = a.connection_id
        WHERE pc.provider = 'manual' AND a.provider_account_id = 'fintracka-manual-cash'
        """
    ).fetchone()
    if account is None:
        raise ManualCashError("manual cash account is unavailable")
    transaction_id = new_id()
    now = _now()
    connection.execute(
        """
        INSERT INTO transactions
        (id, account_id, local_date, amount_minor, currency, provider_description,
         pending, tombstoned, category_id, category_source, spending_owner,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, 'USD', ?, 0, 0, ?, 'manual', ?, ?, ?)
        """,
        (
            transaction_id,
            account["id"],
            local_date,
            -amount_minor,
            title,
            category_id,
            spending_owner,
            now,
            now,
        ),
    )
    _audit(connection, "manual_cash_create", transaction_id, now)
    return transaction_id


def update_manual_cash(
    connection: sqlite3.Connection,
    transaction_id: str,
    expected_updated_at: str,
    title: str,
    amount_minor: int,
    category_id: str,
    local_date: str,
    spending_owner: str,
) -> None:
    title, amount_minor, local_date, spending_owner = _validate(
        connection, title, amount_minor, category_id, local_date, spending_owner
    )
    row = _manual_transaction(connection, transaction_id)
    if row["updated_at"] != expected_updated_at:
        raise ManualCashError("transaction changed; refresh and retry")
    if row["tombstoned"]:
        raise ManualCashError("manual cash transaction is deleted")
    now = _now()
    connection.execute(
        """
        UPDATE transactions
        SET local_date = ?, amount_minor = ?, provider_description = ?,
            category_id = ?, category_source = 'manual', spending_owner = ?, updated_at = ?
        WHERE id = ?
        """,
        (local_date, -amount_minor, title, category_id, spending_owner, now, transaction_id),
    )
    _audit(connection, "manual_cash_update", transaction_id, now)


def delete_manual_cash(
    connection: sqlite3.Connection,
    transaction_id: str,
    expected_updated_at: str,
) -> None:
    row = _manual_transaction(connection, transaction_id)
    if row["updated_at"] != expected_updated_at:
        raise ManualCashError("transaction changed; refresh and retry")
    if row["tombstoned"]:
        return
    now = _now()
    connection.execute(
        "UPDATE transactions SET tombstoned = 1, updated_at = ? WHERE id = ?",
        (now, transaction_id),
    )
    _audit(connection, "manual_cash_delete", transaction_id, now)


def _manual_transaction(connection: sqlite3.Connection, transaction_id: str) -> sqlite3.Row:
    row = connection.execute(
        """
        SELECT t.* FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        JOIN provider_connections pc ON pc.id = a.connection_id
        WHERE t.id = ? AND pc.provider = 'manual'
        """,
        (transaction_id,),
    ).fetchone()
    if row is None:
        raise ManualCashError("transaction is not a manual cash entry")
    return row


def _validate(
    connection: sqlite3.Connection,
    title: str,
    amount_minor: int,
    category_id: str,
    local_date: str,
    spending_owner: str,
) -> tuple[str, int, str, str]:
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 300:
        raise ManualCashError("title is required")
    if isinstance(amount_minor, bool) or not isinstance(amount_minor, int) or amount_minor <= 0:
        raise ManualCashError("amount must be a positive integer")
    try:
        date.fromisoformat(local_date)
    except (TypeError, ValueError) as error:
        raise ManualCashError("date must use YYYY-MM-DD") from error
    if spending_owner not in {"David", "Ariela", "Shared"}:
        raise ManualCashError("invalid spending owner")
    if connection.execute(
        "SELECT 1 FROM categories WHERE id = ? AND category_type = 'expense' AND archived = 0",
        (category_id,),
    ).fetchone() is None:
        raise ManualCashError("active expense category not found")
    return title.strip(), amount_minor, local_date, spending_owner


def _audit(connection: sqlite3.Connection, action: str, transaction_id: str, now: str) -> None:
    connection.execute(
        """
        INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at)
        VALUES (?, 'user', ?, 'transaction', ?, ?)
        """,
        (new_id(), action, transaction_id, now),
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
