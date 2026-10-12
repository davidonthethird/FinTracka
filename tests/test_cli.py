from __future__ import annotations

import io
import json

import fintracka.cli as cli_module
from fintracka.cli import main
from fintracka.db import connect, migrate
from fintracka.keychain import KeychainSecrets
from fintracka.google_sheets import google_status
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


def test_configure_google_reads_desktop_client_json_from_stdin(tmp_path, monkeypatch) -> None:
    backend = FakeKeyring()
    secrets = KeychainSecrets(backend)
    monkeypatch.setattr(cli_module, "KeychainSecrets", lambda: secrets)
    client_json = json.dumps(
        {
            "installed": {
                "client_id": "desktop.apps.googleusercontent.com",
                "client_secret": "google-client-secret",
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": ["http://localhost"],
            }
        }
    )
    monkeypatch.setattr(cli_module.sys, "stdin", io.StringIO(client_json))

    assert main(
        ["configure", "google", "--client-json-stdin", "--data-dir", str(tmp_path)]
    ) == 0

    connection = connect(tmp_path / "fintracka.sqlite3")
    assert google_status(connection)["configured"] is True
    assert "google-client-secret" not in "\n".join(connection.iterdump())
    connection.close()


def test_schedule_cli_install_status_and_remove(tmp_path, monkeypatch, capsys) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        cli_module,
        "install_schedule",
        lambda destination, python, data: calls.append(f"install:{data}"),
    )
    monkeypatch.setattr(
        cli_module,
        "schedule_status",
        lambda destination: {"installed": True, "loaded": True},
    )
    monkeypatch.setattr(
        cli_module,
        "remove_schedule",
        lambda destination: calls.append("remove"),
    )

    assert main(["schedule", "install", "--data-dir", str(tmp_path)]) == 0
    assert main(["schedule", "status", "--data-dir", str(tmp_path)]) == 0
    assert main(["schedule", "remove", "--data-dir", str(tmp_path)]) == 0
    assert calls == [f"install:{tmp_path.resolve()}", "remove"]
    assert "installed and loaded" in capsys.readouterr().out


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
