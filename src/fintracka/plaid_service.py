from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Literal

from fintracka.ids import new_id
from fintracka.keychain import KeychainSecrets, SecretStoreUnavailable, store_secret_reference
from fintracka.plaid_adapter import OfficialPlaidClient, PlaidAdapter, PlaidClient, ProviderActionRequired
from fintracka.sync import apply_batch

PlaidEnvironment = Literal["sandbox", "production"]
PlaidProfile = Literal["david", "ariela"]
PLAID_PROFILES: tuple[PlaidProfile, ...] = ("david", "ariela")


class PlaidNotConfigured(RuntimeError):
    pass


@dataclass(frozen=True)
class PlaidConfiguration:
    profile: PlaidProfile
    environment: PlaidEnvironment
    client_id: str
    secret: str


def configure_plaid(
    connection: sqlite3.Connection,
    secrets: KeychainSecrets,
    profile: PlaidProfile,
    environment: PlaidEnvironment,
    client_id: str,
    secret: str,
) -> None:
    _validate_profile(profile)
    if environment not in {"sandbox", "production"}:
        raise ValueError("Plaid environment must be sandbox or production")
    prefix = f"plaid.profile.{profile}.{environment}"
    previous = dict(
        connection.execute(
            "SELECT key, value FROM app_metadata WHERE key IN (?, ?)",
            (f"{prefix}.client_id_ref", f"{prefix}.secret_ref"),
        )
    )
    configuration_id = new_id()
    client_ref = f"plaid:profile:{profile}:{environment}:client_id:{configuration_id}"
    secret_ref = f"plaid:profile:{profile}:{environment}:secret:{configuration_id}"
    created: list[str] = []
    now = _now()
    try:
        secrets.put(client_ref, client_id)
        created.append(client_ref)
        secrets.put(secret_ref, secret)
        created.append(secret_ref)
        connection.execute("BEGIN IMMEDIATE")
        values = {
            f"plaid.profile.{profile}.environment": environment,
            f"{prefix}.client_id_ref": client_ref,
            f"{prefix}.secret_ref": secret_ref,
        }
        connection.executemany(
            "INSERT INTO app_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            values.items(),
        )
        connection.execute(
            "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'user', 'plaid_configure', 'provider', ?, ?)",
            (new_id(), f"plaid:{profile}", now),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        for reference in created:
            try:
                secrets.delete(reference)
            except SecretStoreUnavailable:
                pass
        raise
    for reference in previous.values():
        if reference not in {client_ref, secret_ref}:
            try:
                secrets.delete(reference)
            except SecretStoreUnavailable:
                pass


def load_plaid_configuration(
    connection: sqlite3.Connection,
    secrets: KeychainSecrets,
    profile: PlaidProfile,
    environment: PlaidEnvironment | None = None,
) -> PlaidConfiguration:
    _validate_profile(profile)
    rows = dict(
        connection.execute(
            "SELECT key, value FROM app_metadata WHERE key LIKE ?",
            (f"plaid.profile.{profile}.%",),
        )
    )
    environment = environment or rows.get(f"plaid.profile.{profile}.environment")
    if environment not in {"sandbox", "production"}:
        raise PlaidNotConfigured(f"Plaid profile {profile} is not configured")
    prefix = f"plaid.profile.{profile}.{environment}"
    client_ref = rows.get(f"{prefix}.client_id_ref")
    secret_ref = rows.get(f"{prefix}.secret_ref")
    client_id = secrets.get(client_ref) if client_ref else None
    secret = secrets.get(secret_ref) if secret_ref else None
    if not client_id or not secret:
        raise PlaidNotConfigured("Plaid credentials are missing from macOS Keychain")
    return PlaidConfiguration(profile, environment, client_id, secret)


def build_plaid_adapter(
    connection: sqlite3.Connection,
    secrets: KeychainSecrets,
    profile: PlaidProfile,
    environment: PlaidEnvironment | None = None,
    client_factory: Callable[[str, str, PlaidEnvironment], PlaidClient] = OfficialPlaidClient,
) -> PlaidAdapter:
    configuration = load_plaid_configuration(connection, secrets, profile, environment)
    return PlaidAdapter(
        client_factory(configuration.client_id, configuration.secret, configuration.environment),
        secrets,
        environment=configuration.environment,
    )


def complete_plaid_connection(
    connection: sqlite3.Connection,
    adapter: PlaidAdapter,
    public_token: str,
) -> dict[str, str]:
    connection_id = new_id()
    reference = f"plaid:{adapter.environment}:connection:{connection_id}"
    connected = adapter.complete_link(public_token, reference)
    try:
        institution = adapter.connection_info(reference)
        now = _now()
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "INSERT INTO institutions (id, provider, external_id, name, created_at) VALUES (?, 'plaid', ?, ?, ?) ON CONFLICT(provider, external_id) DO UPDATE SET name = excluded.name",
            (new_id(), institution.external_id, institution.name, now),
        )
        institution_id = connection.execute(
            "SELECT id FROM institutions WHERE provider = 'plaid' AND external_id = ?",
            (institution.external_id,),
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO provider_connections (id, provider, external_connection_id, institution_id, status, created_at, updated_at, environment) VALUES (?, 'plaid', ?, ?, 'active', ?, ?, ?)",
            (connection_id, connected.external_connection_id, institution_id, now, now, adapter.environment),
        )
        store_secret_reference(connection, connection_id, KeychainSecrets.service, reference)
        connection.execute(
            "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'user', 'connection_create', 'provider_connection', ?, ?)",
            (new_id(), connection_id, now),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        try:
            adapter.revoke(reference)
        except Exception:
            pass
        raise
    return {
        "id": connection_id,
        "provider": "plaid",
        "environment": adapter.environment,
        "status": "active",
        "institution_name": institution.name,
        "updated_at": now,
    }


def repair_plaid_connection(
    connection: sqlite3.Connection,
    adapter: PlaidAdapter,
    connection_id: str,
):  # type: ignore[no-untyped-def]
    row = _connection_secret(connection, connection_id)
    _require_environment(row["environment"], adapter.environment)
    if row["status"] == "revoked":
        raise ValueError("connection is revoked")
    return adapter.repair_connection(row["keychain_account"])


def revoke_plaid_connection(
    connection: sqlite3.Connection,
    adapter: PlaidAdapter,
    connection_id: str,
) -> None:
    row = _connection_secret(connection, connection_id)
    _require_environment(row["environment"], adapter.environment)
    if row["status"] == "revoked":
        return
    adapter.revoke(row["keychain_account"])
    now = _now()
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            "UPDATE provider_connections SET status = 'revoked', updated_at = ? WHERE id = ?",
            (now, connection_id),
        )
        connection.execute(
            "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'user', 'connection_revoke', 'provider_connection', ?, ?)",
            (new_id(), connection_id, now),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def sync_plaid_connections(
    connection: sqlite3.Connection,
    adapter: PlaidAdapter,
) -> list[str]:
    rows = connection.execute(
        """
        SELECT pc.id, pc.environment, csr.keychain_account, checkpoints.cursor
        FROM provider_connections pc
        JOIN connection_secret_refs csr ON csr.connection_id = pc.id
        LEFT JOIN provider_checkpoints checkpoints ON checkpoints.connection_id = pc.id
        WHERE pc.provider = 'plaid' AND pc.status = 'active'
        ORDER BY pc.created_at, pc.id
        """
    ).fetchall()
    runs: list[str] = []
    for row in rows:
        _require_environment(row["environment"], adapter.environment)
        try:
            batch = adapter.fetch_updates(row["keychain_account"], row["cursor"])
            runs.append(apply_batch(connection, row["id"], batch))
        except ProviderActionRequired:
            connection.execute(
                "UPDATE provider_connections SET status = 'repair', last_error_code = 'ITEM_REPAIR_REQUIRED', updated_at = ? WHERE id = ?",
                (_now(), row["id"]),
            )
            raise
    return runs


def _connection_secret(connection: sqlite3.Connection, connection_id: str) -> sqlite3.Row:
    row = connection.execute(
        """
        SELECT pc.status, pc.environment, csr.keychain_account
        FROM provider_connections pc JOIN connection_secret_refs csr ON csr.connection_id = pc.id
        WHERE pc.id = ? AND pc.provider = 'plaid'
        """,
        (connection_id,),
    ).fetchone()
    if row is None:
        raise ValueError("Plaid connection not found")
    return row


def _require_environment(stored: str | None, active: PlaidEnvironment) -> None:
    if stored != active:
        raise SecretStoreUnavailable("Plaid environment does not match the stored connection")


def _validate_profile(profile: str) -> None:
    if profile not in PLAID_PROFILES:
        raise ValueError("Plaid profile must be david or ariela")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
