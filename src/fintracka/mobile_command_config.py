from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fintracka.ids import new_id
from fintracka.keychain import KeychainSecrets, SecretStoreUnavailable


CLIENT_ID_REF_PREFIX = "mobile-commands:access:client-id"
CLIENT_SECRET_REF_PREFIX = "mobile-commands:access:client-secret"


@dataclass(frozen=True)
class MobileCommandSettings:
    enabled: bool
    gateway_url: str | None
    access_client_id_ref: str | None
    access_client_secret_ref: str | None
    last_checked_at: str | None
    last_error_code: str | None
    updated_at: str


def configure_mobile_commands(
    connection: sqlite3.Connection,
    secrets: KeychainSecrets,
    *,
    gateway_url: str,
    access_client_id: str,
    access_client_secret: str,
) -> MobileCommandSettings:
    gateway_url = _https_url(gateway_url)
    if not access_client_id or not access_client_secret:
        raise ValueError("Access credentials cannot be empty")
    current = load_mobile_command_settings(connection)
    old_refs = {
        reference
        for reference in (current.access_client_id_ref, current.access_client_secret_ref)
        if reference
    }
    configuration_id = new_id()
    client_id_ref = f"{CLIENT_ID_REF_PREFIX}:{configuration_id}"
    client_secret_ref = f"{CLIENT_SECRET_REF_PREFIX}:{configuration_id}"
    created: list[str] = []
    now = _now()
    try:
        secrets.put(client_id_ref, access_client_id)
        created.append(client_id_ref)
        secrets.put(client_secret_ref, access_client_secret)
        created.append(client_secret_ref)
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """
            UPDATE mobile_command_settings
            SET enabled = 0, gateway_url = ?, access_client_id_ref = ?,
                access_client_secret_ref = ?, last_error_code = NULL, updated_at = ?
            WHERE id = 1
            """,
            (gateway_url, client_id_ref, client_secret_ref, now),
        )
        connection.execute(
            """
            INSERT INTO audit_events
            (id, actor, action, entity_type, entity_id, occurred_at)
            VALUES (?, 'user', 'mobile_commands_configure', 'mobile_command_settings', '1', ?)
            """,
            (new_id(), now),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        for reference in created:
            _delete_quietly(secrets, reference)
        raise
    for reference in old_refs:
        _delete_quietly(secrets, reference)
    return load_mobile_command_settings(connection)


def set_mobile_commands_enabled(
    connection: sqlite3.Connection,
    enabled: bool,
) -> MobileCommandSettings:
    current = load_mobile_command_settings(connection)
    if enabled and not all((
        current.gateway_url,
        current.access_client_id_ref,
        current.access_client_secret_ref,
    )):
        raise ValueError("mobile commands must be configured before they are enabled")
    now = _now()
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            "UPDATE mobile_command_settings SET enabled = ?, updated_at = ? WHERE id = 1",
            (int(enabled), now),
        )
        connection.execute(
            """
            INSERT INTO audit_events
            (id, actor, action, entity_type, entity_id, occurred_at)
            VALUES (?, 'user', ?, 'mobile_command_settings', '1', ?)
            """,
            (new_id(), "mobile_commands_enable" if enabled else "mobile_commands_disable", now),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    return load_mobile_command_settings(connection)


def load_mobile_command_settings(connection: sqlite3.Connection) -> MobileCommandSettings:
    row = connection.execute("SELECT * FROM mobile_command_settings WHERE id = 1").fetchone()
    if row is None:
        raise RuntimeError("mobile command settings migration is missing")
    return MobileCommandSettings(
        enabled=bool(row["enabled"]),
        gateway_url=row["gateway_url"],
        access_client_id_ref=row["access_client_id_ref"],
        access_client_secret_ref=row["access_client_secret_ref"],
        last_checked_at=row["last_checked_at"],
        last_error_code=row["last_error_code"],
        updated_at=row["updated_at"],
    )


def _https_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("gateway URL must be a plain HTTPS URL")
    return value.strip().rstrip("/")


def _delete_quietly(secrets: KeychainSecrets, reference: str) -> None:
    try:
        secrets.delete(reference)
    except SecretStoreUnavailable:
        pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
