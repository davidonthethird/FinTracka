from __future__ import annotations

import sqlite3

from fintracka.savings_goals import (
    reconcile_savings_draws,
    reconcile_savings_transactions,
)


def reconcile_financial_mutations(
    connection: sqlite3.Connection,
    transaction_ids: list[str] | None = None,
) -> None:
    """Run the shared Savings side effects after a financial mutation."""
    settings = connection.execute(
        "SELECT activation_month FROM savings_settings WHERE id = 1"
    ).fetchone()
    if settings is None:
        return
    through_month = connection.execute(
        "SELECT COALESCE(MAX(substr(local_date, 1, 7)), ?) FROM transactions",
        (settings["activation_month"],),
    ).fetchone()[0]
    reconcile_savings_draws(
        connection,
        max(settings["activation_month"], through_month),
    )
    if transaction_ids:
        reconcile_savings_transactions(connection, transaction_ids)
