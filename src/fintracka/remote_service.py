from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fintracka.db import connect, migrate
from fintracka.keychain import KeychainSecrets
from fintracka.locks import ProcessLock, ProcessLockError
from fintracka.mobile_command_config import load_mobile_command_settings
from fintracka.remote_client import PublishResult, RemotePublishError, RemotePublisherClient
from fintracka.remote_config import (
    RemoteSettings,
    finish_remote_run,
    load_remote_settings,
    reserve_remote_sequence,
    start_remote_run,
)
from fintracka.remote_snapshot import (
    SnapshotTooLargeError,
    build_remote_snapshot,
    serialize_remote_snapshot,
    snapshot_digest,
)


PublishReason = Literal["manual", "startup", "sync", "scheduled"]


def publish_remote_snapshot(
    database_path: Path,
    secrets: KeychainSecrets,
    *,
    reason: PublishReason,
    client_factory: Callable[
        [RemoteSettings, KeychainSecrets], RemotePublisherClient
    ] = RemotePublisherClient.from_settings,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> PublishResult | None:
    try:
        return _publish_remote_snapshot_locked(
            database_path, secrets, reason=reason, client_factory=client_factory, now=now
        )
    except ProcessLockError:
        return None


def _publish_remote_snapshot_locked(
    database_path: Path,
    secrets: KeychainSecrets,
    *,
    reason: PublishReason,
    client_factory: Callable[
        [RemoteSettings, KeychainSecrets], RemotePublisherClient
    ],
    now: Callable[[], datetime],
) -> PublishResult | None:
    with ProcessLock(database_path.parent / "fintracka-remote.lock"):
        connection = connect(database_path)
        try:
            migrate(connection)
            settings = load_remote_settings(connection)
            mobile_command_settings = load_mobile_command_settings(connection)
            configured = all((
                settings.publisher_url,
                settings.access_client_id_ref,
                settings.access_client_secret_ref,
            ))
            if not configured or (reason != "manual" and not settings.enabled):
                return None
            sequence = reserve_remote_sequence(connection)
            run_id = start_remote_run(connection, reason, sequence)
            connection.commit()
            try:
                captured_at = now()
                snapshot = build_remote_snapshot(
                    connection,
                    source_sequence=sequence,
                    history_months=settings.history_months,
                    now=captured_at,
                    mobile_commands_enabled=mobile_command_settings.enabled,
                )
                payload = serialize_remote_snapshot(snapshot)
                result = client_factory(settings, secrets).publish(payload, snapshot_digest(payload))
                if result.snapshot_id != snapshot.snapshot_id or result.source_sequence != sequence:
                    raise RemotePublishError("REMOTE_RESPONSE_MISMATCH")
                finish_remote_run(
                    connection, run_id, status="succeeded", snapshot_id=result.snapshot_id
                )
                return result
            except Exception as error:
                code = _error_code(error)
                finish_remote_run(connection, run_id, status="failed", error_code=code)
                if isinstance(error, RemotePublishError):
                    raise
                raise RemotePublishError(code) from error
        finally:
            connection.close()


def purge_remote_snapshots(
    database_path: Path,
    secrets: KeychainSecrets,
    *,
    client_factory: Callable[
        [RemoteSettings, KeychainSecrets], RemotePublisherClient
    ] = RemotePublisherClient.from_settings,
) -> None:
    with ProcessLock(database_path.parent / "fintracka-remote.lock"):
        connection = connect(database_path)
        try:
            migrate(connection)
            settings = load_remote_settings(connection)
            client_factory(settings, secrets).purge()
        finally:
            connection.close()


def _error_code(error: Exception) -> str:
    if isinstance(error, RemotePublishError):
        return error.code
    if isinstance(error, SnapshotTooLargeError):
        return "REMOTE_TOO_LARGE"
    return "REMOTE_PUBLICATION_FAILED"
