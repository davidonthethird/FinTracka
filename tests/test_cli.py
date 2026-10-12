from __future__ import annotations

import io

import fintracka.cli as cli_module
from fintracka.cli import main
from fintracka.db import connect, migrate
from fintracka.keychain import KeychainSecrets
from fintracka.plaid_adapter import ConnectedItem, InstitutionInfo
from fintracka.plaid_service import complete_plaid_connection, load_plaid_configuration
from fintracka.providers import NormalizedAccount, NormalizedTransaction, SyncBatch


def test_configure_plaid_reads_secret_from_stdin_and_sync_uses_provider(tmp_path, monkeypatch) -> None:
    backend = FakeKeyring()
    secrets = KeychainSecrets(backend)
    monkeypatch.setattr(cli_module, "KeychainSecrets", lambda: secrets)
    monkeypatch.setattr(cli_module.sys, "stdin", io.StringIO("secret-production\n"))

    assert main(
        [
            "configure",
            "plaid",
            "--environment",
            "production",
            "--client-id",
            "client-production",
            "--secret-stdin",
            "--data-dir",
            str(tmp_path),
        ]
    ) == 0

    connection = connect(tmp_path / "fintracka.sqlite3")
    migrate(connection)
    assert load_plaid_configuration(connection, secrets).environment == "production"
    adapter = FakeAdapter()
    complete_plaid_connection(connection, adapter, "public-token")
    connection.close()
    monkeypatch.setattr(cli_module, "build_plaid_adapter", lambda connection, secrets: adapter)

    assert main(["sync", "--data-dir", str(tmp_path)]) == 0
    connection = connect(tmp_path / "fintracka.sqlite3")
    assert connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 1


class FakeKeyring:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}

    def set_password(self, service: str, account: str, password: str) -> None:
        self.values[(service, account)] = password

    def get_password(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def delete_password(self, service: str, account: str) -> None:
        self.values.pop((service, account), None)


class FakeAdapter:
    environment = "production"

    def __init__(self) -> None:
        self.references: list[str] = []

    def complete_link(self, public_token: str, secret_reference: str) -> ConnectedItem:
        self.references.append(secret_reference)
        return ConnectedItem("item-cli", secret_reference)

    def connection_info(self, secret_reference: str) -> InstitutionInfo:
        return InstitutionInfo("ins_cli", "CLI Bank")

    def revoke(self, secret_reference: str) -> None:
        pass

    def fetch_updates(self, secret_reference: str, checkpoint: str | None) -> SyncBatch:
        return SyncBatch(
            accounts=(NormalizedAccount("checking-cli", "Checking", "depository", "checking", "asset"),),
            added=(
                NormalizedTransaction(
                    "txn-cli", "checking-cli", "2026-10-12T12:00:00Z", -500, "USD", "CLI purchase"
                ),
            ),
            next_checkpoint="cursor-cli",
        )
