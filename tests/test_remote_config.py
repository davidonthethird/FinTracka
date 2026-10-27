from __future__ import annotations

import sqlite3

import pytest

from fintracka.db import connect, migrate
from fintracka.keychain import KeychainSecrets
from fintracka.remote_config import (
    configure_remote,
    finish_remote_run,
    load_remote_settings,
    reserve_remote_sequence,
    start_remote_run,
)


class FakeKeyring:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}
        self.deleted: list[str] = []

    def set_password(self, service: str, account: str, password: str) -> None:
        self.values[(service, account)] = password

    def get_password(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def delete_password(self, service: str, account: str) -> None:
        self.deleted.append(account)
        self.values.pop((service, account), None)


def test_remote_settings_default_disabled_and_configuration_keeps_secrets_out_of_sqlite(
    tmp_path,
) -> None:
    database_path = tmp_path / "ledger.sqlite3"
    connection = connect(database_path)
    migrate(connection)
    initial = load_remote_settings(connection)
    assert (initial.enabled, initial.history_months, initial.interval_minutes) == (False, 6, 60)
    assert initial.viewer_url is None

    backend = FakeKeyring()
    configured = configure_remote(
        connection,
        KeychainSecrets(backend),
        viewer_url="https://viewer.example.test",
        publisher_url="https://publisher.example.test/v1/snapshots",
        access_client_id="client-id-secret-too",
        access_client_secret="access-secret-value",
        history_months=4,
        interval_minutes=90,
    )

    assert configured.enabled is True
    assert configured.viewer_url == "https://viewer.example.test"
    assert configured.publisher_url == "https://publisher.example.test/v1/snapshots"
    assert (configured.history_months, configured.interval_minutes) == (4, 90)
    assert configured.access_client_id_ref in {account for _, account in backend.values}
    assert configured.access_client_secret_ref in {account for _, account in backend.values}
    dump = "\n".join(connection.iterdump())
    assert "client-id-secret-too" not in dump
    assert "access-secret-value" not in dump
    assert "access-secret-value" not in database_path.read_bytes().decode("utf-8", errors="ignore")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("viewer_url", "http://viewer.example.test"),
        ("viewer_url", "https://user:password@viewer.example.test"),
        ("publisher_url", "https://publisher.example.test/path#fragment"),
        ("history_months", 0),
        ("history_months", 7),
        ("interval_minutes", 14),
        ("interval_minutes", 1441),
    ],
)
def test_remote_configuration_rejects_unsafe_urls_and_out_of_range_values(
    tmp_path, field: str, value: str | int
) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    values: dict[str, object] = {
        "viewer_url": "https://viewer.example.test",
        "publisher_url": "https://publisher.example.test/v1/snapshots",
        "access_client_id": "client-id",
        "access_client_secret": "client-secret",
        "history_months": 6,
        "interval_minutes": 60,
    }
    values[field] = value

    with pytest.raises(ValueError):
        configure_remote(connection, KeychainSecrets(FakeKeyring()), **values)  # type: ignore[arg-type]


def test_remote_sequence_and_run_state_are_monotonic_and_redacted(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)

    assert reserve_remote_sequence(connection) == 1
    assert reserve_remote_sequence(connection) == 2
    run_id = start_remote_run(connection, "manual", 2)
    finish_remote_run(
        connection,
        run_id,
        status="failed",
        error_code="REMOTE_TIMEOUT",
    )

    row = connection.execute(
        "SELECT reason, source_sequence, status, snapshot_id, error_code, finished_at "
        "FROM remote_publication_runs WHERE id = ?",
        (run_id,),
    ).fetchone()
    assert tuple(row)[:5] == ("manual", 2, "failed", None, "REMOTE_TIMEOUT")
    assert row["finished_at"].endswith("Z")
    assert load_remote_settings(connection).last_error_code == "REMOTE_TIMEOUT"

    with pytest.raises(ValueError, match="error code"):
        finish_remote_run(connection, run_id, status="failed", error_code="secret=do-not-store")
    assert "do-not-store" not in "\n".join(connection.iterdump())


def test_remote_configuration_failure_restores_previous_refs_and_deletes_new_secrets(
    tmp_path,
) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    backend = FakeKeyring()
    secrets = KeychainSecrets(backend)
    before = configure_remote(
        connection,
        secrets,
        viewer_url="https://old-viewer.example.test",
        publisher_url="https://old-publisher.example.test/v1/snapshots",
        access_client_id="old-client",
        access_client_secret="old-secret",
    )
    old_refs = set(backend.values)
    connection.execute(
        """
        CREATE TRIGGER reject_remote_configure BEFORE INSERT ON audit_events
        WHEN NEW.action = 'remote_configure'
        BEGIN SELECT RAISE(ABORT, 'forced remote configuration failure'); END
        """
    )

    with pytest.raises(sqlite3.IntegrityError, match="forced remote configuration failure"):
        configure_remote(
            connection,
            secrets,
            viewer_url="https://new-viewer.example.test",
            publisher_url="https://new-publisher.example.test/v1/snapshots",
            access_client_id="new-client",
            access_client_secret="new-secret",
        )

    assert load_remote_settings(connection) == before
    assert set(backend.values) == old_refs
    assert len(backend.deleted) == 2
    assert all(reference not in old_refs for reference in backend.deleted)


def test_remote_run_rejects_unrecognized_reason_status_and_missing_run(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)

    with pytest.raises(ValueError, match="reason"):
        start_remote_run(connection, "browser", 1)
    run_id = start_remote_run(connection, "startup", 1)
    with pytest.raises(ValueError, match="status"):
        finish_remote_run(connection, run_id, status="maybe")
    with pytest.raises(ValueError, match="not found"):
        finish_remote_run(connection, "missing", status="failed", error_code="REMOTE_ERROR")
