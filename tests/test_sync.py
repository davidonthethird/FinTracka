from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.providers import NormalizedTransaction, SyncBatch
from fintracka.sync import apply_batch
from fintracka.synthetic import create_synthetic_ledger, synthetic_batches


@pytest.fixture
def ledger(tmp_path: Path) -> sqlite3.Connection:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    yield connection
    connection.close()


def test_three_bank_fixture_has_checking_savings_and_multiple_cards(
    ledger: sqlite3.Connection,
) -> None:
    connection_ids = create_synthetic_ledger(ledger)
    for connection_id, batch in synthetic_batches(connection_ids).items():
        apply_batch(ledger, connection_id, batch)

    assert ledger.execute("SELECT COUNT(*) FROM institutions").fetchone()[0] == 3
    types = [row[0] for row in ledger.execute("SELECT subtype FROM accounts")]
    assert "checking" in types
    assert "savings" in types
    assert types.count("credit_card") >= 2


def test_repeat_modify_and_remove_are_idempotent(ledger: sqlite3.Connection) -> None:
    connection_id = create_synthetic_ledger(ledger)[0]
    initial = synthetic_batches([connection_id])[connection_id]
    apply_batch(ledger, connection_id, initial)
    first_count = ledger.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    first_total = ledger.execute("SELECT SUM(amount_minor) FROM transactions").fetchone()[0]

    apply_batch(ledger, connection_id, initial)
    assert ledger.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == first_count
    assert ledger.execute("SELECT SUM(amount_minor) FROM transactions").fetchone()[0] == first_total

    original = initial.added[0]
    modified = NormalizedTransaction(
        **{**original.__dict__, "amount_minor": original.amount_minor - 125, "description": "Updated merchant"}
    )
    changed = SyncBatch(modified=(modified,), removed=(initial.added[1].external_id,), next_checkpoint="cursor-2")
    apply_batch(ledger, connection_id, changed)

    row = ledger.execute(
        "SELECT amount_minor, provider_description FROM transactions t "
        "JOIN transaction_external_ids e ON e.transaction_id = t.id "
        "WHERE e.external_id = ?",
        (original.external_id,),
    ).fetchone()
    assert tuple(row) == (modified.amount_minor, "Updated merchant")
    assert ledger.execute(
        "SELECT tombstoned FROM transactions t JOIN transaction_external_ids e "
        "ON e.transaction_id = t.id WHERE e.external_id = ?",
        (initial.added[1].external_id,),
    ).fetchone()[0] == 1


def test_pending_to_posted_keeps_one_canonical_row_and_user_fields(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger)[0]
    account_id = "checking-1"
    pending = NormalizedTransaction(
        external_id="pending-coffee",
        account_external_id=account_id,
        occurred_at="2026-10-10T14:00:00Z",
        amount_minor=-525,
        currency="USD",
        description="COFFEE SHOP PENDING",
        pending=True,
    )
    apply_batch(ledger, connection_id, SyncBatch(added=(pending,), next_checkpoint="p1"))
    canonical_id = ledger.execute(
        "SELECT transaction_id FROM transaction_external_ids WHERE external_id = 'pending-coffee'"
    ).fetchone()[0]
    category_id = _category(ledger, "Coffee")
    ledger.execute(
        "UPDATE transactions SET category_id = ?, category_source = 'manual', notes = 'Keep me', user_merchant = 'My Cafe' WHERE id = ?",
        (category_id, canonical_id),
    )

    posted = NormalizedTransaction(
        external_id="posted-coffee",
        pending_external_id="pending-coffee",
        account_external_id=account_id,
        occurred_at="2026-10-11T13:55:00Z",
        amount_minor=-525,
        currency="USD",
        description="COFFEE SHOP 123",
        merchant="Coffee Shop",
        pending=False,
    )
    apply_batch(ledger, connection_id, SyncBatch(added=(posted,), next_checkpoint="p2"))

    assert ledger.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 1
    assert ledger.execute(
        "SELECT COUNT(DISTINCT transaction_id) FROM transaction_external_ids"
    ).fetchone()[0] == 1
    row = ledger.execute(
        "SELECT category_id, category_source, notes, user_merchant, pending FROM transactions WHERE id = ?",
        (canonical_id,),
    ).fetchone()
    assert tuple(row) == (category_id, "manual", "Keep me", "My Cafe", 0)


def test_failure_before_commit_rolls_back_ledger_and_checkpoint(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger)[0]
    initial = synthetic_batches([connection_id])[connection_id]
    apply_batch(ledger, connection_id, initial)
    before = ledger.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]

    extra = NormalizedTransaction(
        external_id="will-roll-back",
        account_external_id="checking-1",
        occurred_at="2026-10-11T18:00:00Z",
        amount_minor=-999,
        currency="USD",
        description="Rollback test",
    )
    with pytest.raises(RuntimeError, match="fault injection"):
        apply_batch(
            ledger,
            connection_id,
            SyncBatch(added=(extra,), next_checkpoint="must-not-commit"),
            fail_before_commit=True,
        )

    assert ledger.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == before
    assert ledger.execute(
        "SELECT cursor FROM provider_checkpoints WHERE connection_id = ?", (connection_id,)
    ).fetchone()[0] == initial.next_checkpoint


def _category(connection: sqlite3.Connection, name: str) -> str:
    category_id = new_id()
    now = "2026-10-11T00:00:00Z"
    connection.execute(
        "INSERT INTO categories (id, name, category_type, reporting_behavior, sort_order, created_at, updated_at) VALUES (?, ?, 'expense', 'ordinary', 1, ?, ?)",
        (category_id, name, now, now),
    )
    return category_id
