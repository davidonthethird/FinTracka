from __future__ import annotations

from pathlib import Path

from fintracka.backups import backup_database
from fintracka.db import connect, migrate
from fintracka.keychain import KeychainSecrets
from fintracka.plaid_service import configure_plaid
from fintracka.readiness import readiness_report


class FakeKeyring:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}

    def set_password(self, service: str, account: str, password: str) -> None:
        self.values[(service, account)] = password

    def get_password(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def delete_password(self, service: str, account: str) -> None:
        self.values.pop((service, account), None)


def test_readiness_requires_local_controls_but_off_device_backup_is_warning_only(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "fintracka.sqlite3"
    connection = connect(database_path)
    migrate(connection)
    secrets = KeychainSecrets(FakeKeyring())
    configure_plaid(connection, secrets, "production", "client-id", "plaid-secret")
    backup_database(database_path, tmp_path / "backups")

    report = readiness_report(
        connection,
        tmp_path,
        secrets,
        filevault_checker=lambda: True,
        scheduler={"installed": True, "loaded": True},
    )

    assert report["ready"] is True
    checks = {item["id"]: item for item in report["checks"]}
    assert checks["python"]["status"] == "pass"
    assert checks["filevault"]["status"] == "pass"
    assert checks["local_backup"]["status"] == "pass"
    assert checks["plaid"]["status"] == "pass"
    assert checks["off_device_backup"] == {
        "id": "off_device_backup",
        "label": "Off-device backup",
        "status": "warning",
        "blocking": False,
        "detail": "Not configured; accepted testing risk. Hardware loss may make test data unrecoverable.",
    }
    connection.close()


def test_readiness_blocks_live_data_when_filevault_is_off(tmp_path: Path) -> None:
    database_path = tmp_path / "fintracka.sqlite3"
    connection = connect(database_path)
    migrate(connection)
    secrets = KeychainSecrets(FakeKeyring())
    configure_plaid(connection, secrets, "production", "client-id", "plaid-secret")
    backup_database(database_path, tmp_path / "backups")

    report = readiness_report(
        connection,
        tmp_path,
        secrets,
        filevault_checker=lambda: False,
        scheduler={"installed": False, "loaded": False},
    )

    assert report["ready"] is False
    filevault = next(item for item in report["checks"] if item["id"] == "filevault")
    assert filevault["blocking"] is True and filevault["status"] == "fail"
    connection.close()
