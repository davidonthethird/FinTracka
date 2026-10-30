from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.ledger import update_transaction
from fintracka.providers import NormalizedTransaction, SyncBatch
from fintracka.reports import spending_by_category
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

    assert ledger.execute(
        "SELECT COUNT(*) FROM institutions WHERE provider = 'synthetic'"
    ).fetchone()[0] == 3
    types = [row[0] for row in ledger.execute("SELECT subtype FROM accounts")]
    assert "checking" in types
    assert "savings" in types
    assert types.count("credit_card") >= 2


def test_demo_fixture_includes_categorized_budget_data(ledger: sqlite3.Connection) -> None:
    connection_id = create_synthetic_ledger(ledger, count=1, demo=True)[0]
    apply_batch(ledger, connection_id, synthetic_batches([connection_id])[connection_id])

    assert ledger.execute("SELECT COUNT(*) FROM categories").fetchone()[0] >= 4
    assert ledger.execute("SELECT COUNT(*) FROM categorization_rules").fetchone()[0] >= 2
    assert ledger.execute("SELECT COUNT(*) FROM planning_target_overrides").fetchone()[0] >= 3
    assert ledger.execute("SELECT COUNT(*) FROM tracking_budget_targets").fetchone()[0] == 0
    assert ledger.execute(
        "SELECT COUNT(*) FROM transactions WHERE category_source = 'rule'"
    ).fetchone()[0] == 2


def test_demo_fixture_can_be_initialized_repeatedly(ledger: sqlite3.Connection) -> None:
    first_ids = create_synthetic_ledger(ledger, count=1, demo=True)
    second_ids = create_synthetic_ledger(ledger, count=1, demo=True)

    assert second_ids == first_ids
    assert ledger.execute("SELECT COUNT(*) FROM category_groups WHERE name = 'Everyday'").fetchone()[0] == 1
    assert ledger.execute("SELECT COUNT(*) FROM categories").fetchone()[0] >= 5
    assert ledger.execute("SELECT COUNT(*) FROM categorization_rules").fetchone()[0] == 2


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


def test_provider_only_sync_update_does_not_change_classification_revision(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger)[0]
    original = NormalizedTransaction(
        "provider-revision",
        "checking-1",
        "2026-10-08T12:00:00Z",
        -1_250,
        "USD",
        "PENDING LOCAL STORE",
        merchant="Local Store",
        pending=True,
    )
    apply_batch(
        ledger,
        connection_id,
        SyncBatch(added=(original,), next_checkpoint="provider-revision-1"),
    )
    transaction_id = ledger.execute(
        """
        SELECT transaction_id FROM transaction_external_ids
        WHERE external_id = 'provider-revision'
        """
    ).fetchone()[0]

    posted = NormalizedTransaction(
        **{
            **original.__dict__,
            "description": "LOCAL STORE",
            "pending": False,
        }
    )
    apply_batch(
        ledger,
        connection_id,
        SyncBatch(modified=(posted,), next_checkpoint="provider-revision-2"),
    )

    assert tuple(
        ledger.execute(
            "SELECT pending, provider_description, classification_revision FROM transactions WHERE id = ?",
            (transaction_id,),
        ).fetchone()
    ) == (0, "LOCAL STORE", 0)


def test_provider_category_is_mapped_without_overwriting_manual_choice(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger)[0]
    transaction = NormalizedTransaction(
        external_id="groceries",
        account_external_id="checking-1",
        occurred_at="2026-10-10T12:00:00Z",
        amount_minor=-4_200,
        currency="USD",
        description="MARKET",
        merchant="Corner Market",
        provider_category_primary="FOOD_AND_DRINK",
        provider_category_detailed="FOOD_AND_DRINK_GROCERIES",
        provider_category_confidence="VERY_HIGH",
    )
    apply_batch(ledger, connection_id, SyncBatch(added=(transaction,), next_checkpoint="p1"))
    row = ledger.execute(
        "SELECT t.id, c.name, t.category_source, t.provider_category_confidence "
        "FROM transactions t JOIN categories c ON c.id = t.category_id"
    ).fetchone()
    assert tuple(row)[1:] == ("Groceries", "provider", "VERY_HIGH")

    fun_id = ledger.execute("SELECT id FROM categories WHERE name = 'Fun'").fetchone()[0]
    update_transaction(ledger, row["id"], category_id=fun_id)
    changed = NormalizedTransaction(**{**transaction.__dict__, "provider_category_detailed": "FOOD_AND_DRINK_RESTAURANT"})
    apply_batch(ledger, connection_id, SyncBatch(modified=(changed,), next_checkpoint="p2"))
    preserved = ledger.execute(
        "SELECT c.name, t.category_source, t.provider_category_detailed "
        "FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.id = ?",
        (row["id"],),
    ).fetchone()
    assert tuple(preserved) == ("Fun", "manual", "FOOD_AND_DRINK_RESTAURANT")


def test_unmatched_provider_transfers_are_visible_income_or_spending(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger, count=1, demo=True)[0]
    apply_batch(
        ledger,
        connection_id,
        SyncBatch(
            added=(
                NormalizedTransaction(
                    "zelle-out", "checking-1", "2026-10-12T12:00:00Z", -3_000,
                    "USD", "ZELLE TO DEBBIE", provider_category_primary="TRANSFER_OUT",
                ),
                NormalizedTransaction(
                    "zelle-in", "checking-1", "2026-10-13T12:00:00Z", 4_000,
                    "USD", "ZELLE FROM FRIEND", provider_category_primary="TRANSFER_IN",
                ),
            ),
            next_checkpoint="unmatched-transfers",
        ),
    )

    categories = ledger.execute(
        "SELECT t.amount_minor, c.name FROM transactions t JOIN categories c ON c.id=t.category_id ORDER BY t.amount_minor"
    ).fetchall()
    assert [tuple(row) for row in categories] == [(-3_000, "Other"), (4_000, "Other income")]


def test_sync_reclassifies_old_provider_transfer_without_overwriting_manual_choice(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger, count=1, demo=True)[0]
    transaction = NormalizedTransaction(
        "legacy-transfer", "checking-1", "2026-10-12T12:00:00Z", -3_000,
        "USD", "ZELLE TO DEBBIE", provider_category_primary="TRANSFER_OUT",
    )
    apply_batch(ledger, connection_id, SyncBatch(added=(transaction,), next_checkpoint="legacy-1"))
    transfer_id = ledger.execute("SELECT id FROM categories WHERE name='Transfer'").fetchone()[0]
    transaction_id = ledger.execute("SELECT id FROM transactions").fetchone()[0]
    ledger.execute(
        "UPDATE transactions SET category_id=?, category_source='provider', subcategory_id=NULL, subcategory_source=NULL WHERE id=?",
        (transfer_id, transaction_id),
    )

    apply_batch(ledger, connection_id, SyncBatch(next_checkpoint="legacy-2"))

    row = ledger.execute(
        "SELECT c.name, t.category_source FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.id=?",
        (transaction_id,),
    ).fetchone()
    assert tuple(row) == ("Other", "provider")


def test_cash_withdrawal_defaults_to_other_and_giving_maps_to_tzedaka(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger)[0]
    withdrawal = NormalizedTransaction(
        "atm", "checking-1", "2026-10-10T12:00:00Z", -20_000, "USD", "ATM WITHDRAWAL",
        is_cash_withdrawal=True,
    )
    gift = NormalizedTransaction(
        "gift", "checking-1", "2026-10-11T12:00:00Z", -1_800, "USD", "HOOD GIVING",
        provider_category_primary="GOVERNMENT_AND_NON_PROFIT",
    )
    apply_batch(ledger, connection_id, SyncBatch(added=(withdrawal, gift), next_checkpoint="cash"))

    rows = {
        row["provider_description"]: (row["name"], row["is_cash_withdrawal"])
        for row in ledger.execute(
            "SELECT t.provider_description, c.name, t.is_cash_withdrawal FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.provider_description IN ('ATM WITHDRAWAL', 'HOOD GIVING')"
        )
    }
    assert rows == {"ATM WITHDRAWAL": ("Other", 1), "HOOD GIVING": ("Tzedaka", 0)}

    provider_loses_detail = NormalizedTransaction(
        "atm", "checking-1", "2026-10-10T12:00:00Z", -20_000, "USD", "ATM 1234",
        is_cash_withdrawal=False,
        provider_category_primary="TRANSFER_OUT",
    )
    apply_batch(
        ledger, connection_id,
        SyncBatch(modified=(provider_loses_detail,), next_checkpoint="cash-2"),
    )
    persisted = ledger.execute(
        "SELECT t.is_cash_withdrawal, c.name FROM transactions t "
        "LEFT JOIN categories c ON c.id = t.category_id "
        "WHERE t.provider_description = 'ATM 1234'"
    ).fetchone()
    assert tuple(persisted) == (1, "Other")
    assert next(row for row in spending_by_category(ledger, "2026-10") if row["category"] == "Other")[
        "amount_minor"
    ] == 20_000


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
    apply_batch(
        ledger,
        connection_id,
        SyncBatch(
            added=(posted,),
            removed=("pending-coffee",),
            next_checkpoint="p2",
        ),
    )

    assert ledger.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 1
    assert ledger.execute(
        "SELECT COUNT(DISTINCT transaction_id) FROM transaction_external_ids"
    ).fetchone()[0] == 1
    row = ledger.execute(
        "SELECT category_id, category_source, notes, user_merchant, pending, tombstoned FROM transactions WHERE id = ?",
        (canonical_id,),
    ).fetchone()
    assert tuple(row) == (category_id, "manual", "Keep me", "My Cafe", 0, 0)
    aliases = ledger.execute(
        "SELECT external_id, state FROM transaction_external_ids ORDER BY external_id"
    ).fetchall()
    assert [tuple(alias) for alias in aliases] == [
        ("pending-coffee", "removed"),
        ("posted-coffee", "posted"),
    ]


def test_sync_restores_posted_transaction_hidden_by_old_pending_alias_removal(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger)[0]
    pending = NormalizedTransaction(
        external_id="pending-repair",
        account_external_id="checking-1",
        occurred_at="2026-10-10T14:00:00Z",
        amount_minor=-525,
        currency="USD",
        description="PENDING REPAIR",
        pending=True,
    )
    posted = NormalizedTransaction(
        external_id="posted-repair",
        pending_external_id="pending-repair",
        account_external_id="checking-1",
        occurred_at="2026-10-11T14:00:00Z",
        amount_minor=-525,
        currency="USD",
        description="POSTED REPAIR",
    )
    apply_batch(ledger, connection_id, SyncBatch(added=(pending,), next_checkpoint="r1"))
    apply_batch(ledger, connection_id, SyncBatch(added=(posted,), next_checkpoint="r2"))
    transaction_id = ledger.execute(
        "SELECT transaction_id FROM transaction_external_ids WHERE external_id = 'posted-repair'"
    ).fetchone()[0]
    ledger.execute("UPDATE transactions SET tombstoned = 1 WHERE id = ?", (transaction_id,))
    ledger.execute(
        "UPDATE transaction_external_ids SET state = 'removed' WHERE external_id = 'pending-repair'"
    )

    apply_batch(ledger, connection_id, SyncBatch(next_checkpoint="r3"))

    assert ledger.execute(
        "SELECT tombstoned FROM transactions WHERE id = ?", (transaction_id,)
    ).fetchone()[0] == 0
    assert ledger.execute(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'provider_alias_restore' AND entity_id = ?",
        (transaction_id,),
    ).fetchone()[0] == 1


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
