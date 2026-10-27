from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fintracka.ids import new_id
from fintracka.keychain import KeychainSecrets, SecretStoreUnavailable

REMOTE_CLIENT_ID_REF_PREFIX = "remote:access:client-id"
REMOTE_CLIENT_SECRET_REF_PREFIX = "remote:access:client-secret"
REMOTE_REASONS = {"manual", "startup", "sync", "scheduled"}
REMOTE_RUN_STATUSES = {"succeeded", "failed", "skipped"}
ERROR_CODE = re.compile(r"[A-Z][A-Z0-9_]{0,63}\Z")


@dataclass(frozen=True)
class RemoteSettings:
    enabled: bool
    viewer_url: str | None
    publisher_url: str | None
    history_months: int
    interval_minutes: int
    access_client_id_ref: str | None
    access_client_secret_ref: str | None
    next_source_sequence: int
    last_snapshot_id: str | None
    last_published_at: str | None
    last_error_code: str | None
    updated_at: str


@dataclass(frozen=True)
class RemoteRun:
    id: str
    reason: str
    source_sequence: int
    status: str
    snapshot_id: str | None
    record_count: int | None
    error_code: str | None
    started_at: str
    finished_at: str | None


def configure_remote(
    connection: sqlite3.Connection,
    secrets: KeychainSecrets,
    *,
    viewer_url: str,
    publisher_url: str,
    access_client_id: str,
    access_client_secret: str,
    history_months: int = 6,
    interval_minutes: int = 60,
) -> RemoteSettings:
    viewer_url = _https_url(viewer_url, "viewer URL")
    publisher_url = _https_url(publisher_url, "publisher URL")
    if not 1 <= history_months <= 6:
        raise ValueError("history months must be between 1 and 6")
    if not 15 <= interval_minutes <= 1440:
        raise ValueError("interval minutes must be between 15 and 1440")
    if not access_client_id or not access_client_secret:
        raise ValueError("Access credentials cannot be empty")

    current = load_remote_settings(connection)
    previous_refs = {
        reference
        for reference in (current.access_client_id_ref, current.access_client_secret_ref)
        if reference
    }
    configuration_id = new_id()
    client_id_ref = f"{REMOTE_CLIENT_ID_REF_PREFIX}:{configuration_id}"
    client_secret_ref = f"{REMOTE_CLIENT_SECRET_REF_PREFIX}:{configuration_id}"
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
            UPDATE remote_settings
            SET enabled = 1, viewer_url = ?, publisher_url = ?, history_months = ?,
                interval_minutes = ?, access_client_id_ref = ?,
                access_client_secret_ref = ?, last_error_code = NULL, updated_at = ?
            WHERE id = 1
            """,
            (
                viewer_url,
                publisher_url,
                history_months,
                interval_minutes,
                client_id_ref,
                client_secret_ref,
                now,
            ),
        )
        connection.execute(
            """
            INSERT INTO audit_events
            (id, actor, action, entity_type, entity_id, occurred_at)
            VALUES (?, 'user', 'remote_configure', 'remote_settings', '1', ?)
            """,
            (new_id(), now),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        for reference in created:
            _delete_quietly(secrets, reference)
        raise

    for reference in previous_refs:
        _delete_quietly(secrets, reference)
    return load_remote_settings(connection)


def load_remote_settings(connection: sqlite3.Connection) -> RemoteSettings:
    row = connection.execute("SELECT * FROM remote_settings WHERE id = 1").fetchone()
    if row is None:
        raise RuntimeError("remote settings migration is missing")
    return RemoteSettings(
        enabled=bool(row["enabled"]),
        viewer_url=row["viewer_url"],
        publisher_url=row["publisher_url"],
        history_months=row["history_months"],
        interval_minutes=row["interval_minutes"],
        access_client_id_ref=row["access_client_id_ref"],
        access_client_secret_ref=row["access_client_secret_ref"],
        next_source_sequence=row["next_source_sequence"],
        last_snapshot_id=row["last_snapshot_id"],
        last_published_at=row["last_published_at"],
        last_error_code=row["last_error_code"],
        updated_at=row["updated_at"],
    )


def reserve_remote_sequence(connection: sqlite3.Connection) -> int:
    connection.execute("BEGIN IMMEDIATE")
    try:
        row = connection.execute(
            "SELECT next_source_sequence FROM remote_settings WHERE id = 1"
        ).fetchone()
        if row is None:
            raise RuntimeError("remote settings migration is missing")
        sequence = int(row[0])
        connection.execute(
            "UPDATE remote_settings SET next_source_sequence = ?, updated_at = ? WHERE id = 1",
            (sequence + 1, _now()),
        )
        connection.commit()
        return sequence
    except Exception:
        connection.rollback()
        raise


def start_remote_run(connection: sqlite3.Connection, reason: str, sequence: int) -> str:
    if reason not in REMOTE_REASONS:
        raise ValueError("remote publication reason is invalid")
    if sequence <= 0:
        raise ValueError("source sequence must be positive")
    run_id = new_id()
    connection.execute(
        """
        INSERT INTO remote_publication_runs
        (id, reason, source_sequence, status, started_at)
        VALUES (?, ?, ?, 'running', ?)
        """,
        (run_id, reason, sequence, _now()),
    )
    return run_id


def finish_remote_run(
    connection: sqlite3.Connection,
    run_id: str,
    *,
    status: str,
    snapshot_id: str | None = None,
    error_code: str | None = None,
) -> None:
    if status not in REMOTE_RUN_STATUSES:
        raise ValueError("remote publication status is invalid")
    if error_code is not None and ERROR_CODE.fullmatch(error_code) is None:
        raise ValueError("remote publication error code is invalid")
    if status == "succeeded" and not snapshot_id:
        raise ValueError("successful remote publication requires a snapshot ID")
    if connection.execute(
        "SELECT 1 FROM remote_publication_runs WHERE id = ?", (run_id,)
    ).fetchone() is None:
        raise ValueError("remote publication run not found")
    now = _now()
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            """
            UPDATE remote_publication_runs
            SET status = ?, snapshot_id = ?, error_code = ?, finished_at = ?
            WHERE id = ?
            """,
            (status, snapshot_id, error_code, now, run_id),
        )
        connection.execute(
            """
            UPDATE remote_settings
            SET last_snapshot_id = CASE WHEN ? = 'succeeded' THEN ? ELSE last_snapshot_id END,
                last_published_at = CASE WHEN ? = 'succeeded' THEN ? ELSE last_published_at END,
                last_error_code = ?, updated_at = ?
            WHERE id = 1
            """,
            (status, snapshot_id, status, now, error_code, now),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def _https_url(value: str, label: str) -> str:
    parsed = urlsplit(value.strip())
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or parsed.query
    ):
        raise ValueError(f"{label} must be a plain HTTPS URL")
    return value.strip().rstrip("/")


def _delete_quietly(secrets: KeychainSecrets, reference: str) -> None:
    try:
        secrets.delete(reference)
    except SecretStoreUnavailable:
        pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

