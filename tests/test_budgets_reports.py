from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from fintracka.budgets import (
    envelope_budget,
    set_envelope_allocation,
    set_envelope_month,
    set_tracking_target,
    tracking_budget,
    tracking_year,
)
from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.ledger import confirm_transfer, update_transaction
from fintracka.manual_cash import create_manual_cash
from fintracka.providers import NormalizedAccount, NormalizedTransaction, SyncBatch
from fintracka.reports import cash_flow, cash_flow_paths, overview, spending_by_category, spending_by_owner
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


def test_reports_exclude_transfers_and_non_usd_and_net_refunds(
    ledger: sqlite3.Connection,
) -> None:
    income = _category(ledger, "Salary", "income", "income")
    groceries = _category(ledger, "Groceries", "expense", "ordinary")
    update_transaction(ledger, _transaction_id(ledger, "paycheck-1"), category_id=income)
    update_transaction(ledger, _transaction_id(ledger, "groceries-1"), category_id=groceries)
    connection_id = ledger.execute(
        "SELECT id FROM provider_connections WHERE provider = 'synthetic'"
    ).fetchone()[0]
    batch = SyncBatch(
        accounts=(NormalizedAccount("euro-1", "Euro account", "depository", "checking", "asset", "EUR"),),
        added=(
            NormalizedTransaction("refund", "checking-1", "2026-10-05T12:00:00Z", 1_000, "USD", "Market refund"),
            NormalizedTransaction("transfer-out", "checking-1", "2026-10-06T12:00:00Z", -20_000, "USD", "Transfer"),
            NormalizedTransaction("transfer-in", "savings-1", "2026-10-06T13:00:00Z", 20_000, "USD", "Transfer"),
            NormalizedTransaction("euro-income", "euro-1", "2026-10-07T12:00:00Z", 999_999, "EUR", "Euro income"),
        ),
        next_checkpoint="reports",
    )
    apply_batch(ledger, connection_id, batch)
    update_transaction(ledger, _transaction_id(ledger, "refund"), category_id=groceries)
    confirm_transfer(ledger, _transaction_id(ledger, "transfer-out"), _transaction_id(ledger, "transfer-in"))

    flow = cash_flow(ledger, "2026-10")
    assert (flow.income_minor, flow.spending_minor, flow.net_minor) == (325_000, 7_742, 317_258)
    spending = spending_by_category(ledger, "2026-10")
    assert spending == [{"category_id": groceries, "category": "Groceries", "amount_minor": 7_742}]
    paths = cash_flow_paths(ledger, "2026-10")
    grocery_node = next(node for node in paths["nodes"] if node["label"] == "Groceries")
    assert grocery_node["amount_minor"] == 7_742
    grocery_entries = [entry for entry in paths["entries"] if entry["id"] in grocery_node["entry_ids"]]
    assert sorted(entry["amount_minor"] for entry in grocery_entries) == [-8_742, 1_000]
    assert {entry["spending_owner"] for entry in grocery_entries} == {"Shared"}
    assert next(node for node in paths["nodes"] if node["label"] == "Money retained")["amount_minor"] == 317_258
    assert all(entry["description"] != "Transfer" and entry["currency"] == "USD" for entry in paths["entries"])


def test_spending_owner_inherits_from_account_and_allows_transaction_override(
    ledger: sqlite3.Connection,
) -> None:
    groceries = _category(ledger, "Groceries", "expense", "ordinary")
    transaction_id = _transaction_id(ledger, "groceries-1")
    update_transaction(ledger, transaction_id, category_id=groceries)
    ledger.execute(
        "UPDATE accounts SET spending_owner = 'Ariela' WHERE provider_account_id = 'checking-1'"
    )

    assert spending_by_owner(ledger, "2026-10") == [
        {"owner": "Ariela", "amount_minor": 8_742}
    ]

    update_transaction(ledger, transaction_id, spending_owner="Shared")
    assert spending_by_owner(ledger, "2026-10") == [
        {"owner": "Shared", "amount_minor": 8_742}
    ]


def test_tracking_and_envelope_budgets_remain_independent(
    ledger: sqlite3.Connection,
) -> None:
    groceries = _category(ledger, "Groceries", "expense", "ordinary")
    update_transaction(ledger, _transaction_id(ledger, "groceries-1"), category_id=groceries)
    connection_id = ledger.execute(
        "SELECT id FROM provider_connections WHERE provider = 'synthetic'"
    ).fetchone()[0]
    apply_batch(
        ledger,
        connection_id,
        SyncBatch(
            added=(NormalizedTransaction("refund", "checking-1", "2026-10-05T12:00:00Z", 1_000, "USD", "Refund"),),
            next_checkpoint="budget",
        ),
    )
    update_transaction(ledger, _transaction_id(ledger, "refund"), category_id=groceries)

    set_tracking_target(ledger, groceries, "2026-10", 10_000)
    assert ledger.execute(
        "SELECT amount_minor FROM planning_target_overrides WHERE category_id = ? AND month = '2026-10'",
        (groceries,),
    ).fetchone()[0] == 10_000
    assert ledger.execute(
        "SELECT 1 FROM tracking_budget_targets WHERE category_id = ? AND month = '2026-10'",
        (groceries,),
    ).fetchone() is None
    set_envelope_month(ledger, "2026-10", 20_000)
    set_envelope_allocation(ledger, groceries, "2026-10", 9_000)
    tracking = tracking_budget(ledger, "2026-10")
    envelope = envelope_budget(ledger, "2026-10")

    assert tracking[0].actual_minor == 7_742
    assert tracking[0].variance_minor == 2_258
    assert envelope.categories[0].allocated_minor == 9_000
    assert envelope.categories[0].available_minor == 1_258
    assert envelope.available_to_assign_minor == 11_000


def test_year_rollup_and_envelope_carry_cross_year_boundary(
    ledger: sqlite3.Connection,
) -> None:
    category_id = _category(ledger, "Utilities", "expense", "ordinary")
    set_tracking_target(ledger, category_id, "2026-12", 12_000)
    set_tracking_target(ledger, category_id, "2027-01", 13_000)
    assert tracking_year(ledger, 2026)[0].target_minor == 12_000
    assert tracking_year(ledger, 2027)[0].target_minor == 13_000

    set_envelope_month(ledger, "2026-12", 20_000)
    set_envelope_allocation(ledger, category_id, "2026-12", 5_000)
    set_envelope_month(ledger, "2027-01", 15_000)
    set_envelope_allocation(ledger, category_id, "2027-01", 1_000)
    january = envelope_budget(ledger, "2027-01")
    assert january.categories[0].available_minor == 6_000


def test_overview_uses_latest_included_usd_balances(ledger: sqlite3.Connection) -> None:
    result = overview(ledger, "2026-10")
    assert result.cash_minor == 500_000
    assert result.card_liabilities_minor == 42_000
    assert result.net_position_minor == 458_000

    ledger.execute("UPDATE accounts SET include_overview = 0 WHERE subtype = 'savings'")
    assert overview(ledger, "2026-10").cash_minor == 250_000


def test_overview_separates_off_bank_manual_cash_from_observed_balances(
    ledger: sqlite3.Connection,
) -> None:
    shopping = _category(ledger, "Shopping", "expense", "ordinary")
    before = overview(ledger, "2026-10")

    create_manual_cash(ledger, "Cash purchase", 2_500, shopping, "2026-10-13", "Shared")
    after = overview(ledger, "2026-10")

    assert after.spending_minor == before.spending_minor + 2_500
    assert after.off_bank_cash_spending_minor == 2_500
    assert after.cash_spending_minor == before.cash_spending_minor
    assert (after.cash_minor, after.card_liabilities_minor, after.net_position_minor, after.opening_cash_minor) == (
        before.cash_minor,
        before.card_liabilities_minor,
        before.net_position_minor,
        before.opening_cash_minor,
    )


def test_overview_separates_cash_activity_and_confirmed_card_payments(
    ledger: sqlite3.Connection,
) -> None:
    connection_id = ledger.execute(
        "SELECT id FROM provider_connections WHERE provider = 'synthetic'"
    ).fetchone()[0]
    apply_batch(
        ledger,
        connection_id,
        SyncBatch(
            added=(
                NormalizedTransaction("card-purchase", "card-1", "2026-10-06T12:00:00Z", -10_000, "USD", "Card purchase"),
                NormalizedTransaction("card-payment-out", "checking-1", "2026-10-07T12:00:00Z", -20_000, "USD", "Card payment"),
                NormalizedTransaction("card-payment-in", "card-1", "2026-10-07T12:05:00Z", 20_000, "USD", "Card payment"),
            ),
            next_checkpoint="cash-overview",
        ),
    )
    assert ledger.execute(
        "SELECT COUNT(*) FROM transfer_links WHERE status = 'confirmed'"
    ).fetchone()[0] == 1

    result = overview(ledger, "2026-10")
    assert result.spending_minor == 18_742
    assert result.cash_spending_minor == 8_742
    assert result.cash_transfer_minor == -20_000
    assert result.opening_cash_minor is None


def test_overview_accepts_only_exact_month_opening_balance_snapshots(
    ledger: sqlite3.Connection,
) -> None:
    assets = [
        row["id"]
        for row in ledger.execute(
            "SELECT id FROM accounts WHERE nature = 'asset' ORDER BY id"
        )
    ]
    for account_id in assets:
        ledger.execute(
            "INSERT INTO account_balance_snapshots (id, account_id, observed_at, current_minor, currency, source) VALUES (?, ?, '2026-10-01T04:00:00Z', 100000, 'USD', 'opening-test')",
            (new_id(), account_id),
        )

    assert overview(ledger, "2026-10").opening_cash_minor == len(assets) * 100_000

    ledger.execute(
        "UPDATE account_balance_snapshots SET observed_at = '2026-09-01T12:00:00Z' WHERE source = 'opening-test'"
    )
    assert overview(ledger, "2026-10").opening_cash_minor is None


def _category(
    connection: sqlite3.Connection,
    name: str,
    category_type: str,
    reporting_behavior: str,
) -> str:
    existing = connection.execute(
        "SELECT id FROM categories WHERE name = ?", (name,)
    ).fetchone()
    if existing is not None:
        return str(existing["id"])
    category_id = new_id()
    now = "2026-10-11T00:00:00Z"
    connection.execute(
        "INSERT INTO categories (id, name, category_type, reporting_behavior, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        (category_id, name, category_type, reporting_behavior, now, now),
    )
    return category_id


def _transaction_id(connection: sqlite3.Connection, external_id: str) -> str:
    return connection.execute(
        "SELECT transaction_id FROM transaction_external_ids WHERE external_id = ?", (external_id,)
    ).fetchone()[0]
