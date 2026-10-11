from __future__ import annotations

import csv
import hashlib
import io
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from fintracka.ids import new_id
from fintracka.money import MoneyError, minor_units


class ImportError(ValueError):
    pass


class DuplicateImportError(ImportError):
    pass


@dataclass(frozen=True)
class ImportResult:
    batch_id: str
    imported_count: int
    duplicate_suggestions: int


def commit_csv(
    connection: sqlite3.Connection,
    account_id: str,
    filename: str,
    content: bytes,
    *,
    max_bytes: int = 5_000_000,
) -> ImportResult:
    if len(content) > max_bytes:
        raise ImportError("CSV exceeds the size limit")
    file_hash = hashlib.sha256(content).hexdigest()
    if connection.execute("SELECT 1 FROM import_batches WHERE file_hash = ?", (file_hash,)).fetchone():
        raise DuplicateImportError("this exact CSV file was already imported")
    account = connection.execute(
        "SELECT connection_id FROM accounts WHERE id = ?", (account_id,)
    ).fetchone()
    if account is None:
        raise ImportError("account not found")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ImportError("CSV must be UTF-8") from error
    reader = csv.DictReader(io.StringIO(text))
    required = {"date", "amount", "currency", "description"}
    if reader.fieldnames is None or not required <= set(reader.fieldnames):
        raise ImportError("CSV requires date, amount, currency, and description columns")
    rows = list(reader)
    if not rows:
        raise ImportError("CSV has no data rows")
    batch_id = new_id()
    now = _now()
    suggestions = 0
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "INSERT INTO import_batches (id, file_hash, filename, status, created_at) VALUES (?, ?, ?, 'previewed', ?)",
            (batch_id, file_hash, filename, now),
        )
        for index, row in enumerate(rows, start=1):
            transaction_id, is_duplicate = _insert_row(
                connection, account_id, account["connection_id"], file_hash, index, row, now
            )
            suggestions += int(is_duplicate)
            row_hash = hashlib.sha256(
                "\x1f".join(row.get(field, "") for field in reader.fieldnames).encode()
            ).hexdigest()
            connection.execute(
                "INSERT INTO import_rows (batch_id, row_index, transaction_id, row_hash) VALUES (?, ?, ?, ?)",
                (batch_id, index, transaction_id, row_hash),
            )
        connection.execute(
            "UPDATE import_batches SET status = 'committed', committed_at = ? WHERE id = ?",
            (now, batch_id),
        )
        connection.execute(
            "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at, after_json) VALUES (?, 'import', 'csv_commit', 'import_batch', ?, ?, ?)",
            (new_id(), batch_id, now, f'{{"row_count":{len(rows)},"duplicate_suggestions":{suggestions}}}'),
        )
        connection.commit()
    except (ValueError, MoneyError, sqlite3.Error):
        connection.rollback()
        raise
    return ImportResult(batch_id, len(rows), suggestions)


def _insert_row(
    connection: sqlite3.Connection,
    account_id: str,
    connection_id: str,
    file_hash: str,
    index: int,
    row: dict[str, str],
    now: str,
) -> tuple[str, bool]:
    try:
        local_date = datetime.strptime(row["date"], "%Y-%m-%d").date().isoformat()
    except (KeyError, ValueError) as error:
        raise ImportError(f"row {index} has an invalid date") from error
    currency = row["currency"]
    amount = minor_units(row["amount"], currency)
    description = row["description"].strip()
    if not description:
        raise ImportError(f"row {index} has no description")
    duplicate = connection.execute(
        "SELECT 1 FROM transactions WHERE account_id = ? AND local_date = ? AND amount_minor = ? AND currency = ? AND provider_description = ? AND tombstoned = 0",
        (account_id, local_date, amount, currency, description),
    ).fetchone() is not None
    transaction_id = new_id()
    instant = f"{local_date}T12:00:00Z"
    connection.execute(
        "INSERT INTO transactions (id, account_id, local_date, posted_at, amount_minor, currency, provider_description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (transaction_id, account_id, local_date, instant, amount, currency, description, now, now),
    )
    connection.execute(
        "INSERT INTO transaction_external_ids (provider, connection_id, external_id, transaction_id, state) VALUES ('csv', ?, ?, ?, 'posted')",
        (connection_id, f"{file_hash}:{index}", transaction_id),
    )
    connection.execute(
        "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'import', ?, 'transaction', ?, ?)",
        (new_id(), "duplicate_suggestion" if duplicate else "csv_create", transaction_id, now),
    )
    return transaction_id, duplicate


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
