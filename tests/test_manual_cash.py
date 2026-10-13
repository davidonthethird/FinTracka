from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.manual_cash import (
    ManualCashError,
    create_manual_cash,
    delete_manual_cash,
    update_manual_cash,
)
from fintracka.reports import cash_flow, spending_by_owner
from fintracka.sync import apply_batch
from fintracka.synthetic import create_synthetic_ledger, synthetic_batches


@pytest.fixture
def ledger(tmp_path: Path) -> sqlite3.Connection:
    connection = connect(tmp_path / "manual.sqlite3")
    migrate(connection)
    yield connection
    connection.close()


def test_manual_cash_lifecycle_is_audited_and_counted_in_ledger_reports(
    ledger: sqlite3.Connection,
) -> None:
    tzedaka = _category(ledger, "Tzedaka")
    shopping = _category(ledger, "Shopping")
    transaction_id = create_manual_cash(
        ledger, "Shul box", 5_000, tzedaka, "2026-10-13", "Shared"
    )
    row = ledger.execute(
        "SELECT amount_minor, provider_description, category_id, spending_owner, tombstoned, updated_at FROM transactions WHERE id = ?",
        (transaction_id,),
    ).fetchone()
    assert tuple(row)[:5] == (-5_000, "Shul box", tzedaka, "Shared", 0)
    assert cash_flow(ledger, "2026-10").spending_minor == 5_000
    assert spending_by_owner(ledger, "2026-10") == [{"owner": "Shared", "amount_minor": 5_000}]

    update_manual_cash(
        ledger,
        transaction_id,
        row["updated_at"],
        "Cash shopping",
        4_500,
        shopping,
        "2026-10-12",
        "Ariela",
    )
    changed = ledger.execute(
        "SELECT local_date, amount_minor, provider_description, category_id, spending_owner, updated_at FROM transactions WHERE id = ?",
        (transaction_id,),
    ).fetchone()
    assert tuple(changed)[:5] == ("2026-10-12", -4_500, "Cash shopping", shopping, "Ariela")
    assert ledger.execute(
        "SELECT COUNT(*) FROM audit_events WHERE entity_id = ? AND action = 'manual_cash_update'",
        (transaction_id,),
    ).fetchone()[0] == 1

    delete_manual_cash(ledger, transaction_id, changed["updated_at"])
    assert ledger.execute("SELECT tombstoned FROM transactions WHERE id = ?", (transaction_id,)).fetchone()[0] == 1
    assert cash_flow(ledger, "2026-10").spending_minor == 0
    assert ledger.execute(
        "SELECT COUNT(*) FROM audit_events WHERE entity_id = ? AND action = 'manual_cash_delete'",
        (transaction_id,),
    ).fetchone()[0] == 1


def test_manual_cash_mutations_reject_provider_owned_transactions_without_changes(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger, count=1)[0]
    apply_batch(ledger, connection_id, synthetic_batches([connection_id])[connection_id])
    provider = ledger.execute(
        "SELECT * FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE connection_id = ?) ORDER BY id LIMIT 1",
        (connection_id,),
    ).fetchone()
    before = tuple(provider)
    category_id = _category(ledger, "Shopping")

    with pytest.raises(ManualCashError):
        update_manual_cash(
            ledger,
            provider["id"],
            provider["updated_at"],
            "Changed",
            100,
            category_id,
            "2026-10-13",
            "David",
        )
    with pytest.raises(ManualCashError):
        delete_manual_cash(ledger, provider["id"], provider["updated_at"])

    assert tuple(ledger.execute("SELECT * FROM transactions WHERE id = ?", (provider["id"],)).fetchone()) == before


def test_manual_cash_amount_edit_rejects_existing_splits(ledger: sqlite3.Connection) -> None:
    shopping = _category(ledger, "Shopping")
    transaction_id = create_manual_cash(
        ledger, "Split cash", 10_000, shopping, "2026-10-13", "Shared"
    )
    row = ledger.execute("SELECT updated_at FROM transactions WHERE id = ?", (transaction_id,)).fetchone()
    ledger.execute("UPDATE transactions SET has_splits = 1 WHERE id = ?", (transaction_id,))
    ledger.executemany(
        "INSERT INTO transaction_splits (id, parent_transaction_id, amount_minor, category_id, created_at) VALUES (?, ?, ?, ?, '2026-10-13T00:00:00Z')",
        [(new_id(), transaction_id, -4_000, shopping), (new_id(), transaction_id, -6_000, shopping)],
    )

    with pytest.raises(ManualCashError, match="splits"):
        update_manual_cash(
            ledger, transaction_id, row["updated_at"], "Split cash", 20_000,
            shopping, "2026-10-13", "Shared",
        )

    assert cash_flow(ledger, "2026-10").spending_minor == 10_000
    assert ledger.execute("SELECT amount_minor FROM transactions WHERE id = ?", (transaction_id,)).fetchone()[0] == -10_000


def _category(connection: sqlite3.Connection, name: str) -> str:
    return connection.execute("SELECT id FROM categories WHERE name = ?", (name,)).fetchone()[0]
