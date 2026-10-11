from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from fintracka.ids import new_id
from fintracka.providers import NormalizedAccount, NormalizedBalance, NormalizedTransaction, SyncBatch


def create_synthetic_ledger(connection: sqlite3.Connection, count: int = 3) -> list[str]:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    connection_ids: list[str] = []
    for index in range(1, count + 1):
        institution_id = new_id()
        connection_id = new_id()
        connection.execute(
            "INSERT OR IGNORE INTO institutions (id, provider, external_id, name, created_at) VALUES (?, 'synthetic', ?, ?, ?)",
            (institution_id, f"bank-{index}", f"Synthetic Bank {index}", now),
        )
        actual_institution = connection.execute(
            "SELECT id FROM institutions WHERE provider = 'synthetic' AND external_id = ?",
            (f"bank-{index}",),
        ).fetchone()[0]
        connection.execute(
            "INSERT OR IGNORE INTO provider_connections (id, provider, external_connection_id, institution_id, status, created_at, updated_at) VALUES (?, 'synthetic', ?, ?, 'active', ?, ?)",
            (connection_id, f"connection-{index}", actual_institution, now, now),
        )
        actual_connection = connection.execute(
            "SELECT id FROM provider_connections WHERE provider = 'synthetic' AND external_connection_id = ?",
            (f"connection-{index}",),
        ).fetchone()[0]
        connection_ids.append(actual_connection)
        _seed_account(connection, actual_connection, f"checking-{index}", "Checking", "checking", "asset", now)
    return connection_ids


def synthetic_batches(connection_ids: list[str]) -> dict[str, SyncBatch]:
    batches: dict[str, SyncBatch] = {}
    for index, connection_id in enumerate(connection_ids, start=1):
        accounts = [
            NormalizedAccount(f"checking-{index}", "Everyday Checking", "depository", "checking", "asset", mask=f"10{index:02d}"),
        ]
        if index in (1, 3):
            accounts.append(NormalizedAccount(f"savings-{index}", "Savings", "depository", "savings", "asset", mask=f"20{index:02d}"))
        accounts.append(NormalizedAccount(f"card-{index}", "Rewards Card", "credit", "credit_card", "liability", mask=f"30{index:02d}"))
        balances = tuple(
            NormalizedBalance(
                account.external_id,
                "2026-10-11T12:00:00Z",
                250_000 if account.nature == "asset" else 42_000,
            )
            for account in accounts
        )
        transactions = (
            NormalizedTransaction(
                f"paycheck-{index}",
                f"checking-{index}",
                "2026-10-01T13:00:00Z",
                325_000,
                "USD",
                "ACME PAYROLL",
                "Acme Payroll",
            ),
            NormalizedTransaction(
                f"groceries-{index}",
                f"checking-{index}",
                "2026-10-03T20:00:00Z",
                -8_742,
                "USD",
                "MARKET 0042",
                "Neighborhood Market",
            ),
        )
        batches[connection_id] = SyncBatch(
            accounts=tuple(accounts),
            balances=balances,
            added=transactions,
            next_checkpoint=f"cursor-{index}",
        )
    return batches


def _seed_account(
    connection: sqlite3.Connection,
    connection_id: str,
    external_id: str,
    name: str,
    subtype: str,
    nature: str,
    now: str,
) -> None:
    connection.execute(
        "INSERT OR IGNORE INTO accounts (id, connection_id, provider_account_id, name, type, subtype, nature, currency, created_at, updated_at) VALUES (?, ?, ?, ?, 'depository', ?, ?, 'USD', ?, ?)",
        (new_id(), connection_id, external_id, name, subtype, nature, now, now),
    )
