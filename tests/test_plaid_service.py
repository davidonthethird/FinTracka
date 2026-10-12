from __future__ import annotations

import sqlite3

import pytest

from fintracka.db import connect, migrate
from fintracka.keychain import KeychainSecrets
from fintracka.plaid_adapter import ConnectedItem, InstitutionInfo, LinkSession
from fintracka.plaid_service import (
    build_plaid_adapter,
    complete_plaid_connection,
    configure_plaid,
    load_plaid_configuration,
    repair_plaid_connection,
    revoke_plaid_connection,
    sync_plaid_connections,
)
from fintracka.providers import NormalizedAccount, NormalizedTransaction, SyncBatch


class FakeKeyring:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}

    def set_password(self, service: str, account: str, password: str) -> None:
        self.values[(service, account)] = password

    def get_password(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def delete_password(self, service: str, account: str) -> None:
        self.values.pop((service, account), None)


def test_configuration_separates_environments_and_keeps_credentials_out_of_sqlite(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    backend = FakeKeyring()
    secrets = KeychainSecrets(backend)

    configure_plaid(connection, secrets, "production", "client-production", "secret-production")
    production = load_plaid_configuration(connection, secrets)
    configure_plaid(connection, secrets, "sandbox", "client-sandbox", "secret-sandbox")
    sandbox = load_plaid_configuration(connection, secrets)

    assert production.environment == "production"
    assert (production.client_id, production.secret) == ("client-production", "secret-production")
    assert sandbox.environment == "sandbox"
    assert (sandbox.client_id, sandbox.secret) == ("client-sandbox", "secret-sandbox")
    assert "client-production" not in "\n".join(connection.iterdump())
    assert "secret-production" not in "\n".join(connection.iterdump())
    assert backend.values[(secrets.service, "plaid:production:secret")] == "secret-production"

    captured: list[tuple[str, str, str]] = []

    def client_factory(client_id: str, secret: str, environment: str):
        captured.append((client_id, secret, environment))
        return object()

    built = build_plaid_adapter(connection, secrets, client_factory)
    assert built.environment == "sandbox"
    assert captured == [("client-sandbox", "secret-sandbox", "sandbox")]


def test_complete_repair_and_revoke_persist_only_sanitized_connection_data(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    adapter = FakeAdapter()

    created = complete_plaid_connection(connection, adapter, "public-token")

    assert set(created) == {"id", "provider", "environment", "status", "institution_name", "updated_at"}
    row = connection.execute(
        "SELECT provider, environment, external_connection_id, status FROM provider_connections WHERE id = ?",
        (created["id"],),
    ).fetchone()
    assert tuple(row) == ("plaid", "production", "item-live", "active")
    assert "access-live" not in "\n".join(connection.iterdump())
    assert repair_plaid_connection(connection, adapter, created["id"]).environment == "production"

    revoke_plaid_connection(connection, adapter, created["id"])
    assert connection.execute(
        "SELECT status FROM provider_connections WHERE id = ?", (created["id"],)
    ).fetchone()[0] == "revoked"
    assert len(adapter.revoked) == 1
    revoke_plaid_connection(connection, adapter, created["id"])
    assert len(adapter.revoked) == 1


def test_duplicate_completion_revokes_partial_item_and_sync_is_idempotent(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    adapter = FakeAdapter()
    created = complete_plaid_connection(connection, adapter, "public-token")

    with pytest.raises(sqlite3.IntegrityError):
        complete_plaid_connection(connection, adapter, "public-token")
    assert len(adapter.revoked) == 1

    first = sync_plaid_connections(connection, adapter)
    second = sync_plaid_connections(connection, adapter)
    assert len(first) == len(second) == 1
    assert connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 1
    assert connection.execute(
        "SELECT cursor FROM provider_checkpoints WHERE connection_id = ?", (created["id"],)
    ).fetchone()[0] == "cursor-live"


class FakeAdapter:
    environment = "production"

    def __init__(self) -> None:
        self.references: list[str] = []
        self.revoked: list[str] = []

    def complete_link(self, public_token: str, secret_reference: str) -> ConnectedItem:
        assert public_token == "public-token"
        self.references.append(secret_reference)
        return ConnectedItem("item-live", secret_reference)

    def connection_info(self, secret_reference: str) -> InstitutionInfo:
        assert secret_reference in self.references
        return InstitutionInfo("ins_live", "Live Bank")

    def repair_connection(self, secret_reference: str) -> LinkSession:
        assert secret_reference in self.references
        return LinkSession("repair-token", "2026-10-13T00:00:00Z", self.environment)

    def revoke(self, secret_reference: str) -> None:
        self.revoked.append(secret_reference)

    def fetch_updates(self, secret_reference: str, checkpoint: str | None) -> SyncBatch:
        assert secret_reference in self.references
        return SyncBatch(
            accounts=(
                NormalizedAccount("checking-live", "Checking", "depository", "checking", "asset"),
            ),
            added=(
                NormalizedTransaction(
                    "txn-live",
                    "checking-live",
                    "2026-10-12T12:00:00Z",
                    -1234,
                    "USD",
                    "Live purchase",
                ),
            ),
            next_checkpoint="cursor-live",
        )
