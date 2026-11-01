from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from fintracka.db import connect, migrate
from fintracka.receipts import ReceiptConflict, ReceiptError, apply_receipt_split
from fintracka.reports import ledger_entries
from fintracka.synthetic import create_synthetic_ledger, synthetic_batches
from fintracka.sync import apply_batch
from fintracka.api import _transaction_response


@pytest.fixture
def ledger(tmp_path: Path) -> sqlite3.Connection:
    connection = connect(tmp_path / "receipts.sqlite3")
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    apply_batch(connection, connection_id, synthetic_batches([connection_id])[connection_id])
    yield connection
    connection.close()


def test_receipt_migration_preserves_existing_splits_and_adds_revision(ledger: sqlite3.Connection) -> None:
    transaction = _transaction(ledger)
    columns = {row[1] for row in ledger.execute("PRAGMA table_info(transaction_splits)")}
    assert {"subcategory_id", "spending_owner", "receipt_line_id", "source"} <= columns
    assert transaction["split_revision"] == 0
    assert {row[0] for row in ledger.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'receipt%'"
    )} >= {"receipts", "receipt_lines", "receipt_applications"}


def test_applies_exact_signed_detailed_splits_once_and_preserves_line_ownership(
    ledger: sqlite3.Connection,
) -> None:
    transaction = _transaction(ledger)
    draft = _draft(ledger)
    digest = _digest(draft)

    first = apply_receipt_split(
        ledger, transaction["id"], 0, "receipt-cloud-1", 1, digest, draft,
        command_id="receipt-command-1", actor_member_id="member-david",
    )
    replay = apply_receipt_split(
        ledger, transaction["id"], 0, "receipt-cloud-1", 1, digest, draft,
        command_id="receipt-command-1", actor_member_id="member-david",
    )

    assert first == replay
    assert first.split_revision == 1 and first.split_count == 2
    rows = ledger.execute(
        "SELECT amount_minor, spending_owner, source, receipt_line_id FROM transaction_splits WHERE parent_transaction_id = ? ORDER BY amount_minor",
        (transaction["id"],),
    ).fetchall()
    assert [(row["amount_minor"], row["spending_owner"], row["source"]) for row in rows] == [
        (-4_742, "Shared", "receipt"), (-4_000, "David", "receipt")
    ]
    assert all(row["receipt_line_id"] for row in rows)
    assert ledger.execute("SELECT COUNT(*) FROM receipts").fetchone()[0] == 1
    entries = [entry for entry in ledger_entries(
        ledger, "2026-10-01", "2026-10-31", account_flag="include_budget"
    )
               if entry.transaction_id == transaction["id"]]
    assert {entry.spending_owner for entry in entries} == {"David", "Shared"}
    detail = _transaction_response(ledger, transaction["id"])
    assert detail.receipt is not None
    assert detail.receipt.total_minor == abs(transaction["amount_minor"])
    assert [(line.description, line.spending_owner) for line in detail.receipt.lines] == [
        ("Synthetic 0", "David"), ("Synthetic 1", "Shared")
    ]


def test_rejects_stale_revision_amount_mismatch_and_manual_split_without_mutation(
    ledger: sqlite3.Connection,
) -> None:
    transaction = _transaction(ledger)
    draft = _draft(ledger)
    with pytest.raises(ReceiptConflict, match="revision"):
        apply_receipt_split(ledger, transaction["id"], 1, "receipt-cloud-2", 1,
                            _digest(draft), draft, command_id="stale-command",
                            actor_member_id="member-david")
    wrong = {**draft, "total_minor": 8_700}
    with pytest.raises(ReceiptError, match="reconcile|amount"):
        apply_receipt_split(ledger, transaction["id"], 0, "receipt-cloud-3", 1,
                            _digest(wrong), wrong, command_id="wrong-command",
                            actor_member_id="member-david")
    assert ledger.execute("SELECT COUNT(*) FROM transaction_splits").fetchone()[0] == 0
    assert ledger.execute("SELECT COUNT(*) FROM receipts").fetchone()[0] == 0


def _transaction(connection: sqlite3.Connection) -> sqlite3.Row:
    return connection.execute(
        "SELECT * FROM transactions WHERE amount_minor = -8742 ORDER BY id LIMIT 1"
    ).fetchone()


def _draft(connection: sqlite3.Connection) -> dict[str, object]:
    groceries = connection.execute("SELECT id FROM categories WHERE name = 'Groceries'").fetchone()[0]
    shopping = connection.execute("SELECT id FROM categories WHERE name = 'Shopping'").fetchone()[0]
    return {
        "contract": "receipt_draft/v1", "status": "waiting_for_bank",
        "merchant": "Synthetic Market", "purchase_date": "2026-10-03", "currency": "USD",
        "masked_payment_hint": None, "page_count": 1, "subtotal_minor": 8_742,
        "discount_minor": 0, "tax_minor": 0, "tip_minor": 0, "fees_minor": 0,
        "total_minor": 8_742, "lines": [
            _line("cloud-line-1", 0, 4_000, "David", groceries),
            _line("cloud-line-2", 1, 4_742, "Shared", shopping),
        ],
    }


def _line(line_id: str, order: int, amount: int, owner: str, category_id: str) -> dict[str, object]:
    return {"id": line_id, "order": order, "source_page": 0, "description": f"Synthetic {order}",
            "quantity": "1", "unit_amount_minor": amount, "item_total_minor": amount,
            "line_discount_minor": 0, "tax_minor": 0, "tip_minor": 0, "fees_minor": 0,
            "taxable": True, "owner": owner, "category_id": category_id,
            "subcategory_id": None, "confidence_basis_points": 10_000, "review_flags": []}


def _digest(draft: dict[str, object]) -> str:
    body = json.dumps(draft, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(body.encode()).hexdigest()
