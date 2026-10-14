from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import uvicorn

from fintracka.api import create_app
from fintracka.db import connect, migrate
from fintracka.providers import NormalizedTransaction, SyncBatch
from fintracka.synthetic import create_synthetic_ledger, synthetic_batches
from fintracka.sync import apply_batch


def seed_database(path: Path) -> None:
    connection = connect(path)
    migrate(connection)
    connection_ids = create_synthetic_ledger(connection, demo=True)
    for connection_id, batch in synthetic_batches(connection_ids).items():
        apply_batch(connection, connection_id, batch)
    apply_batch(
        connection,
        connection_ids[0],
        SyncBatch(
            added=(NormalizedTransaction(
                "transfer-out", "checking-1", "2026-10-08T12:00:00Z", -5_000, "USD",
                "TRANSFER TO SAVINGS", provider_category_primary="TRANSFER_OUT",
            ),),
            next_checkpoint="browser-transfer-out",
        ),
    )
    apply_batch(
        connection,
        connection_ids[1],
        SyncBatch(
            added=(NormalizedTransaction(
                "transfer-in", "checking-2", "2026-10-08T12:00:00Z", 5_000, "USD",
                "TRANSFER FROM CHECKING", provider_category_primary="TRANSFER_IN",
            ),),
            next_checkpoint="browser-transfer-in",
        ),
    )
    archive_rows = tuple(
        NormalizedTransaction(
            f"archive-{index}",
            "checking-1",
            f"2026-09-{(index % 28) + 1:02d}T{index % 24:02d}:00:00Z",
            -100 - index,
            "USD",
            f"ARCHIVE FIXTURE {index:03d}",
        )
        for index in range(105)
    )
    apply_batch(
        connection,
        connection_ids[0],
        SyncBatch(added=archive_rows, next_checkpoint="browser-archive"),
    )
    apply_batch(
        connection,
        connection_ids[0],
        SyncBatch(
            added=(
                NormalizedTransaction(
                    "browser-lowes", "checking-1", "2026-10-12T12:00:00Z", -8_500,
                    "USD", "LOWE'S", "LOWE'S", provider_category_primary="GENERAL_MERCHANDISE",
                    provider_category_detailed="GENERAL_MERCHANDISE_HOME_IMPROVEMENT",
                ),
                NormalizedTransaction(
                    "browser-macys", "checking-1", "2026-10-11T12:00:00Z", -12_500,
                    "USD", "MACY'S", "MACY'S", provider_category_primary="GENERAL_MERCHANDISE",
                    provider_category_detailed="GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES",
                ),
                NormalizedTransaction(
                    "browser-atm", "checking-1", "2026-10-10T12:00:00Z", -5_100,
                    "USD", "ATM WITHDRAWAL", is_cash_withdrawal=True,
                ),
            ),
            next_checkpoint="browser-subcategories",
        ),
    )
    connection.execute(
        "UPDATE provider_connections SET status = 'repair', last_error_code = 'ITEM_LOGIN_REQUIRED' WHERE id = ?",
        (connection_ids[2],),
    )
    connection.close()


if __name__ == "__main__":
    temporary = None
    if len(sys.argv) > 1:
        database_path = Path(sys.argv[1])
    else:
        temporary = tempfile.TemporaryDirectory(prefix="fintracka-browser-")
        database_path = Path(temporary.name) / "fintracka.sqlite3"
        seed_database(database_path)
    try:
        uvicorn.run(
            create_app(database_path, bootstrap_token="browser-test-token"),
            host="127.0.0.1",
            port=8787,
            log_level="warning",
        )
    finally:
        if temporary is not None:
            temporary.cleanup()
