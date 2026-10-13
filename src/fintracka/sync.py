from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import asdict
from datetime import datetime, timezone

from fintracka.dates import local_date, utc_instant
from fintracka.ids import new_id
from fintracka.ledger import apply_rules
from fintracka.providers import NormalizedAccount, NormalizedBalance, NormalizedTransaction, SyncBatch


def apply_batch(
    connection: sqlite3.Connection,
    connection_id: str,
    batch: SyncBatch,
    *,
    fail_before_commit: bool = False,
) -> str:
    provider_row = connection.execute(
        "SELECT provider FROM provider_connections WHERE id = ?", (connection_id,)
    ).fetchone()
    if provider_row is None:
        raise ValueError("unknown provider connection")
    provider = provider_row[0]
    run_id = new_id()
    now = _now()
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "INSERT INTO sync_runs (id, status, started_at) VALUES (?, 'running', ?)",
            (run_id, now),
        )
        item_id = new_id()
        connection.execute(
            "INSERT INTO sync_run_items (id, sync_run_id, connection_id, status) VALUES (?, ?, ?, 'running')",
            (item_id, run_id, connection_id),
        )
        for account in batch.accounts:
            _upsert_account(connection, connection_id, account, now)
        for balance in batch.balances:
            _upsert_balance(connection, connection_id, balance)
        for transaction in (*batch.added, *batch.modified):
            _upsert_transaction(connection, provider, connection_id, transaction, now)
        for external_id in batch.removed:
            _remove_transaction(connection, provider, connection_id, external_id, now)
        apply_rules(connection)
        connection.execute(
            """
            INSERT INTO provider_checkpoints (connection_id, cursor, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(connection_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
            """,
            (connection_id, batch.next_checkpoint, now),
        )
        connection.execute(
            "UPDATE provider_connections SET status = 'active', last_success_at = ?, last_error_code = NULL, updated_at = ? WHERE id = ?",
            (now, now, connection_id),
        )
        connection.execute(
            "UPDATE sync_run_items SET status = 'succeeded', added_count = ?, modified_count = ?, removed_count = ? WHERE id = ?",
            (len(batch.added), len(batch.modified), len(batch.removed), item_id),
        )
        connection.execute(
            "UPDATE sync_runs SET status = 'succeeded', finished_at = ? WHERE id = ?",
            (now, run_id),
        )
        if fail_before_commit:
            raise RuntimeError("fault injection before commit")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    return run_id


def _upsert_account(
    connection: sqlite3.Connection,
    connection_id: str,
    account: NormalizedAccount,
    now: str,
) -> None:
    connection.execute(
        """
        INSERT INTO accounts (
            id, connection_id, provider_account_id, name, type, subtype, nature,
            mask, currency, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, provider_account_id) DO UPDATE SET
            name = excluded.name,
            type = excluded.type,
            subtype = excluded.subtype,
            nature = excluded.nature,
            mask = excluded.mask,
            currency = excluded.currency,
            status = 'active',
            updated_at = excluded.updated_at
        """,
        (
            new_id(),
            connection_id,
            account.external_id,
            account.name,
            account.account_type,
            account.subtype,
            account.nature,
            account.mask,
            account.currency,
            now,
            now,
        ),
    )


def _upsert_balance(
    connection: sqlite3.Connection,
    connection_id: str,
    balance: NormalizedBalance,
) -> None:
    account_id = _account_id(connection, connection_id, balance.account_external_id)
    connection.execute(
        """
        INSERT INTO account_balance_snapshots (
            id, account_id, observed_at, current_minor, available_minor, currency, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, observed_at, source) DO UPDATE SET
            current_minor = excluded.current_minor,
            available_minor = excluded.available_minor,
            currency = excluded.currency
        """,
        (
            new_id(),
            account_id,
            utc_instant(balance.observed_at).isoformat().replace("+00:00", "Z"),
            balance.current_minor,
            balance.available_minor,
            balance.currency,
            balance.source,
        ),
    )


def _upsert_transaction(
    connection: sqlite3.Connection,
    provider: str,
    connection_id: str,
    transaction: NormalizedTransaction,
    now: str,
) -> None:
    existing = connection.execute(
        "SELECT transaction_id FROM transaction_external_ids WHERE provider = ? AND connection_id = ? AND external_id = ?",
        (provider, connection_id, transaction.external_id),
    ).fetchone()
    if existing is None and transaction.pending_external_id:
        existing = connection.execute(
            "SELECT transaction_id FROM transaction_external_ids WHERE provider = ? AND connection_id = ? AND external_id = ?",
            (provider, connection_id, transaction.pending_external_id),
        ).fetchone()
    account_id = _account_id(connection, connection_id, transaction.account_external_id)
    instant = utc_instant(transaction.occurred_at).isoformat().replace("+00:00", "Z")
    transaction_id = existing[0] if existing else new_id()
    before = connection.execute(
        "SELECT account_id, local_date, posted_at, amount_minor, currency, provider_description, provider_merchant, pending, tombstoned, provider_category_primary, provider_category_detailed, provider_category_confidence, is_cash_withdrawal FROM transactions WHERE id = ?",
        (transaction_id,),
    ).fetchone()
    withdrawal = int(transaction.is_cash_withdrawal or (before is not None and before["is_cash_withdrawal"]))
    provider_values = (
        account_id,
        local_date(transaction.occurred_at).isoformat(),
        instant,
        transaction.amount_minor,
        transaction.currency,
        transaction.description,
        transaction.merchant,
        int(transaction.pending),
        0,
        transaction.provider_category_primary,
        transaction.provider_category_detailed,
        transaction.provider_category_confidence,
        withdrawal,
    )
    provider_category_id = _provider_category_id(connection, transaction)
    if before is None:
        connection.execute(
            """
            INSERT INTO transactions (
                id, account_id, local_date, posted_at, amount_minor, currency,
                provider_description, provider_merchant, pending, tombstoned,
                provider_category_primary, provider_category_detailed,
                provider_category_confidence, is_cash_withdrawal, category_id, category_source,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                transaction_id,
                *provider_values[:8],
                *provider_values[9:],
                provider_category_id,
                "provider" if provider_category_id else None,
                now,
                now,
            ),
        )
        action = "provider_create"
    elif tuple(before) != provider_values:
        connection.execute(
            """
            UPDATE transactions SET
                account_id = ?, local_date = ?, posted_at = ?, amount_minor = ?,
                currency = ?, provider_description = ?, provider_merchant = ?,
                pending = ?, tombstoned = 0, provider_category_primary = ?,
                provider_category_detailed = ?, provider_category_confidence = ?,
                is_cash_withdrawal = ?,
                category_id = CASE WHEN category_source IN ('manual', 'rule') THEN category_id ELSE ? END,
                category_source = CASE WHEN category_source IN ('manual', 'rule') THEN category_source ELSE ? END,
                updated_at = ?
            WHERE id = ?
            """,
            (
                *provider_values[:8],
                *provider_values[9:],
                provider_category_id,
                "provider" if provider_category_id else None,
                now,
                transaction_id,
            ),
        )
        action = "provider_update"
    else:
        action = None
    state = "pending" if transaction.pending else "posted"
    connection.execute(
        """
        INSERT INTO transaction_external_ids (provider, connection_id, external_id, transaction_id, state)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, connection_id, external_id) DO UPDATE SET
            transaction_id = excluded.transaction_id, state = excluded.state
        """,
        (provider, connection_id, transaction.external_id, transaction_id, state),
    )
    payload_hash = hashlib.sha256(
        json.dumps(asdict(transaction), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    connection.execute(
        "INSERT OR IGNORE INTO transaction_provider_versions (id, transaction_id, observed_at, payload_hash) VALUES (?, ?, ?, ?)",
        (new_id(), transaction_id, now, payload_hash),
    )
    if action:
        _audit(connection, action, "transaction", transaction_id, now)


def _provider_category_id(
    connection: sqlite3.Connection,
    transaction: NormalizedTransaction,
) -> str | None:
    primary = (transaction.provider_category_primary or "").upper()
    detailed = (transaction.provider_category_detailed or "").upper()
    text = f"{primary} {detailed}"
    category_name: str | None = None
    if transaction.is_cash_withdrawal:
        category_name = "Other"
    elif "CREDIT_CARD_PAYMENT" in text:
        category_name = "Credit card payment"
    elif primary.startswith("TRANSFER") or "TRANSFER_" in text:
        category_name = "Transfer"
    elif primary == "INCOME" or primary.startswith("INCOME_"):
        category_name = "Salary" if any(word in detailed for word in ("WAGE", "PAYROLL")) else "Other income"
    elif "TAX" in detailed:
        category_name = "Taxes"
    elif "BANK_FEES" in text or "INTEREST_CHARGED" in text:
        category_name = "Fees & interest"
    elif "GROCER" in detailed:
        category_name = "Groceries"
    elif primary == "FOOD_AND_DRINK" or "RESTAURANT" in detailed or "COFFEE" in detailed:
        category_name = "Dining"
    elif primary == "RENT_AND_UTILITIES":
        category_name = "Housing" if any(word in detailed for word in ("RENT", "MORTGAGE")) else "Utilities"
    elif primary in {"TRANSPORTATION", "TRANSPORT"}:
        category_name = "Transport"
    elif primary in {"MEDICAL", "HEALTHCARE"}:
        category_name = "Healthcare"
    elif "INSURANCE" in text:
        category_name = "Insurance"
    elif primary == "TRAVEL":
        category_name = "Travel"
    elif primary == "ENTERTAINMENT":
        category_name = "Fun"
    elif primary == "GOVERNMENT_AND_NON_PROFIT":
        category_name = "Tzedaka"
    elif primary == "LOAN_PAYMENTS":
        category_name = "Debt payments"
    elif primary == "OTHER":
        category_name = "Other"
    elif primary in {"GENERAL_MERCHANDISE", "PERSONAL_CARE", "HOME_IMPROVEMENT", "GENERAL_SERVICES"}:
        category_name = "Shopping"
    if category_name is None:
        return None
    row = connection.execute("SELECT id FROM categories WHERE name = ? AND archived = 0", (category_name,)).fetchone()
    return row[0] if row else None


def _remove_transaction(
    connection: sqlite3.Connection,
    provider: str,
    connection_id: str,
    external_id: str,
    now: str,
) -> None:
    row = connection.execute(
        "SELECT transaction_id FROM transaction_external_ids WHERE provider = ? AND connection_id = ? AND external_id = ?",
        (provider, connection_id, external_id),
    ).fetchone()
    if row is None:
        return
    transaction_id = row[0]
    changed = connection.execute(
        "UPDATE transactions SET tombstoned = 1, updated_at = ? WHERE id = ? AND tombstoned = 0",
        (now, transaction_id),
    ).rowcount
    connection.execute(
        "UPDATE transaction_external_ids SET state = 'removed' WHERE provider = ? AND connection_id = ? AND external_id = ?",
        (provider, connection_id, external_id),
    )
    if changed:
        _audit(connection, "provider_remove", "transaction", transaction_id, now)


def _account_id(connection: sqlite3.Connection, connection_id: str, external_id: str) -> str:
    row = connection.execute(
        "SELECT id FROM accounts WHERE connection_id = ? AND provider_account_id = ?",
        (connection_id, external_id),
    ).fetchone()
    if row is None:
        raise ValueError(f"unknown account {external_id!r}")
    return row[0]


def _audit(
    connection: sqlite3.Connection,
    action: str,
    entity_type: str,
    entity_id: str,
    now: str,
) -> None:
    connection.execute(
        "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'provider', ?, ?, ?, ?)",
        (new_id(), action, entity_type, entity_id, now),
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
