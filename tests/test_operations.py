from __future__ import annotations

import plistlib
from pathlib import Path

import pytest
from openpyxl import load_workbook

from fintracka.backups import backup_database, restore_database
from fintracka.db import connect, migrate
from fintracka.exports import SHEET_ORDER, export_excel, export_google
from fintracka.launchd import build_launch_agent
from fintracka.locks import ProcessLock, ProcessLockError
from fintracka.providers import NormalizedTransaction, SyncBatch
from fintracka.sync import apply_batch
from fintracka.synthetic import create_synthetic_ledger, synthetic_batches


@pytest.fixture
def ledger_path(tmp_path: Path) -> Path:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    apply_batch(connection, connection_id, synthetic_batches([connection_id])[connection_id])
    connection.close()
    return path


def test_backup_is_private_verified_and_restores_into_empty_target(
    ledger_path: Path, tmp_path: Path
) -> None:
    backup = backup_database(ledger_path, tmp_path / "backups", keep=30)
    assert backup.stat().st_mode & 0o777 == 0o600

    source = connect(ledger_path)
    source_count = source.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    source.close()
    restored = tmp_path / "restored" / "ledger.sqlite3"
    restore_database(backup, restored, verify=True)
    connection = connect(restored)
    assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == source_count
    connection.close()


def test_excel_export_is_deterministic_replaces_deleted_rows_and_escapes_formulas(
    ledger_path: Path, tmp_path: Path
) -> None:
    connection = connect(ledger_path)
    connection_id = connection.execute("SELECT id FROM provider_connections").fetchone()[0]
    dangerous = NormalizedTransaction(
        "formula", "checking-1", "2026-10-10T12:00:00Z", -100, "USD", "=HYPERLINK(\"https://evil\")"
    )
    apply_batch(connection, connection_id, SyncBatch(added=(dangerous,), next_checkpoint="export"))
    formula_id = connection.execute(
        "SELECT transaction_id FROM transaction_external_ids WHERE external_id = 'formula'"
    ).fetchone()[0]
    output = tmp_path / "FinTracka.xlsx"
    export_excel(connection, output)

    workbook = load_workbook(output, data_only=False)
    assert workbook.sheetnames == list(SHEET_ORDER)
    assert workbook["_FinTrackaMetadata"].sheet_state == "hidden"
    transaction_rows = list(workbook["Transactions"].values)
    assert len({row[0] for row in transaction_rows[1:]}) == len(transaction_rows) - 1
    formula_row = next(row for row in transaction_rows[1:] if row[0] == formula_id)
    assert formula_row[5].startswith("'=")
    first_rows = transaction_rows
    workbook.close()

    connection.execute("UPDATE transactions SET tombstoned = 1 WHERE id = ?", (formula_id,))
    export_excel(connection, output)
    workbook = load_workbook(output, data_only=False)
    second_rows = list(workbook["Transactions"].values)
    assert formula_id not in {row[0] for row in second_rows[1:]}
    assert second_rows == [row for row in first_rows if row[0] != formula_id]
    workbook.close()
    connection.close()


def test_google_export_replaces_complete_sheets_in_bounded_batches(ledger_path: Path) -> None:
    connection = connect(ledger_path)
    gateway = FakeSheetsGateway()
    export_google(connection, gateway, batch_size=2)
    first = {name: rows[:] for name, rows in gateway.sheets.items() if name != "_FinTrackaMetadata"}
    export_google(connection, gateway, batch_size=2)

    assert tuple(gateway.sheets) == SHEET_ORDER
    assert {name: rows for name, rows in gateway.sheets.items() if name != "_FinTrackaMetadata"} == first
    assert all(size <= 2 for size in gateway.batch_sizes)
    assert gateway.protected == set(SHEET_ORDER)
    connection.close()


def test_process_lock_is_nonblocking_and_launchd_schedule_is_exact(tmp_path: Path) -> None:
    lock_path = tmp_path / "fintracka.lock"
    with ProcessLock(lock_path):
        with pytest.raises(ProcessLockError):
            with ProcessLock(lock_path):
                pass

    payload = plistlib.loads(
        build_launch_agent(Path("/usr/bin/python3"), Path("/tmp/fintracka-data"))
    )
    assert payload["Label"] == "com.fintracka.sync"
    assert payload["StartCalendarInterval"] == {"Hour": 6, "Minute": 17}
    assert payload["RunAtLoad"] is True
    assert payload["ProgramArguments"][-1] == "/tmp/fintracka-data"


class FakeSheetsGateway:
    def __init__(self) -> None:
        self.sheets: dict[str, list[list[object]]] = {}
        self.batch_sizes: list[int] = []
        self.protected: set[str] = set()

    def replace_sheet(self, name: str, rows: list[list[object]], batch_size: int) -> None:
        self.batch_sizes.extend(
            len(rows[index : index + batch_size]) for index in range(0, len(rows), batch_size)
        )
        self.sheets[name] = rows

    def protect_sheet(self, name: str, warning: str) -> None:
        assert "overwritten" in warning
        self.protected.add(name)
