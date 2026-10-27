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


def test_configure_plaid_profiles_and_sync_routes_every_connection(
    tmp_path, monkeypatch, capsys
) -> None:
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
    david_output = capsys.readouterr().out
    assert "David" in david_output and "production" in david_output
    assert "client-production" not in david_output and "secret-production" not in david_output

    monkeypatch.setattr(cli_module.sys, "stdin", io.StringIO("secret-ariela\n"))
    assert main(
        [
            "configure",
            "plaid",
            "--profile",
            "ariela",
            "--environment",
            "sandbox",
            "--client-id",
            "client-ariela",
            "--secret-stdin",
            "--data-dir",
            str(tmp_path),
        ]
    ) == 0
    ariela_output = capsys.readouterr().out
    assert "Ariela" in ariela_output and "sandbox" in ariela_output
    assert "client-ariela" not in ariela_output and "secret-ariela" not in ariela_output

    connection = connect(tmp_path / "fintracka.sqlite3")
    migrate(connection)
    assert load_plaid_configuration(connection, secrets, "david").environment == "production"
    assert load_plaid_configuration(connection, secrets, "ariela").environment == "sandbox"
    adapters = {
        ("david", "production"): FakeAdapter("david", "production"),
        ("ariela", "sandbox"): FakeAdapter("ariela", "sandbox"),
    }
    complete_plaid_connection(connection, adapters[("david", "production")], "public-token", "david")
    complete_plaid_connection(connection, adapters[("ariela", "sandbox")], "public-token", "ariela")
    connection.close()
    calls: list[tuple[str, str]] = []

    def build(connection, secrets, profile, environment):  # type: ignore[no-untyped-def]
        del connection, secrets
        calls.append((profile, environment))
        return adapters[(profile, environment)]

    monkeypatch.setattr(
        cli_module,
        "build_plaid_adapter",
        build,
    )

    assert main(["sync", "--data-dir", str(tmp_path)]) == 0
    connection = connect(tmp_path / "fintracka.sqlite3")
    assert connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 2
    assert calls == [("david", "production"), ("ariela", "sandbox")]


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


def test_open_in_chrome_uses_macos_open_without_shell(monkeypatch) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(cli_module.subprocess, "Popen", lambda command: calls.append(command))

    cli_module._open_in_chrome("http://127.0.0.1:8787/#bootstrap=local")

    assert calls == [["open", "-a", "Google Chrome", "http://127.0.0.1:8787/#bootstrap=local"]]


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
    def __init__(self, profile: str, environment: str) -> None:
        self.profile = profile
        self.environment = environment
        self.references: list[str] = []

    def complete_link(self, public_token: str, secret_reference: str) -> ConnectedItem:
        self.references.append(secret_reference)
        return ConnectedItem(f"item-cli-{self.profile}", secret_reference)

    def connection_info(self, secret_reference: str) -> InstitutionInfo:
        return InstitutionInfo(f"ins-cli-{self.profile}", f"{self.profile.title()} CLI Bank")

    def revoke(self, secret_reference: str) -> None:
        pass

    def fetch_updates(self, secret_reference: str, checkpoint: str | None) -> SyncBatch:
        return SyncBatch(
            accounts=(NormalizedAccount(f"checking-cli-{self.profile}", "Checking", "depository", "checking", "asset"),),
            added=(
                NormalizedTransaction(
                    f"txn-cli-{self.profile}", f"checking-cli-{self.profile}", "2026-10-12T12:00:00Z", -500, "USD", "CLI purchase"
                ),
            ),
            next_checkpoint="cursor-cli",
        )
