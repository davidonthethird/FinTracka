from __future__ import annotations

import sqlite3
from datetime import date
from pathlib import Path

import pytest

from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.ledger import confirm_transfer
from fintracka.planning import (
    PlanningError,
    create_income_source,
    planning_snapshot,
    set_income_override,
    set_income_version,
    set_recurring_target,
    set_target_override,
)


@pytest.fixture
def ledger(tmp_path: Path) -> sqlite3.Connection:
    connection = connect(tmp_path / "planning.sqlite3")
    migrate(connection)
    yield connection
    connection.close()


def test_planned_income_versions_overrides_and_deactivation_preserve_history(
    ledger: sqlite3.Connection,
) -> None:
    salary = create_income_source(ledger, "Paycheck", "Salary", 590_000, "2026-02")
    custom = create_income_source(ledger, "Rental", "Custom", 110_000, "2026-02")
    set_income_version(ledger, salary, "Paycheck", "Salary", 600_000, "2026-03", True)
    set_income_override(ledger, salary, "2026-04", 610_000)
    set_income_version(ledger, salary, "Paycheck", "Salary", 600_000, "2026-05", False)

    assert planning_snapshot(ledger, "2026-01", 1).planned_income_total_minor == 0
    february = planning_snapshot(ledger, "2026-02", 1)
    assert [(row.title, row.income_type, row.amount_minor) for row in february.incomes] == [
        ("Paycheck", "Salary", 590_000),
        ("Rental", "Custom", 110_000),
    ]
    assert planning_snapshot(ledger, "2026-03", 1).salary_total_minor == 600_000
    assert planning_snapshot(ledger, "2026-04", 1).salary_total_minor == 610_000
    june = planning_snapshot(ledger, "2026-06", 1)
    assert [(row.title, row.amount_minor) for row in june.incomes] == [("Rental", 110_000)]
    assert planning_snapshot(ledger, "2026-02", 1).salary_total_minor == 590_000


def test_targets_flow_forward_allow_month_override_and_enforce_tzedaka_floor(
    ledger: sqlite3.Connection,
) -> None:
    groceries = _category(ledger, "Groceries")
    tzedaka = _category(ledger, "Tzedaka")
    create_income_source(ledger, "Small salary", "Salary", 10_001, "2026-10")
    create_income_source(ledger, "Gift", "Custom", 90_000, "2026-10")
    set_recurring_target(ledger, groceries, 500, "2026-10")
    set_target_override(ledger, groceries, "2026-11", 400)

    assert _planned_category(ledger, "2026-10", groceries).target_minor == 500
    assert _planned_category(ledger, "2026-11", groceries).target_minor == 400
    assert _planned_category(ledger, "2026-12", groceries).target_minor == 500
    october = planning_snapshot(ledger, "2026-10", 1)
    assert october.tzedaka_minimum_minor == 1_001
    assert next(row for row in october.categories if row.category_id == tzedaka).target_minor == 1_001

    with pytest.raises(PlanningError) as caught:
        set_recurring_target(ledger, tzedaka, 1_000, "2026-10")
    assert caught.value.minimum_minor == 1_001

    set_recurring_target(ledger, tzedaka, 1_500, "2026-10")
    assert _planned_category(ledger, "2026-10", tzedaka).target_minor == 1_500


def test_averages_include_zero_months_refunds_splits_manual_cash_and_owner_filter(
    ledger: sqlite3.Connection,
) -> None:
    shopping = _category(ledger, "Shopping")
    tzedaka = _category(ledger, "Tzedaka")
    _transaction(ledger, "2026-08-10", -300, shopping)
    _transaction(ledger, "2026-08-11", 60, shopping)
    _transaction(ledger, "2026-09-01", -120, shopping, owner="David")
    _transaction(ledger, "2026-09-02", -999, shopping, pending=True)
    _transaction(ledger, "2026-09-03", -999, shopping, tombstoned=True)
    parent = _transaction(ledger, "2026-09-04", -300, shopping, has_splits=True)
    ledger.execute(
        "INSERT INTO transaction_splits (id, parent_transaction_id, amount_minor, category_id, created_at) VALUES (?, ?, -200, ?, '2026-10-13T00:00:00Z')",
        (new_id(), parent, shopping),
    )
    ledger.execute(
        "INSERT INTO transaction_splits (id, parent_transaction_id, amount_minor, category_id, created_at) VALUES (?, ?, -100, ?, '2026-10-13T00:00:00Z')",
        (new_id(), parent, tzedaka),
    )
    second_account = new_id()
    ledger.execute(
        """
        INSERT INTO accounts
        (id, connection_id, provider_account_id, name, type, nature, currency,
         include_net, created_at, updated_at)
        VALUES (?, '01a13243-efa9-7b54-b1f7-dea052230fd0', 'second-cash', 'Second cash',
                'cash', 'asset', 'USD', 0, '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')
        """,
        (second_account,),
    )
    transfer_out = _transaction(ledger, "2026-09-05", -1_000, shopping)
    transfer_in = _transaction(ledger, "2026-09-05", 1_000, shopping, account_id=second_account)
    confirm_transfer(ledger, transfer_out, transfer_in)
    current = _transaction(ledger, "2026-10-01", -600, shopping)

    everyone = _planned_category(ledger, "2026-10", shopping, average_months=2)
    assert everyone.historical_average_minor == 280
    assert everyone.actual_minor == 600
    assert everyone.transaction_ids == (current,)
    assert everyone.trend[0].amount_minor == 240
    assert everyone.trend[1].amount_minor == 320

    shared = _planned_category(ledger, "2026-10", shopping, average_months=2, owner="Shared")
    david = _planned_category(ledger, "2026-10", shopping, average_months=2, owner="David")
    ariela = _planned_category(ledger, "2026-10", shopping, average_months=2, owner="Ariela")
    assert (shared.historical_average_minor, shared.actual_minor) == (220, 600)
    assert (david.historical_average_minor, david.actual_minor) == (60, 0)
    assert (ariela.historical_average_minor, ariela.actual_minor) == (0, 0)


def test_average_excludes_unavailable_leading_months_but_keeps_interior_zero(
    ledger: sqlite3.Connection,
) -> None:
    shopping = _category(ledger, "Shopping")
    account_id = _plaid_account(ledger, "2026-07-15")
    _transaction(ledger, "2026-08-10", -1_000, shopping, account_id=account_id)

    snapshot = planning_snapshot(ledger, "2026-10", 12, today=date(2026, 10, 10))
    row = next(item for item in snapshot.categories if item.category_id == shopping)

    assert snapshot.usable_average_months == 2
    assert snapshot.historical_months == ("2026-08", "2026-09")
    assert snapshot.earliest_usable_month == "2026-08"
    assert row.historical_average_minor == 500
    assert [point.amount_minor for point in row.trend] == [1_000, 0]


def test_no_usable_history_and_zero_target_states_are_explicit(
    ledger: sqlite3.Connection,
) -> None:
    shopping = _category(ledger, "Shopping")
    healthcare = _category(ledger, "Healthcare")
    account_id = _plaid_account(ledger, "2026-10-01")
    _transaction(ledger, "2026-10-02", -300, shopping, account_id=account_id)
    _transaction(ledger, "2026-10-03", 100, healthcare, account_id=account_id)

    snapshot = planning_snapshot(ledger, "2026-10", 12, today=date(2026, 10, 10))
    shopping_row = next(item for item in snapshot.categories if item.category_id == shopping)
    healthcare_row = next(item for item in snapshot.categories if item.category_id == healthcare)

    assert snapshot.usable_average_months == 0
    assert snapshot.historical_months == ()
    assert shopping_row.status == "unplanned"
    assert shopping_row.percent_used_basis_points is None
    assert shopping_row.percent_remaining_basis_points is None
    assert healthcare_row.status == "refund"
    assert healthcare_row.projected_minor is None


def test_current_month_calendar_projection_and_status_boundaries(
    ledger: sqlite3.Connection,
) -> None:
    shopping = _category(ledger, "Shopping")
    set_recurring_target(ledger, shopping, 3_100, "2026-10")
    _transaction(ledger, "2026-10-01", -100, shopping)

    first_day = planning_snapshot(ledger, "2026-10", 1, today=date(2026, 10, 1))
    first_row = next(item for item in first_day.categories if item.category_id == shopping)
    assert first_row.projected_minor == 3_100
    assert first_row.status == "close"

    _transaction(ledger, "2026-10-10", -900, shopping)
    tenth_day = planning_snapshot(ledger, "2026-10", 1, today=date(2026, 10, 10))
    tenth_row = next(item for item in tenth_day.categories if item.category_id == shopping)
    assert tenth_row.projected_minor == 3_100
    assert tenth_row.percent_used_basis_points == 3_226
    assert tenth_row.percent_remaining_basis_points == 6_774
    assert tenth_day.projected_spending_minor >= 3_100


def test_six_month_history_uses_median_timing_and_past_month_has_no_forecast(
    ledger: sqlite3.Connection,
) -> None:
    shopping = _category(ledger, "Shopping")
    account_id = _plaid_account(ledger, "2026-03-01")
    for month in range(4, 10):
        _transaction(ledger, f"2026-{month:02d}-05", -500, shopping, account_id=account_id)
        _transaction(ledger, f"2026-{month:02d}-20", -500, shopping, account_id=account_id)
    _transaction(ledger, "2026-10-05", -400, shopping, account_id=account_id)
    set_recurring_target(ledger, shopping, 1_000, "2026-10")

    current = planning_snapshot(ledger, "2026-10", 6, today=date(2026, 10, 10))
    row = next(item for item in current.categories if item.category_id == shopping)
    assert current.usable_average_months == 6
    assert row.projected_minor == 800
    assert row.status == "on_track"

    past = planning_snapshot(ledger, "2026-09", 6, today=date(2026, 10, 10))
    assert next(item for item in past.categories if item.category_id == shopping).projected_minor is None


def _planned_category(
    connection: sqlite3.Connection,
    month: str,
    category_id: str,
    *,
    average_months: int = 1,
    owner: str | None = None,
):
    return next(
        row
        for row in planning_snapshot(connection, month, average_months, owner).categories
        if row.category_id == category_id
    )


def _category(connection: sqlite3.Connection, name: str) -> str:
    return connection.execute("SELECT id FROM categories WHERE name = ?", (name,)).fetchone()[0]


def _plaid_account(connection: sqlite3.Connection, coverage_start: str) -> str:
    institution_id, provider_connection_id, account_id = [new_id() for _ in range(3)]
    now = "2026-10-13T00:00:00Z"
    connection.execute(
        "INSERT INTO institutions VALUES (?, 'plaid', ?, 'Test bank', ?)",
        (institution_id, institution_id, now),
    )
    connection.execute(
        """
        INSERT INTO provider_connections
        (id, provider, external_connection_id, institution_id, status, created_at, updated_at,
         environment, history_available_from)
        VALUES (?, 'plaid', ?, ?, 'active', ?, ?, 'production', ?)
        """,
        (provider_connection_id, provider_connection_id, institution_id, now, now, coverage_start),
    )
    connection.execute(
        """
        INSERT INTO accounts
        (id, connection_id, provider_account_id, name, type, subtype, nature, currency,
         include_budget, spending_owner, created_at, updated_at)
        VALUES (?, ?, ?, 'Test checking', 'depository', 'checking', 'asset', 'USD', 1, 'Shared', ?, ?)
        """,
        (account_id, provider_connection_id, account_id, now, now),
    )
    return account_id


def _transaction(
    connection: sqlite3.Connection,
    local_date: str,
    amount_minor: int,
    category_id: str,
    *,
    owner: str | None = None,
    pending: bool = False,
    tombstoned: bool = False,
    has_splits: bool = False,
    account_id: str = "01a13243-efa9-7b54-b1f7-dea052230fd1",
) -> str:
    transaction_id = new_id()
    connection.execute(
        """
        INSERT INTO transactions
        (id, account_id, local_date, amount_minor, currency, provider_description,
         pending, tombstoned, category_id, category_source, has_splits, spending_owner,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, 'USD', 'Manual test',
                ?, ?, ?, 'manual', ?, ?, '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')
        """,
        (
            transaction_id,
            account_id,
            local_date,
            amount_minor,
            int(pending),
            int(tombstoned),
            category_id,
            int(has_splits),
            owner,
        ),
    )
    return transaction_id
