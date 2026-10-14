from __future__ import annotations

import csv
import hashlib
import io
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from fintracka.ids import new_id
from fintracka.ledger import apply_rules
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


@dataclass(frozen=True)
class ImportPreview:
    file_hash: str
    row_count: int
    already_imported: bool
    duplicate_suggestions: int


def preview_csv(
    connection: sqlite3.Connection,
    content: bytes,
    *,
    account_id: str | None = None,
    max_bytes: int = 5_000_000,
) -> ImportPreview:
    file_hash, _, rows = _read_csv(content, max_bytes=max_bytes)
    if account_id is not None and connection.execute(
        "SELECT 1 FROM accounts WHERE id = ?", (account_id,)
    ).fetchone() is None:
        raise ImportError("account not found")
    duplicates = 0
    for index, row in enumerate(rows, start=1):
        parsed = _parsed_row(row, index)
        duplicates += int(account_id is not None and _is_duplicate(connection, account_id, parsed))
    imported = connection.execute(
        "SELECT 1 FROM import_batches WHERE file_hash = ?", (file_hash,)
    ).fetchone() is not None
    return ImportPreview(file_hash, len(rows), imported, duplicates)


def commit_csv(
    connection: sqlite3.Connection,
    account_id: str,
    filename: str,
    content: bytes,
    *,
    max_bytes: int = 5_000_000,
) -> ImportResult:
    file_hash, fieldnames, rows = _read_csv(content, max_bytes=max_bytes)
    if connection.execute("SELECT 1 FROM import_batches WHERE file_hash = ?", (file_hash,)).fetchone():
        raise DuplicateImportError("this exact CSV file was already imported")
    account = connection.execute(
        "SELECT connection_id FROM accounts WHERE id = ?", (account_id,)
    ).fetchone()
    if account is None:
        raise ImportError("account not found")
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
                "\x1f".join(row.get(field, "") for field in fieldnames).encode()
            ).hexdigest()
            connection.execute(
                "INSERT INTO import_rows (batch_id, row_index, transaction_id, row_hash) VALUES (?, ?, ?, ?)",
                (batch_id, index, transaction_id, row_hash),
            )
        apply_rules(connection)
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
    parsed = _parsed_row(row, index)
    local_date, amount, currency, description = parsed
    duplicate = _is_duplicate(connection, account_id, parsed)
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


def _is_duplicate(
    connection: sqlite3.Connection,
    account_id: str,
    parsed: tuple[str, int, str, str],
) -> bool:
    local_date, amount, currency, description = parsed
    return connection.execute(
        "SELECT 1 FROM transactions WHERE account_id = ? AND local_date = ? AND amount_minor = ? AND currency = ? AND provider_description = ? AND tombstoned = 0",
        (account_id, local_date, amount, currency, description),
    ).fetchone() is not None


def _read_csv(content: bytes, *, max_bytes: int) -> tuple[str, list[str], list[dict[str, str]]]:
    if len(content) > max_bytes:
        raise ImportError("CSV exceeds the size limit")
    file_hash = hashlib.sha256(content).hexdigest()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ImportError("CSV must be UTF-8") from error
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        raise ImportError("CSV requires a header row")
    rows = list(reader)
    if not rows:
        raise ImportError("CSV has no data rows")
    return file_hash, reader.fieldnames, rows


def _parsed_row(row: dict[str, str], index: int) -> tuple[str, int, str, str]:
    date_text = _field(row, "date", "transaction date", "posted date")
    local_date = None
    for date_format in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            local_date = datetime.strptime(date_text, date_format).date().isoformat()
            break
        except ValueError:
            pass
    if local_date is None:
        raise ImportError(f"row {index} has an invalid date")
    currency = (_field(row, "currency") or "USD").upper()
    amount_text = _field(row, "amount")
    if amount_text:
        amount = minor_units(_money_text(amount_text), currency)
    else:
        debit = _field(row, "debit")
        credit = _field(row, "credit")
        if not debit and not credit:
            raise ImportError(f"row {index} has no amount, debit, or credit")
        amount = minor_units(_money_text(credit or "0"), currency) - minor_units(
            _money_text(debit or "0"), currency
        )
    description = _field(row, "description", "payee", "merchant", "name")
    if not description:
        raise ImportError(f"row {index} has no description")
    return local_date, amount, currency, description


def _field(row: dict[str, str], *names: str) -> str:
    normalized = {
        " ".join(key.strip().lower().replace("_", " ").split()): (value or "").strip()
        for key, value in row.items()
        if key is not None
    }
    return next((normalized[name] for name in names if normalized.get(name)), "")


def _money_text(value: str) -> str:
    cleaned = value.strip().replace(",", "").replace("$", "")
    if cleaned.startswith("(") and cleaned.endswith(")"):
        return f"-{cleaned[1:-1]}"
    return cleaned


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
