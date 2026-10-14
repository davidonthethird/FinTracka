from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.ledger import confirm_transfer
from fintracka.planning import planning_snapshot
from fintracka.providers import NormalizedTransaction, SyncBatch
from fintracka.reports import spending_by_category
from fintracka.savings import (
    ManualAssetError,
    create_manual_asset,
    deactivate_manual_asset,
    savings_summary,
    update_manual_asset,
)
from fintracka.sync import apply_batch
from fintracka.synthetic import create_synthetic_ledger, synthetic_batches


@pytest.fixture
def ledger(tmp_path: Path) -> sqlite3.Connection:
    connection = connect(tmp_path / "savings.sqlite3")
    migrate(connection)
    yield connection
    connection.close()


def test_savings_summary_separates_balances_assets_and_monthly_activity(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = create_synthetic_ledger(ledger, count=1)[0]
    initial = synthetic_batches([connection_id])[connection_id]
    apply_batch(ledger, connection_id, initial)
    savings_account = ledger.execute(
        "SELECT id FROM accounts WHERE provider_account_id = 'savings-1'"
    ).fetchone()[0]
    checking_account = ledger.execute(
        "SELECT id FROM accounts WHERE provider_account_id = 'checking-1'"
    ).fetchone()[0]
    ledger.execute(
        "UPDATE accounts SET spending_owner = 'Ariela' WHERE id = ?", (savings_account,)
    )
    ledger.execute(
        """
        INSERT INTO account_balance_snapshots
        (id, account_id, observed_at, current_minor, currency, source)
        VALUES (?, ?, '2026-10-13T12:00:00Z', 260000, 'USD', 'synthetic')
        """,
        (new_id(), savings_account),
    )
    transactions = (
        _transaction("save-paired", "savings-1", 5_000, "TRANSFER IN", "TRANSFER_IN"),
        _transaction("checking-paired", "checking-1", -5_000, "TRANSFER OUT", "TRANSFER_OUT"),
        _transaction("save-unpaired", "savings-1", 3_000, "CASH SAVED", "TRANSFER_IN"),
        _transaction("save-withdrawal", "savings-1", -2_000, "CASH USED", "TRANSFER_OUT"),
        _transaction(
            "save-interest", "savings-1", 100, "INTEREST", "INCOME", "INCOME_INTEREST_EARNED"
        ),
        _transaction(
            "save-purchase", "savings-1", -1_500, "MARKET", "FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES"
        ),
    )
    apply_batch(ledger, connection_id, SyncBatch(added=transactions, next_checkpoint="savings"))
    confirm_transfer(
        ledger,
        _transaction_id(ledger, "save-paired"),
        _transaction_id(ledger, "checking-paired"),
    )

    create_manual_asset(ledger, "Emergency cash", "savings", "Shared", 100_000, "2026-10-13")
    create_manual_asset(ledger, "Brokerage", "investment", "Ariela", 200_000, "2026-10-12")
    create_manual_asset(ledger, "Other reserve", "other", "David", 50_000, "2026-10-11")

    summary = savings_summary(ledger, "2026-10")
    assert summary.connected_total_minor == 260_000
    assert summary.manual_savings_minor == 100_000
    assert summary.investments_minor == 200_000
    assert summary.other_assets_minor == 50_000
    assert summary.combined_total_minor == 610_000
    assert summary.contributions_minor == 8_000
    assert summary.withdrawals_minor == 2_000
    assert summary.earnings_minor == 100
    assert [point.current_minor for point in summary.accounts[0].history] == [250_000, 260_000]
    assert {row.kind for row in summary.activity} == {
        "contribution", "withdrawal", "earnings", "expense"
    }
    assert savings_summary(ledger, "2026-10", "Ariela").combined_total_minor == 460_000
    assert savings_summary(ledger, "2026-10", "Shared").combined_total_minor == 100_000
    assert next(row for row in spending_by_category(ledger, "2026-10") if row["category"] == "Groceries")[
        "amount_minor"
    ] == 1_500
    assert planning_snapshot(ledger, "2026-10", 1).planned_income_total_minor == 0
    assert {checking_account, savings_account}


def test_manual_asset_mutations_validate_conflicts_deactivate_and_audit(
    ledger: sqlite3.Connection,
) -> None:
    create_synthetic_ledger(ledger, count=1)
    with pytest.raises(ManualAssetError, match="nonnegative"):
        create_manual_asset(ledger, "Bad", "savings", "Shared", -1, "2026-10-13")
    identifier = create_manual_asset(
        ledger, "Emergency fund", "savings", "Shared", 10_000, "2026-10-13"
    )
    original = ledger.execute(
        "SELECT updated_at FROM manual_assets WHERE id = ?", (identifier,)
    ).fetchone()[0]
    with pytest.raises(ManualAssetError, match="changed"):
        update_manual_asset(
            ledger, identifier, "stale", "Emergency", "savings", "Shared", 20_000, "2026-10-14"
        )
    update_manual_asset(
        ledger, identifier, original, "Emergency", "savings", "Shared", 20_000, "2026-10-14"
    )
    revised = ledger.execute(
        "SELECT updated_at FROM manual_assets WHERE id = ?", (identifier,)
    ).fetchone()[0]
    deactivate_manual_asset(ledger, identifier, revised)

    assert savings_summary(ledger, "2026-10").combined_total_minor == 0
    events = ledger.execute(
        "SELECT action, before_json, after_json FROM audit_events WHERE entity_id = ? ORDER BY occurred_at, id",
        (identifier,),
    ).fetchall()
    assert [row["action"] for row in events] == [
        "manual_asset_create", "manual_asset_update", "manual_asset_deactivate"
    ]
    assert events[1]["before_json"] and events[1]["after_json"]


def _transaction(
    external_id: str,
    account: str,
    amount: int,
    description: str,
    primary: str,
    detailed: str | None = None,
) -> NormalizedTransaction:
    return NormalizedTransaction(
        external_id,
        account,
        "2026-10-10T12:00:00Z",
        amount,
        "USD",
        description,
        description,
        provider_category_primary=primary,
        provider_category_detailed=detailed,
    )


def _transaction_id(connection: sqlite3.Connection, external_id: str) -> str:
    return connection.execute(
        "SELECT transaction_id FROM transaction_external_ids WHERE external_id = ?", (external_id,)
    ).fetchone()[0]
