from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from fintracka.classification import (
    ClassificationConflict,
    ClassificationError,
    set_transaction_classification_once,
)
from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.providers import NormalizedTransaction, SyncBatch
from fintracka.sync import apply_batch
from fintracka.synthetic import create_synthetic_ledger


@pytest.fixture
def ledger(tmp_path: Path) -> sqlite3.Connection:
    connection = connect(tmp_path / "classification.sqlite3")
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    apply_batch(
        connection,
        connection_id,
        SyncBatch(
            added=(
                NormalizedTransaction(
                    "classification-target",
                    "checking-1",
                    "2026-10-10T12:00:00Z",
                    -2_500,
                    "USD",
                    "LOCAL STORE",
                    merchant="Local Store",
                    pending=True,
                ),
            ),
            next_checkpoint="classification-1",
        ),
    )
    yield connection
    connection.close()


def test_migration_starts_existing_transactions_at_revision_zero(
    ledger: sqlite3.Connection,
) -> None:
    row = ledger.execute(
        "SELECT classification_revision FROM transactions WHERE provider_description = 'LOCAL STORE'"
    ).fetchone()

    assert row["classification_revision"] == 0


def test_atomic_classification_sets_parent_and_child_and_increments_once(
    ledger: sqlite3.Connection,
) -> None:
    transaction_id = _transaction_id(ledger)
    shopping = _category(ledger, "Shopping")
    clothing = _subcategory(ledger, shopping, "Clothing")

    change = set_transaction_classification_once(
        ledger,
        transaction_id,
        shopping,
        clothing,
        0,
        actor="member:test-david",
        command_id="command-1",
    )

    assert change.transaction_id == transaction_id
    assert change.category_id == shopping
    assert change.subcategory_id == clothing
    assert change.classification_revision == 1
    assert tuple(
        ledger.execute(
            """
            SELECT category_id, category_source, subcategory_id,
                   subcategory_source, classification_revision
            FROM transactions WHERE id = ?
            """,
            (transaction_id,),
        ).fetchone()
    ) == (shopping, "manual", clothing, "manual", 1)

    event = ledger.execute(
        """
        SELECT actor, action, before_json, after_json
        FROM audit_events
        WHERE entity_type = 'transaction' AND entity_id = ?
          AND action = 'transaction_classification_set'
        """,
        (transaction_id,),
    ).fetchone()
    assert event["actor"] == "member:test-david"
    assert json.loads(event["before_json"]) == {
        "category_id": None,
        "classification_revision": 0,
        "command_id": "command-1",
        "subcategory_id": None,
    }
    assert json.loads(event["after_json"]) == {
        "category_id": shopping,
        "classification_revision": 1,
        "command_id": "command-1",
        "subcategory_id": clothing,
    }
    assert ledger.execute("SELECT COUNT(*) FROM categorization_rules").fetchone()[0] == 0


def test_stale_revision_and_invalid_taxonomy_do_not_mutate(
    ledger: sqlite3.Connection,
) -> None:
    transaction_id = _transaction_id(ledger)
    shopping = _category(ledger, "Shopping")
    dining = _category(ledger, "Dining")
    clothing = _subcategory(ledger, shopping, "Clothing")

    with pytest.raises(ClassificationError, match="subcategory does not belong"):
        set_transaction_classification_once(
            ledger,
            transaction_id,
            dining,
            clothing,
            0,
            actor="member:test",
            command_id="command-parent",
        )

    ledger.execute("UPDATE categories SET archived = 1 WHERE id = ?", (shopping,))
    with pytest.raises(ClassificationError, match="category is not active"):
        set_transaction_classification_once(
            ledger,
            transaction_id,
            shopping,
            None,
            0,
            actor="member:test",
            command_id="command-archived",
        )

    ledger.execute("UPDATE categories SET archived = 0 WHERE id = ?", (shopping,))
    set_transaction_classification_once(
        ledger,
        transaction_id,
        shopping,
        clothing,
        0,
        actor="member:test",
        command_id="command-current",
    )
    with pytest.raises(ClassificationConflict) as conflict:
        set_transaction_classification_once(
            ledger,
            transaction_id,
            dining,
            None,
            0,
            actor="member:test",
            command_id="command-stale",
        )

    assert conflict.value.current_revision == 1
    assert conflict.value.category_id == shopping
    assert conflict.value.subcategory_id == clothing
    assert tuple(
        ledger.execute(
            "SELECT category_id, subcategory_id, classification_revision FROM transactions WHERE id = ?",
            (transaction_id,),
        ).fetchone()
    ) == (shopping, clothing, 1)


def test_uncategorized_is_an_explicit_manual_choice_that_survives_provider_updates(
    ledger: sqlite3.Connection,
) -> None:
    transaction_id = _transaction_id(ledger)
    shopping = _category(ledger, "Shopping")
    clothing = _subcategory(ledger, shopping, "Clothing")
    set_transaction_classification_once(
        ledger,
        transaction_id,
        shopping,
        clothing,
        0,
        actor="member:test",
        command_id="command-set",
    )

    change = set_transaction_classification_once(
        ledger,
        transaction_id,
        None,
        None,
        1,
        actor="member:test",
        command_id="command-clear",
    )

    assert change.category_id is None
    assert change.subcategory_id is None
    assert change.classification_revision == 2
    assert tuple(
        ledger.execute(
            """
            SELECT category_id, category_source, subcategory_id,
                   subcategory_source, classification_revision
            FROM transactions WHERE id = ?
            """,
            (transaction_id,),
        ).fetchone()
    ) == (None, "manual", None, "manual", 2)

    connection_id, account_external_id = ledger.execute(
        "SELECT a.connection_id, a.provider_account_id FROM transactions t "
        "JOIN accounts a ON a.id = t.account_id WHERE t.id = ?",
        (transaction_id,),
    ).fetchone()
    apply_batch(
        ledger,
        connection_id,
        SyncBatch(
            added=(NormalizedTransaction(
                "classification-posted",
                account_external_id,
                "2026-10-11T12:00:00Z",
                -2_500,
                "USD",
                "LOCAL STORE POSTED",
                merchant="Local Store",
                provider_category_primary="GENERAL_MERCHANDISE",
                provider_category_detailed="GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE",
                pending_external_id="classification-target",
            ),),
            removed=("classification-target",),
            next_checkpoint="classification-2",
        ),
    )
    assert tuple(ledger.execute(
        "SELECT category_id, category_source, subcategory_id, subcategory_source "
        "FROM transactions WHERE id = ?",
        (transaction_id,),
    ).fetchone()) == (None, "manual", None, "manual")


def test_explicit_no_subcategory_survives_provider_update(
    ledger: sqlite3.Connection,
) -> None:
    transaction_id = _transaction_id(ledger)
    shopping = _category(ledger, "Shopping")
    set_transaction_classification_once(
        ledger, transaction_id, shopping, None, 0,
        actor="member:test", command_id="command-no-child",
    )

    connection_id, account_external_id = ledger.execute(
        "SELECT a.connection_id, a.provider_account_id FROM transactions t "
        "JOIN accounts a ON a.id = t.account_id WHERE t.id = ?",
        (transaction_id,),
    ).fetchone()
    apply_batch(
        ledger,
        connection_id,
        SyncBatch(
            modified=(NormalizedTransaction(
                "classification-target",
                account_external_id,
                "2026-10-11T12:00:00Z",
                -2_500,
                "USD",
                "MACY'S",
                merchant="Macy's",
                provider_category_primary="GENERAL_MERCHANDISE",
                provider_category_detailed="GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES",
            ),),
            next_checkpoint="classification-2",
        ),
    )
    assert tuple(ledger.execute(
        "SELECT category_id, category_source, subcategory_id, subcategory_source "
        "FROM transactions WHERE id = ?",
        (transaction_id,),
    ).fetchone()) == (shopping, "manual", None, "manual")


def test_archived_transaction_is_rejected(ledger: sqlite3.Connection) -> None:
    transaction_id = _transaction_id(ledger)
    shopping = _category(ledger, "Shopping")
    ledger.execute("UPDATE transactions SET user_archived = 1 WHERE id = ?", (transaction_id,))

    with pytest.raises(ClassificationError, match="transaction is not active"):
        set_transaction_classification_once(
            ledger,
            transaction_id,
            shopping,
            None,
            0,
            actor="member:test",
            command_id="command-archived-transaction",
        )


def _transaction_id(connection: sqlite3.Connection) -> str:
    return connection.execute(
        "SELECT id FROM transactions WHERE provider_description = 'LOCAL STORE'"
    ).fetchone()[0]


def _category(connection: sqlite3.Connection, name: str) -> str:
    return connection.execute("SELECT id FROM categories WHERE name = ?", (name,)).fetchone()[0]


def _subcategory(connection: sqlite3.Connection, category_id: str, name: str) -> str:
    return connection.execute(
        "SELECT id FROM subcategories WHERE category_id = ? AND name = ?",
        (category_id, name),
    ).fetchone()[0]
