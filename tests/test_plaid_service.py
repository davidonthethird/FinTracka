from __future__ import annotations

import sqlite3

import pytest

from fintracka.db import connect, migrate
from fintracka.keychain import KeychainSecrets
from fintracka.plaid_adapter import (
    ConnectedItem,
    InstitutionInfo,
    LinkSession,
    ProviderActionRequired,
)
from fintracka.plaid_service import (
    PlaidNotConfigured,
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
        self.deleted: list[str] = []

    def set_password(self, service: str, account: str, password: str) -> None:
        self.values[(service, account)] = password

    def get_password(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def delete_password(self, service: str, account: str) -> None:
        self.deleted.append(account)
        self.values.pop((service, account), None)


def test_configuration_separates_profiles_and_environments_without_storing_secrets(
    tmp_path,
) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    backend = FakeKeyring()
    secrets = KeychainSecrets(backend)

    configure_plaid(
        connection, secrets, "david", "production", "david-production", "david-secret"
    )
    configure_plaid(
        connection, secrets, "david", "sandbox", "david-sandbox", "david-sandbox-secret"
    )
    configure_plaid(
        connection, secrets, "ariela", "production", "ariela-production", "ariela-secret"
    )

    david_selected = load_plaid_configuration(connection, secrets, "david")
    david_production = load_plaid_configuration(connection, secrets, "david", "production")
    ariela = load_plaid_configuration(connection, secrets, "ariela")

    assert (david_selected.profile, david_selected.environment) == ("david", "sandbox")
    assert (david_selected.client_id, david_selected.secret) == (
        "david-sandbox",
        "david-sandbox-secret",
    )
    assert (david_production.client_id, david_production.secret) == (
        "david-production",
        "david-secret",
    )
    assert (ariela.profile, ariela.environment) == ("ariela", "production")
    assert (ariela.client_id, ariela.secret) == ("ariela-production", "ariela-secret")
    dump = "\n".join(connection.iterdump())
    for value in (
        "david-production",
        "david-secret",
        "david-sandbox",
        "david-sandbox-secret",
        "ariela-production",
        "ariela-secret",
    ):
        assert value not in dump
    assert all(reference.startswith("plaid:profile:") for _, reference in backend.values)

    with pytest.raises(ValueError, match="profile"):
        load_plaid_configuration(connection, secrets, "nobody")  # type: ignore[arg-type]
    with pytest.raises(PlaidNotConfigured):
        load_plaid_configuration(connection, secrets, "ariela", "sandbox")

    captured: list[tuple[str, str, str]] = []

    def client_factory(client_id: str, secret: str, environment: str):
        captured.append((client_id, secret, environment))
        return object()

    built = build_plaid_adapter(connection, secrets, "ariela", "production", client_factory)
    assert built.environment == "production"
    assert captured == [("ariela-production", "ariela-secret", "production")]


def test_configuration_rollback_keeps_previous_references_and_deletes_new_keychain_values(
    tmp_path,
) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    backend = FakeKeyring()
    secrets = KeychainSecrets(backend)
    configure_plaid(connection, secrets, "david", "production", "old-client", "old-secret")
    old = load_plaid_configuration(connection, secrets, "david")
    old_references = set(backend.values)
    connection.execute(
        """
        CREATE TRIGGER reject_plaid_configure BEFORE INSERT ON audit_events
        WHEN NEW.action = 'plaid_configure'
        BEGIN SELECT RAISE(ABORT, 'forced configuration failure'); END
        """
    )

    with pytest.raises(sqlite3.IntegrityError, match="forced configuration failure"):
        configure_plaid(connection, secrets, "david", "production", "new-client", "new-secret")

    assert load_plaid_configuration(connection, secrets, "david") == old
    assert set(backend.values) == old_references
    assert len(backend.deleted) == 2
    assert all(reference not in old_references for reference in backend.deleted)


def test_complete_repair_and_revoke_persist_only_sanitized_connection_data(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    adapter = FakeAdapter()

    created = complete_plaid_connection(connection, adapter, "public-token", "david")

    assert set(created) == {
        "id",
        "provider",
        "environment",
        "credential_profile",
        "status",
        "institution_name",
        "updated_at",
    }
    row = connection.execute(
        "SELECT provider, environment, credential_profile, external_connection_id, status FROM provider_connections WHERE id = ?",
        (created["id"],),
    ).fetchone()
    assert tuple(row) == ("plaid", "production", "david", "item-live", "active")
    assert "access-live" not in "\n".join(connection.iterdump())
    factory_calls: list[tuple[str, str]] = []

    def factory(profile: str, environment: str) -> FakeAdapter:
        factory_calls.append((profile, environment))
        return adapter

    assert repair_plaid_connection(connection, factory, created["id"]).environment == "production"

    revoke_plaid_connection(connection, factory, created["id"])
    assert connection.execute(
        "SELECT status FROM provider_connections WHERE id = ?", (created["id"],)
    ).fetchone()[0] == "revoked"
    assert len(adapter.revoked) == 1
    revoke_plaid_connection(connection, factory, created["id"])
    assert len(adapter.revoked) == 1
    assert factory_calls == [("david", "production"), ("david", "production")]


def test_duplicate_completion_revokes_partial_item_and_sync_is_idempotent(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    adapter = FakeAdapter()
    created = complete_plaid_connection(connection, adapter, "public-token", "ariela")

    with pytest.raises(sqlite3.IntegrityError):
        complete_plaid_connection(connection, adapter, "public-token", "ariela")
    assert len(adapter.revoked) == 1

    calls: list[tuple[str, str]] = []

    def factory(profile: str, environment: str) -> FakeAdapter:
        calls.append((profile, environment))
        return adapter

    first = sync_plaid_connections(connection, factory)
    second = sync_plaid_connections(connection, factory)
    assert len(first) == len(second) == 1
    assert calls == [("ariela", "production"), ("ariela", "production")]
    assert connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 1
    assert connection.execute(
        "SELECT cursor FROM provider_checkpoints WHERE connection_id = ?", (created["id"],)
    ).fetchone()[0] == "cursor-live"


def test_mixed_profile_sync_attempts_every_connection_and_preserves_failed_checkpoint(
    tmp_path,
) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    adapters = {
        ("david", "production"): FakeAdapter(item_id="item-david", transaction_id="txn-david"),
        ("ariela", "sandbox"): FakeAdapter(
            environment="sandbox",
            item_id="item-ariela-sandbox",
            transaction_id="txn-ariela-sandbox",
            failure=ProviderActionRequired("repair required"),
        ),
        ("ariela", "production"): FakeAdapter(
            item_id="item-ariela-production", transaction_id="txn-ariela-production"
        ),
    }
    created = [
        complete_plaid_connection(connection, adapters[key], "public-token", key[0])
        for key in adapters
    ]
    failed_id = created[1]["id"]
    connection.execute(
        "INSERT INTO provider_checkpoints (connection_id, cursor, updated_at) VALUES (?, 'cursor-before', '2026-10-26T00:00:00Z')",
        (failed_id,),
    )
    calls: list[tuple[str, str]] = []

    def factory(profile: str, environment: str) -> FakeAdapter:
        key = (profile, environment)
        calls.append(key)
        return adapters[key]

    with pytest.raises(RuntimeError, match="1 Plaid connection sync") as raised:
        sync_plaid_connections(connection, factory)

    assert calls == list(adapters)
    assert connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 2
    assert connection.execute(
        "SELECT cursor FROM provider_checkpoints WHERE connection_id = ?", (failed_id,)
    ).fetchone()[0] == "cursor-before"
    assert tuple(
        connection.execute(
            "SELECT status, last_error_code FROM provider_connections WHERE id = ?", (failed_id,)
        ).fetchone()
    ) == ("repair", "ITEM_REPAIR_REQUIRED")
    assert "repair required" not in str(raised.value)


def test_missing_profile_credentials_never_fall_back_or_expose_secret_values(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    adapter = FakeAdapter(item_id="item-ariela", transaction_id="txn-ariela")
    complete_plaid_connection(connection, adapter, "public-token", "ariela")
    calls: list[tuple[str, str]] = []

    def factory(profile: str, environment: str) -> FakeAdapter:
        calls.append((profile, environment))
        raise PlaidNotConfigured("missing ariela-secret access-live")

    with pytest.raises(RuntimeError) as raised:
        sync_plaid_connections(connection, factory)

    assert calls == [("ariela", "production")]
    assert "ariela-secret" not in str(raised.value)
    assert "access-live" not in str(raised.value)
    assert connection.execute(
        "SELECT last_error_code FROM provider_connections WHERE provider = 'plaid'"
    ).fetchone()[0] == "PLAID_NOT_CONFIGURED"


class FakeAdapter:
    def __init__(
        self,
        *,
        environment: str = "production",
        item_id: str = "item-live",
        transaction_id: str = "txn-live",
        failure: Exception | None = None,
    ) -> None:
        self.environment = environment
        self.item_id = item_id
        self.transaction_id = transaction_id
        self.failure = failure
        self.references: list[str] = []
        self.revoked: list[str] = []

    def complete_link(self, public_token: str, secret_reference: str) -> ConnectedItem:
        assert public_token == "public-token"
        self.references.append(secret_reference)
        return ConnectedItem(self.item_id, secret_reference)

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
        if self.failure is not None:
            raise self.failure
        return SyncBatch(
            accounts=(
                NormalizedAccount("checking-live", "Checking", "depository", "checking", "asset"),
            ),
            added=(
                NormalizedTransaction(
                    self.transaction_id,
                    "checking-live",
                    "2026-10-12T12:00:00Z",
                    -1234,
                    "USD",
                    "Live purchase",
                ),
            ),
            next_checkpoint="cursor-live",
        )
