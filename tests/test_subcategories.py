from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.ledger import update_transaction
from fintracka.providers import NormalizedTransaction, SyncBatch
from fintracka.subcategories import (
    assign_subcategory,
    automatic_subcategory_id,
    create_subcategory,
    list_subcategories,
    reprocess_subcategory_rule,
)
from fintracka.sync import apply_batch
from fintracka.synthetic import create_synthetic_ledger


@pytest.fixture
def ledger(tmp_path: Path) -> sqlite3.Connection:
    connection = connect(tmp_path / "subcategories.sqlite3")
    migrate(connection)
    yield connection
    connection.close()


def test_sync_assigns_merchant_then_plaid_detail_and_preserves_manual_choice(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger, count=1)[0]
    transactions = (
        _normalized("lowes", "LOWE'S", "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_HOME_IMPROVEMENT"),
        _normalized("macys", "MACY'S", "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES"),
        _normalized("coffee", "Corner Cafe", "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"),
    )
    apply_batch(ledger, connection_id, SyncBatch(added=transactions, next_checkpoint="sub-1"))

    rows = {
        row["provider_merchant"]: (row["category"], row["subcategory"], row["subcategory_source"])
        for row in ledger.execute(
            """
            SELECT t.provider_merchant, c.name category, s.name subcategory, t.subcategory_source
            FROM transactions t
            JOIN categories c ON c.id = t.category_id
            LEFT JOIN subcategories s ON s.id = t.subcategory_id
            """
        )
    }
    assert rows == {
        "LOWE'S": ("Shopping", "Home improvement", "provider"),
        "MACY'S": ("Shopping", "Clothing", "provider"),
        "Corner Cafe": ("Dining", "Coffee & bakeries", "provider"),
    }

    lowes_id = _transaction_id(ledger, "lowes")
    tools_id = create_subcategory(ledger, _category(ledger, "Shopping"), "Tools")
    assign_subcategory(ledger, lowes_id, tools_id, "one_time")
    changed = NormalizedTransaction(**{**transactions[0].__dict__, "description": "LOWE'S UPDATED"})
    apply_batch(ledger, connection_id, SyncBatch(modified=(changed,), next_checkpoint="sub-2"))
    assert tuple(
        ledger.execute(
            """
            SELECT effective.name, proposed.name, t.subcategory_source
            FROM transactions t
            LEFT JOIN subcategories effective ON effective.id = t.subcategory_id
            LEFT JOIN subcategories proposed ON proposed.id = t.provider_subcategory_id
            WHERE t.id = ?
            """,
            (lowes_id,),
        ).fetchone()
    ) == ("Tools", "Home improvement", "manual")


def test_learning_scopes_reprocess_idempotently_and_skip_withdrawals(
    ledger: sqlite3.Connection,
) -> None:
    create_synthetic_ledger(ledger, count=1)
    shopping = _category(ledger, "Shopping")
    clothing = _subcategory(ledger, shopping, "Clothing")
    household = _subcategory(ledger, shopping, "Household")
    first = _insert_transaction(ledger, "MACY'S", shopping)
    second = _insert_transaction(ledger, "MACY'S", shopping)
    withdrawal = _insert_transaction(ledger, "MACY'S", shopping, withdrawal=True)

    one_time = assign_subcategory(ledger, first, household, "one_time")
    assert one_time.affected_count == 1
    assert ledger.execute(
        "SELECT COUNT(*) FROM transaction_subcategory_rules WHERE origin = 'user'"
    ).fetchone()[0] == 0

    future = assign_subcategory(ledger, second, clothing, "future")
    rule_id = ledger.execute(
        "SELECT id FROM transaction_subcategory_rules WHERE origin = 'user'"
    ).fetchone()[0]
    assert future.affected_count == 1
    assert reprocess_subcategory_rule(ledger, rule_id) == 0
    assert reprocess_subcategory_rule(ledger, rule_id) == 0
    assert ledger.execute(
        "SELECT subcategory_id FROM transactions WHERE id = ?", (first,)
    ).fetchone()[0] == household

    third = _insert_transaction(ledger, "MACY'S", shopping)
    fourth = _insert_transaction(ledger, "MACY'S", shopping)
    result = assign_subcategory(ledger, third, clothing, "past_and_future")
    assert result.affected_count == 2
    assert ledger.execute(
        "SELECT subcategory_id FROM transactions WHERE id = ?", (fourth,)
    ).fetchone()[0] == clothing
    assert ledger.execute(
        "SELECT subcategory_id FROM transactions WHERE id = ?", (withdrawal,)
    ).fetchone()[0] is None
    assert ledger.execute(
        "SELECT COUNT(*) FROM subcategory_undo_items WHERE batch_id = ?", (result.undo_id,)
    ).fetchone()[0] == 2
    assert ledger.execute(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'subcategory_assign'"
    ).fetchone()[0] >= 4


def test_user_rule_outranks_builtin_merchant_rule(ledger: sqlite3.Connection) -> None:
    create_synthetic_ledger(ledger, count=1)
    shopping = _category(ledger, "Shopping")
    household = _subcategory(ledger, shopping, "Household")
    transaction_id = _insert_transaction(ledger, "LOWE'S", shopping)

    assign_subcategory(ledger, transaction_id, household, "future")

    assert automatic_subcategory_id(
        ledger, shopping, " LOWE'S ", "GENERAL_MERCHANDISE_HOME_IMPROVEMENT"
    ) == household


def test_provider_parent_change_clears_incompatible_manual_subcategory(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger, count=1)[0]
    original = _normalized(
        "changing", "LOCAL SHOP", "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES"
    )
    apply_batch(ledger, connection_id, SyncBatch(added=(original,), next_checkpoint="parent-1"))
    transaction_id = _transaction_id(ledger, "changing")
    assign_subcategory(
        ledger,
        transaction_id,
        _subcategory(ledger, _category(ledger, "Shopping"), "Clothing"),
        "one_time",
    )

    changed = NormalizedTransaction(
        **{
            **original.__dict__,
            "provider_category_primary": "FOOD_AND_DRINK",
            "provider_category_detailed": "FOOD_AND_DRINK_RESTAURANT",
        }
    )
    apply_batch(ledger, connection_id, SyncBatch(modified=(changed,), next_checkpoint="parent-2"))

    assert tuple(
        ledger.execute(
            """
            SELECT c.name, s.name, t.subcategory_source
            FROM transactions t
            JOIN categories c ON c.id = t.category_id
            LEFT JOIN subcategories s ON s.id = t.subcategory_id
            WHERE t.id = ?
            """,
            (transaction_id,),
        ).fetchone()
    ) == ("Dining", "Restaurants", "provider")


def test_parent_change_clears_incompatible_subcategory_and_custom_names_are_unique(
    ledger: sqlite3.Connection,
) -> None:
    create_synthetic_ledger(ledger, count=1)
    shopping = _category(ledger, "Shopping")
    dining = _category(ledger, "Dining")
    custom = create_subcategory(ledger, shopping, "Craft supplies")
    assert any(row["id"] == custom for row in list_subcategories(ledger, shopping))
    with pytest.raises(ValueError, match="already exists"):
        create_subcategory(ledger, shopping, " Craft supplies ")

    transaction_id = _insert_transaction(ledger, "LOCAL CRAFT", shopping)
    assign_subcategory(ledger, transaction_id, custom, "one_time")
    update_transaction(ledger, transaction_id, category_id=dining)
    assert tuple(
        ledger.execute(
            "SELECT category_id, subcategory_id, subcategory_source FROM transactions WHERE id = ?",
            (transaction_id,),
        ).fetchone()
    ) == (dining, None, None)


def _normalized(external_id: str, merchant: str, primary: str, detailed: str) -> NormalizedTransaction:
    return NormalizedTransaction(
        external_id,
        "checking-1",
        "2026-10-10T12:00:00Z",
        -1_000,
        "USD",
        merchant,
        merchant=merchant,
        provider_category_primary=primary,
        provider_category_detailed=detailed,
    )


def _insert_transaction(
    connection: sqlite3.Connection,
    merchant: str,
    category_id: str,
    *,
    withdrawal: bool = False,
) -> str:
    transaction_id = new_id()
    connection.execute(
        """
        INSERT INTO transactions
        (id, account_id, local_date, amount_minor, currency, provider_description,
         provider_merchant, category_id, category_source, is_cash_withdrawal, created_at, updated_at)
        VALUES (?, '01a13243-efa9-7b54-b1f7-dea052230fd1', '2026-10-10', -1000,
                'USD', ?, ?, ?, 'provider', ?, '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')
        """,
        (transaction_id, merchant, merchant, category_id, int(withdrawal)),
    )
    return transaction_id


def _category(connection: sqlite3.Connection, name: str) -> str:
    return connection.execute("SELECT id FROM categories WHERE name = ?", (name,)).fetchone()[0]


def _subcategory(connection: sqlite3.Connection, category_id: str, name: str) -> str:
    return connection.execute(
        "SELECT id FROM subcategories WHERE category_id = ? AND name = ?",
        (category_id, name),
    ).fetchone()[0]


def _transaction_id(connection: sqlite3.Connection, external_id: str) -> str:
    return connection.execute(
        "SELECT transaction_id FROM transaction_external_ids WHERE external_id = ?",
        (external_id,),
    ).fetchone()[0]
