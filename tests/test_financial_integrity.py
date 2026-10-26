from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.imports import DuplicateImportError, commit_csv, preview_csv
from fintracka.ledger import (
    IntegrityError,
    apply_rules,
    categorize_transaction,
    confirm_transfer,
    create_rule,
    reconcile,
    set_splits,
    transfer_candidates,
    update_transaction,
)
from fintracka.providers import NormalizedAccount, NormalizedTransaction, SyncBatch
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


def test_withdrawal_categorization_is_always_one_time(ledger: sqlite3.Connection) -> None:
    shopping = _category(ledger, "Shopping")
    account_id = ledger.execute(
        "SELECT id FROM accounts WHERE provider_account_id = 'checking-1'"
    ).fetchone()[0]
    now = "2026-10-13T00:00:00Z"
    identifiers = [new_id(), new_id()]
    ledger.executemany(
        """
        INSERT INTO transactions
        (id, account_id, local_date, amount_minor, currency, provider_description,
         is_cash_withdrawal, created_at, updated_at)
        VALUES (?, ?, '2026-10-13', -2000, 'USD', 'ATM WITHDRAWAL', 1, ?, ?)
        """,
        [(identifier, account_id, now, now) for identifier in identifiers],
    )

    result = categorize_transaction(ledger, identifiers[0], shopping, "past_and_future")

    assert result.affected_count == 1
    assert ledger.execute(
        "SELECT COUNT(*) FROM categorization_rules WHERE name LIKE 'Learned: %'"
    ).fetchone()[0] == 0
    assert ledger.execute(
        "SELECT category_id FROM transactions WHERE id = ?", (identifiers[1],)
    ).fetchone()[0] is None

    ordinary = new_id()
    protected = new_id()
    ledger.executemany(
        """
        INSERT INTO transactions
        (id, account_id, local_date, amount_minor, currency, provider_description,
         provider_merchant, is_cash_withdrawal, created_at, updated_at)
        VALUES (?, ?, '2026-10-13', -2000, 'USD', 'SAME MERCHANT', 'Same Merchant', ?, ?, ?)
        """,
        [(ordinary, account_id, 0, now, now), (protected, account_id, 1, now, now)],
    )
    learned = categorize_transaction(ledger, ordinary, shopping, "past_and_future")
    assert learned.affected_count == 1
    assert ledger.execute(
        "SELECT category_id FROM transactions WHERE id = ?", (protected,)
    ).fetchone()[0] is None


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
    connection_id = ledger.execute(
        "SELECT id FROM provider_connections WHERE provider = 'synthetic'"
    ).fetchone()[0]
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


def test_confirmed_counterparty_pattern_auto_confirms_matching_history_only(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = ledger.execute(
        "SELECT id FROM provider_connections WHERE provider = 'synthetic'"
    ).fetchone()[0]
    _add_account(ledger, connection_id, "savings-extra")
    apply_batch(
        ledger,
        connection_id,
        SyncBatch(
            added=(
                NormalizedTransaction("learn-out-1", "checking-1", "2026-09-01T12:00:00Z", -20_000, "USD", "ZELLE TO FAMILY SAVINGS"),
                NormalizedTransaction("learn-in-1", "savings-extra", "2026-09-01T13:00:00Z", 20_000, "USD", "ZELLE FROM DAVID"),
                NormalizedTransaction("learn-out-2", "checking-1", "2026-10-01T12:00:00Z", -30_000, "USD", "ZELLE TO FAMILY SAVINGS"),
                NormalizedTransaction("learn-in-2", "savings-extra", "2026-10-02T13:00:00Z", 30_000, "USD", "ZELLE FROM DAVID"),
                NormalizedTransaction("other-out", "checking-1", "2026-10-03T12:00:00Z", -40_000, "USD", "ZELLE TO DEBBIE YOUNG ISRAEL"),
                NormalizedTransaction("other-in", "savings-extra", "2026-10-03T13:00:00Z", 40_000, "USD", "ZELLE FROM SOMEONE ELSE"),
            ),
            next_checkpoint="learned-transfers",
        ),
    )

    confirm_transfer(
        ledger,
        _transaction_id(ledger, "learn-out-1"),
        _transaction_id(ledger, "learn-in-1"),
    )

    confirmed = ledger.execute(
        "SELECT COUNT(*) FROM transfer_links WHERE status = 'confirmed'"
    ).fetchone()[0]
    assert confirmed == 2
    remaining = {
        frozenset((candidate.external_a, candidate.external_b))
        for candidate in transfer_candidates(ledger)
    }
    assert frozenset(("other-out", "other-in")) in remaining

    apply_batch(
        ledger,
        connection_id,
        SyncBatch(
            added=(
                NormalizedTransaction("learn-out-3", "checking-1", "2026-10-10T12:00:00Z", -60_000, "USD", "ZELLE TO FAMILY SAVINGS"),
                NormalizedTransaction("learn-in-3", "savings-extra", "2026-10-11T13:00:00Z", 60_000, "USD", "ZELLE FROM DAVID"),
            ),
            next_checkpoint="future-learned-transfer",
        ),
    )
    assert ledger.execute(
        "SELECT COUNT(*) FROM transfer_links WHERE status = 'confirmed'"
    ).fetchone()[0] == 3


def test_sync_auto_archives_credit_card_payments_even_when_bank_side_is_duplicated(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = ledger.execute(
        "SELECT id FROM provider_connections WHERE provider = 'synthetic'"
    ).fetchone()[0]
    apply_batch(
        ledger,
        connection_id,
        SyncBatch(
            accounts=(
                NormalizedAccount(
                    "chase-card", "Chase card", "credit", "credit_card", "liability"
                ),
                NormalizedAccount(
                    "duplicate-checking", "Joint checking", "depository", "checking", "asset"
                ),
            ),
            added=(
                NormalizedTransaction(
                    "card-payment-out",
                    "checking-1",
                    "2026-10-23T12:00:00Z",
                    -28_900,
                    "USD",
                    "Payment to Chase card ending in 8750 10/23",
                ),
                NormalizedTransaction(
                    "duplicate-payment-out",
                    "duplicate-checking",
                    "2026-10-23T12:00:00Z",
                    -28_900,
                    "USD",
                    "Payment to Chase card ending in 8750 10/23",
                ),
                NormalizedTransaction(
                    "card-payment-in",
                    "chase-card",
                    "2026-10-23T13:00:00Z",
                    28_900,
                    "USD",
                    "Payment Thank You-Mobile",
                ),
                NormalizedTransaction(
                    "provider-card-payment",
                    "checking-1",
                    "2026-10-24T12:00:00Z",
                    -12_256,
                    "USD",
                    "BANK CARD PAYMENT",
                    provider_category_primary="TRANSFER_OUT",
                    provider_category_detailed="TRANSFER_OUT_CREDIT_CARD_PAYMENT",
                ),
                NormalizedTransaction(
                    "standalone-card-credit",
                    "chase-card",
                    "2026-10-09T12:00:00Z",
                    78_038,
                    "USD",
                    "ONLINE PAYMENT, THANK YOU",
                    provider_category_primary="INCOME",
                    provider_category_detailed="INCOME_OTHER_INCOME",
                ),
            ),
            next_checkpoint="credit-card-payment",
        ),
    )

    archived = {
        row["external_id"]: row["user_archived"]
        for row in ledger.execute(
            """
            SELECT e.external_id, t.user_archived
            FROM transactions t
            JOIN transaction_external_ids e ON e.transaction_id = t.id
            WHERE e.external_id IN (
                'card-payment-out', 'duplicate-payment-out', 'card-payment-in',
                'provider-card-payment', 'standalone-card-credit'
            )
            """
        )
    }
    assert archived == {
        "card-payment-out": 1,
        "duplicate-payment-out": 1,
        "card-payment-in": 1,
        "provider-card-payment": 1,
        "standalone-card-credit": 1,
    }


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
    preview = preview_csv(ledger, second, account_id=account_id)
    assert preview.row_count == 1 and preview.duplicate_suggestions == 1
    overlap = commit_csv(ledger, account_id, "second.csv", second)
    assert overlap.imported_count == 1 and overlap.duplicate_suggestions == 1


def test_csv_import_normalizes_common_bank_headers(
    ledger: sqlite3.Connection,
) -> None:
    account_id = ledger.execute("SELECT id FROM accounts WHERE provider_account_id = 'checking-1'").fetchone()[0]
    capital_one = (
        b"Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n"
        b"10/01/2026,10/02/2026,1234,HOME STORE,Merchandise,45.67,\n"
        b"10/03/2026,10/04/2026,1234,MERCHANT REFUND,Payment/Credit,,12.34\n"
    )
    bank_of_america = (
        b"Posted Date,Reference Number,Payee,Address,Amount\n"
        b'10/05/2026,987,"GROCERY, STORE",,-20.00\n'
    )

    assert commit_csv(ledger, account_id, "capital-one.csv", capital_one).imported_count == 2
    assert commit_csv(ledger, account_id, "bank-of-america.csv", bank_of_america).imported_count == 1
    rows = ledger.execute(
        "SELECT local_date, amount_minor, currency, provider_description FROM transactions WHERE provider_description IN ('HOME STORE', 'MERCHANT REFUND', 'GROCERY, STORE') ORDER BY local_date"
    ).fetchall()

    assert [tuple(row) for row in rows] == [
        ("2026-10-01", -4567, "USD", "HOME STORE"),
        ("2026-10-03", 1234, "USD", "MERCHANT REFUND"),
        ("2026-10-05", -2000, "USD", "GROCERY, STORE"),
    ]


def test_csv_import_applies_existing_categorization_rules(
    ledger: sqlite3.Connection,
) -> None:
    account_id = ledger.execute("SELECT id FROM accounts WHERE provider_account_id = 'checking-1'").fetchone()[0]
    groceries = _category(ledger, "Groceries")
    create_rule(ledger, "Older groceries", 1, {"description_contains": "OLDER GROCERIES"}, groceries)

    commit_csv(
        ledger,
        account_id,
        "older.csv",
        b"date,amount,currency,description\n2025-09-01,-22.50,USD,OLDER GROCERIES\n",
    )

    assert tuple(ledger.execute(
        "SELECT category_id, category_source FROM transactions WHERE provider_description = 'OLDER GROCERIES'"
    ).fetchone()) == (groceries, "rule")


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
