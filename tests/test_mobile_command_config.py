from __future__ import annotations

import sqlite3

import pytest

from fintracka.db import connect, migrate
from fintracka.keychain import KeychainSecrets
from fintracka.mobile_command_config import (
    configure_mobile_commands,
    load_mobile_command_settings,
    set_mobile_commands_enabled,
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


def test_mobile_command_settings_default_disabled_and_receipts_are_permanent(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)

    settings = load_mobile_command_settings(connection)
    assert settings.enabled is False
    assert settings.gateway_url is None
    assert connection.execute("SELECT COUNT(*) FROM mobile_command_receipts").fetchone()[0] == 0
    assert connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 20


def test_configuration_uses_distinct_keychain_refs_and_keeps_secrets_out_of_sqlite(tmp_path) -> None:
    database_path = tmp_path / "ledger.sqlite3"
    connection = connect(database_path)
    migrate(connection)
    backend = FakeKeyring()

    settings = configure_mobile_commands(
        connection,
        KeychainSecrets(backend),
        gateway_url="https://viewer.example.test",
        access_client_id="command-client-id.access",
        access_client_secret="command-client-secret",
    )

    assert settings.enabled is False
    assert settings.gateway_url == "https://viewer.example.test"
    assert settings.access_client_id_ref != settings.access_client_secret_ref
    assert settings.access_client_id_ref and settings.access_client_id_ref.startswith("mobile-commands:")
    dump = "\n".join(connection.iterdump())
    assert "command-client-id.access" not in dump
    assert "command-client-secret" not in dump
    assert set(backend.values) == {
        (KeychainSecrets.service, settings.access_client_id_ref),
        (KeychainSecrets.service, settings.access_client_secret_ref),
    }
    assert set_mobile_commands_enabled(connection, True).enabled is True
    assert set_mobile_commands_enabled(connection, False).enabled is False


@pytest.mark.parametrize(
    "url",
    [
        "http://viewer.example.test",
        "https://user:secret@viewer.example.test",
        "https://viewer.example.test/path?secret=yes",
        "https://viewer.example.test/#fragment",
    ],
)
def test_configuration_rejects_unsafe_gateway_urls(tmp_path, url: str) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    with pytest.raises(ValueError, match="HTTPS"):
        configure_mobile_commands(
            connection,
            KeychainSecrets(FakeKeyring()),
            gateway_url=url,
            access_client_id="id",
            access_client_secret="secret",
        )


def test_enable_requires_complete_configuration(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    with pytest.raises(ValueError, match="configured"):
        set_mobile_commands_enabled(connection, True)


def test_configuration_failure_keeps_old_refs_and_deletes_new_secrets(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    backend = FakeKeyring()
    secrets = KeychainSecrets(backend)
    before = configure_mobile_commands(
        connection,
        secrets,
        gateway_url="https://old.example.test",
        access_client_id="old-id",
        access_client_secret="old-secret",
    )
    old_refs = set(backend.values)
    connection.execute(
        """
        CREATE TRIGGER reject_mobile_config BEFORE INSERT ON audit_events
        WHEN NEW.action = 'mobile_commands_configure'
        BEGIN SELECT RAISE(ABORT, 'forced failure'); END
        """
    )

    with pytest.raises(sqlite3.IntegrityError, match="forced failure"):
        configure_mobile_commands(
            connection,
            secrets,
            gateway_url="https://new.example.test",
            access_client_id="new-id",
            access_client_secret="new-secret",
        )

    assert load_mobile_command_settings(connection) == before
    assert set(backend.values) == old_refs
    assert len(backend.deleted) == 2
