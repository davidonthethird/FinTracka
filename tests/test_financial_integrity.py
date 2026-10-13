from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.imports import DuplicateImportError, commit_csv
from fintracka.ledger import (
    IntegrityError,
    apply_rules,
    confirm_transfer,
    create_rule,
    reconcile,
    set_splits,
    transfer_candidates,
    update_transaction,
)
from fintracka.providers import NormalizedTransaction, SyncBatch
from fintracka.sync import apply_batch
from fintracka.synthetic import create_synthetic_ledger, synthetic_batches


@pytest.fixture
def ledger(tmp_path: Path) -> sqlite3.Connection:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    apply_batch(connection, connection_id, synthetic_batches([connection_id])[connection_id])
    yield connection
    connection.close()


def test_rules_are_first_match_and_never_replace_manual_category(
    ledger: sqlite3.Connection,
) -> None:
    groceries = _category(ledger, "Groceries")
    food = _category(ledger, "Food")
    transaction_id = _transaction_id(ledger, "groceries-1")
    create_rule(ledger, "Market specific", 10, {"description_contains": "MARKET"}, groceries)
    create_rule(ledger, "Broad fallback", 20, {"description_contains": "M"}, food)

    assert apply_rules(ledger) == 2
    assert tuple(ledger.execute(
        "SELECT category_id, category_source FROM transactions WHERE id = ?", (transaction_id,)
    ).fetchone()) == (groceries, "rule")

    update_transaction(ledger, transaction_id, category_id=food, notes="manual")
    assert apply_rules(ledger, reprocess=True) == 1
    assert tuple(ledger.execute(
        "SELECT category_id, category_source, notes FROM transactions WHERE id = ?", (transaction_id,)
    ).fetchone()) == (food, "manual", "manual")


def test_splits_must_sum_exactly_and_replace_parent_in_reporting(
    ledger: sqlite3.Connection,
) -> None:
    transaction_id = _transaction_id(ledger, "groceries-1")
    category_id = _category(ledger, "Household")

    with pytest.raises(IntegrityError, match="sum"):
        set_splits(ledger, transaction_id, [(-4_000, category_id, None), (-4_741, category_id, None)])
    assert ledger.execute("SELECT COUNT(*) FROM transaction_splits").fetchone()[0] == 0

    set_splits(ledger, transaction_id, [(-4_000, category_id, "Food"), (-4_742, category_id, "Supplies")])
    assert ledger.execute(
        "SELECT SUM(amount_minor) FROM transaction_splits WHERE parent_transaction_id = ?",
        (transaction_id,),
    ).fetchone()[0] == -8_742
    assert ledger.execute("SELECT has_splits FROM transactions WHERE id = ?", (transaction_id,)).fetchone()[0] == 1


def test_transfer_candidates_require_opposite_amounts_and_confirmation_is_unique(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = ledger.execute("SELECT id FROM provider_connections").fetchone()[0]
    _add_account(ledger, connection_id, "savings-extra")
    apply_batch(
        ledger,
        connection_id,
        SyncBatch(
            added=(
                NormalizedTransaction("transfer-out", "checking-1", "2026-10-07T12:00:00Z", -20_000, "USD", "Transfer"),
                NormalizedTransaction("transfer-in", "savings-extra", "2026-10-08T12:00:00Z", 20_000, "USD", "Transfer"),
                NormalizedTransaction("same-sign", "savings-extra", "2026-10-08T13:00:00Z", -20_000, "USD", "Purchase"),
            ),
            next_checkpoint="transfers",
        ),
    )

    candidates = transfer_candidates(ledger)
    pair = next(candidate for candidate in candidates if {candidate.external_a, candidate.external_b} == {"transfer-out", "transfer-in"})
    assert pair.label_a == "Transfer"
    assert pair.label_b == "Transfer"
    assert pair.amount_minor == 20_000
    assert pair.currency == "USD"
    link_id = confirm_transfer(ledger, pair.transaction_a, pair.transaction_b)
    assert ledger.execute("SELECT status FROM transfer_links WHERE id = ?", (link_id,)).fetchone()[0] == "confirmed"
    with pytest.raises(IntegrityError, match="already"):
        confirm_transfer(ledger, pair.transaction_a, _transaction_id(ledger, "same-sign"))


def test_reconciliation_is_exact_to_one_cent(ledger: sqlite3.Connection) -> None:
    account_id = ledger.execute("SELECT id FROM accounts WHERE provider_account_id = 'checking-1'").fetchone()[0]
    activity = ledger.execute(
        "SELECT SUM(amount_minor) FROM transactions WHERE account_id = ? AND local_date BETWEEN '2026-10-01' AND '2026-10-31'",
        (account_id,),
    ).fetchone()[0]
    exact = reconcile(ledger, account_id, "2026-10-01", "2026-10-31", 100_000, 100_000 + activity, "2026-10-31")
    off = reconcile(ledger, account_id, "2026-10-01", "2026-10-31", 100_000, 100_000 + activity + 1, "2026-10-31")

    assert exact.status == "balanced" and exact.difference_minor == 0
    assert off.status == "unbalanced" and off.difference_minor == 1


def test_csv_replay_is_blocked_and_overlapping_file_is_suggested(
    ledger: sqlite3.Connection,
) -> None:
    account_id = ledger.execute("SELECT id FROM accounts WHERE provider_account_id = 'checking-1'").fetchone()[0]
    first = b"date,amount,currency,description\n2026-10-09,-12.34,USD,Lunch\n"
    second = b"date,amount,currency,description,extra\n2026-10-09,-12.34,USD,Lunch,x\n"

    result = commit_csv(ledger, account_id, "first.csv", first)
    assert result.imported_count == 1 and result.duplicate_suggestions == 0
    with pytest.raises(DuplicateImportError):
        commit_csv(ledger, account_id, "first-again.csv", first)
    overlap = commit_csv(ledger, account_id, "second.csv", second)
    assert overlap.imported_count == 1 and overlap.duplicate_suggestions == 1


def _category(connection: sqlite3.Connection, name: str) -> str:
    existing = connection.execute(
        "SELECT id FROM categories WHERE name = ?", (name,)
    ).fetchone()
    if existing is not None:
        return str(existing["id"])
    category_id = new_id()
    now = "2026-10-11T00:00:00Z"
    connection.execute(
        "INSERT INTO categories (id, name, category_type, reporting_behavior, sort_order, created_at, updated_at) VALUES (?, ?, 'expense', 'ordinary', 1, ?, ?)",
        (category_id, name, now, now),
    )
    return category_id


def _transaction_id(connection: sqlite3.Connection, external_id: str) -> str:
    return connection.execute(
        "SELECT transaction_id FROM transaction_external_ids WHERE external_id = ?", (external_id,)
    ).fetchone()[0]


def _add_account(connection: sqlite3.Connection, connection_id: str, external_id: str) -> None:
    now = "2026-10-11T00:00:00Z"
    connection.execute(
        "INSERT INTO accounts (id, connection_id, provider_account_id, name, type, subtype, nature, currency, created_at, updated_at) VALUES (?, ?, ?, 'Savings', 'depository', 'savings', 'asset', 'USD', ?, ?)",
        (new_id(), connection_id, external_id, now, now),
    )
