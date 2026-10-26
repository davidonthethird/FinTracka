from __future__ import annotations

import sqlite3
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

from fintracka.backups import verify_backup
from fintracka.google_sheets import google_status
from fintracka.keychain import KeychainSecrets, SecretStoreUnavailable
from fintracka.plaid_service import PLAID_PROFILES, PlaidNotConfigured, load_plaid_configuration


def filevault_enabled() -> bool:
    try:
        result = subprocess.run(
            ["fdesetup", "status"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and result.stdout.strip() == "FileVault is On."


def readiness_report(
    connection: sqlite3.Connection,
    data_directory: Path,
    secrets: KeychainSecrets,
    *,
    filevault_checker: Callable[[], bool] = filevault_enabled,
    scheduler: dict[str, bool] | None = None,
) -> dict[str, object]:
    checks: list[dict[str, object]] = []

    python_ok = sys.version_info[:2] == (3, 14)
    checks.append(
        _check(
            "python",
            "Python runtime",
            python_ok,
            True,
            f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "Python 3.14.x is required for live financial data.",
        )
    )
    vault_ok = filevault_checker()
    checks.append(
        _check(
            "filevault",
            "FileVault",
            vault_ok,
            True,
            "Enabled for this Mac.",
            "FileVault must be enabled before a live bank connection.",
        )
    )
    try:
        secrets.get("fintracka:readiness:probe")
        keychain_ok = True
    except SecretStoreUnavailable:
        keychain_ok = False
    checks.append(
        _check(
            "keychain",
            "macOS Keychain",
            keychain_ok,
            True,
            "Available to FinTracka.",
            "Keychain is unavailable; provider tokens cannot be stored safely.",
        )
    )

    backups = sorted((data_directory / "backups").glob("fintracka-*.sqlite3"), reverse=True)
    backup_ok = False
    if backups:
        try:
            verify_backup(backups[0])
            backup_ok = True
        except (OSError, sqlite3.DatabaseError):
            backup_ok = False
    checks.append(
        _check(
            "local_backup",
            "Verified local backup",
            backup_ok,
            True,
            "Latest local backup passes SQLite integrity check.",
            "Create a verified local backup before connecting a bank.",
        )
    )

    for profile in PLAID_PROFILES:
        active_environments = {
            row[0]
            for row in connection.execute(
                "SELECT DISTINCT environment FROM provider_connections WHERE provider = 'plaid' AND credential_profile = ? AND status IN ('active', 'repair')",
                (profile,),
            )
        }
        try:
            environments = {load_plaid_configuration(connection, secrets, profile).environment}
            environments.update(
                load_plaid_configuration(connection, secrets, profile, environment).environment
                for environment in active_environments
            )
            plaid_ok = True
            success = (
                f"{' and '.join(environment.title() for environment in sorted(environments))} "
                "credentials are available in Keychain."
            )
        except (PlaidNotConfigured, SecretStoreUnavailable):
            plaid_ok = False
            success = ""
        active = bool(active_environments)
        checks.append(
            _check(
                f"plaid_{profile}",
                f"Plaid — {profile.title()}",
                plaid_ok,
                active,
                success,
                (
                    f"Configure {profile.title()}'s Plaid credentials; an active connection depends on them."
                    if active
                    else f"Optional: configure {profile.title()}'s Plaid credentials to connect banks."
                ),
            )
        )

    google = google_status(connection)
    checks.append(
        _check(
            "google",
            "Google Sheets",
            bool(google["authorized"]),
            False,
            "Authorized with per-file access.",
            "Optional: authorize Google Sheets for remote read-only snapshots.",
        )
    )
    scheduler = scheduler or {"installed": False, "loaded": False}
    schedule_ok = scheduler.get("installed", False) and scheduler.get("loaded", False)
    checks.append(
        _check(
            "scheduler",
            "Daily sync",
            schedule_ok,
            False,
            "Installed for 06:17 local time and login.",
            "Optional: install the daily sync schedule; the Mac must be awake.",
        )
    )
    last_sync = connection.execute(
        "SELECT MAX(last_success_at) FROM provider_connections WHERE provider = 'plaid'"
    ).fetchone()[0]
    checks.append(
        {
            "id": "last_sync",
            "label": "Last successful sync",
            "status": "pass" if last_sync else "warning",
            "blocking": False,
            "detail": str(last_sync) if last_sync else "No successful live sync yet.",
        }
    )
    checks.append(
        {
            "id": "off_device_backup",
            "label": "Off-device backup",
            "status": "warning",
            "blocking": False,
            "detail": "Not configured; accepted testing risk. Hardware loss may make test data unrecoverable.",
        }
    )
    ready = all(item["status"] == "pass" for item in checks if item["blocking"])
    return {"ready": ready, "checks": checks}


def _check(
    identifier: str,
    label: str,
    passed: bool,
    blocking: bool,
    success: str,
    failure: str,
) -> dict[str, object]:
    return {
        "id": identifier,
        "label": label,
        "status": "pass" if passed else ("fail" if blocking else "warning"),
        "blocking": blocking,
        "detail": success if passed else failure,
    }
