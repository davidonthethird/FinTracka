from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fintracka.classification import (
    ClassificationConflict,
    ClassificationError,
    set_transaction_classification_once,
)
from fintracka.db import connect, migrate
from fintracka.financial_mutations import reconcile_financial_mutations
from fintracka.keychain import KeychainSecrets
from fintracka.locks import ProcessLock, ProcessLockError
from fintracka.mobile_command_client import (
    ClaimedMobileCommand,
    MobileCommandClient,
    MobileCommandClientError,
)
from fintracka.mobile_command_config import (
    MobileCommandSettings,
    load_mobile_command_settings,
)
from fintracka.remote_client import RemotePublishError
from fintracka.remote_service import publish_remote_snapshot


@dataclass(frozen=True)
class MobileCommandRunResult:
    claimed: int = 0
    applied: int = 0
    conflicts: int = 0
    rejected: int = 0
    failed: int = 0
    acknowledged: int = 0
    published: bool = False
    skipped: bool = False
    error_code: str | None = None


ClientFactory = Callable[[MobileCommandSettings, KeychainSecrets], MobileCommandClient]
Publisher = Callable[..., object | None]


def process_mobile_commands(
    database_path: Path,
    secrets: KeychainSecrets,
    *,
    client_factory: ClientFactory = MobileCommandClient.from_settings,
    publisher: Publisher = publish_remote_snapshot,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> MobileCommandRunResult:
    try:
        with ProcessLock(database_path.parent / "fintracka.lock"):
            return _process_locked(
                database_path,
                secrets,
                client_factory=client_factory,
                publisher=publisher,
                now=now,
            )
    except ProcessLockError:
        return MobileCommandRunResult(skipped=True)


def _process_locked(
    database_path: Path,
    secrets: KeychainSecrets,
    *,
    client_factory: ClientFactory,
    publisher: Publisher,
    now: Callable[[], datetime],
) -> MobileCommandRunResult:
    connection = connect(database_path)
    try:
        migrate(connection)
        settings = load_mobile_command_settings(connection)
        if not settings.enabled:
            return MobileCommandRunResult(skipped=True)
        try:
            client = client_factory(settings, secrets)
            commands = client.claim(10)
        except MobileCommandClientError as error:
            _record_check(connection, now(), error.code)
            return MobileCommandRunResult(failed=1, error_code=error.code)

        applied = conflicts = rejected = failed = acknowledged = 0
        error_code: str | None = None
        for command in commands:
            try:
                result, newly_applied = _process_one(connection, command, now())
                applied += int(newly_applied)
                conflicts += int(result["status"] == "conflict")
                rejected += int(result["status"] == "rejected")
            except Exception:
                if connection.in_transaction:
                    connection.rollback()
                failed += 1
                error_code = "MOBILE_PROCESSING_FAILED"
                continue
            try:
                client.complete(command.id, command.claim_token, result)
                acknowledged += 1
            except MobileCommandClientError as error:
                error_code = error.code

        published = False
        try:
            published = publish_unpublished_mobile_results(
                connection,
                database_path,
                secrets,
                publisher=publisher,
            )
        except RemotePublishError as error:
            error_code = error.code
        except Exception:
            error_code = "REMOTE_PUBLICATION_FAILED"
        _record_check(connection, now(), error_code)
        return MobileCommandRunResult(
            claimed=len(commands),
            applied=applied,
            conflicts=conflicts,
            rejected=rejected,
            failed=failed,
            acknowledged=acknowledged,
            published=published,
            error_code=error_code,
        )
    finally:
        connection.close()


def publish_unpublished_mobile_results(
    connection: sqlite3.Connection,
    database_path: Path,
    secrets: KeychainSecrets,
    *,
    publisher: Publisher = publish_remote_snapshot,
) -> bool:
    rows = connection.execute(
        """
        SELECT command_id FROM mobile_command_receipts
        WHERE status IN ('applied', 'conflict') AND snapshot_published_at IS NULL
        ORDER BY processed_at, command_id
        """
    ).fetchall()
    if not rows:
        return False
    result = publisher(database_path, secrets, reason="manual")
    if result is None or not getattr(result, "published_at", None):
        raise RemotePublishError("REMOTE_NOT_CONFIGURED")
    command_ids = [row["command_id"] for row in rows]
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.executemany(
            """
            UPDATE mobile_command_receipts SET snapshot_published_at = ?
            WHERE command_id = ? AND status IN ('applied', 'conflict')
              AND snapshot_published_at IS NULL
            """,
            [(result.published_at, command_id) for command_id in command_ids],
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    return True


def _process_one(
    connection: sqlite3.Connection,
    command: ClaimedMobileCommand,
    processed_at: datetime,
) -> tuple[dict[str, object], bool]:
    existing = connection.execute(
        "SELECT * FROM mobile_command_receipts WHERE command_id = ?",
        (command.id,),
    ).fetchone()
    if existing is not None:
        if not _receipt_matches(existing, command):
            raise RuntimeError("command receipt does not match the claimed command")
        return json.loads(existing["result_json"]), False

    invalid = _validate_claim(command)
    if invalid is not None:
        result: dict[str, object] = {"status": "rejected", "error_code": invalid}
        _store_terminal_receipt(connection, command, result, processed_at)
        return result, False

    connection.execute("BEGIN IMMEDIATE")
    try:
        change = set_transaction_classification_once(
            connection,
            command.target_id,
            command.category_id,
            command.subcategory_id,
            command.observed_revision,
            actor=f"member:{command.actor_member_id}",
            command_id=command.id,
        )
        reconcile_financial_mutations(connection, [change.transaction_id])
        result = {
            "status": "applied",
            "category_id": change.category_id,
            "subcategory_id": change.subcategory_id,
            "classification_revision": change.classification_revision,
        }
        _insert_receipt(connection, command, result, processed_at)
        connection.commit()
        return result, True
    except ClassificationConflict as conflict:
        connection.rollback()
        result = {
            "status": "conflict",
            "category_id": conflict.category_id,
            "subcategory_id": conflict.subcategory_id,
            "classification_revision": conflict.current_revision,
        }
        _store_terminal_receipt(connection, command, result, processed_at)
        return result, False
    except ClassificationError as error:
        connection.rollback()
        result = {
            "status": "rejected",
            "error_code": _classification_error_code(error),
        }
        _store_terminal_receipt(connection, command, result, processed_at)
        return result, False
    except Exception:
        connection.rollback()
        raise


def _store_terminal_receipt(
    connection: sqlite3.Connection,
    command: ClaimedMobileCommand,
    result: Mapping[str, object],
    processed_at: datetime,
) -> None:
    connection.execute("BEGIN IMMEDIATE")
    try:
        _insert_receipt(connection, command, result, processed_at)
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def _insert_receipt(
    connection: sqlite3.Connection,
    command: ClaimedMobileCommand,
    result: Mapping[str, object],
    processed_at: datetime,
) -> None:
    status = str(result["status"])
    result_json = json.dumps(result, sort_keys=True, separators=(",", ":"))
    error_code = result.get("error_code") if status == "rejected" else None
    applied_revision = (
        result.get("classification_revision")
        if status == "applied"
        else None
    )
    connection.execute(
        """
        INSERT INTO mobile_command_receipts
        (command_id, command_type, command_version, payload_digest, actor_member_id,
         status, result_json, error_code, applied_revision, processed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            command.id,
            command.command_type,
            command.command_version,
            command.payload_digest,
            command.actor_member_id,
            status,
            result_json,
            error_code,
            applied_revision,
            _timestamp(processed_at),
        ),
    )


def _receipt_matches(row: sqlite3.Row, command: ClaimedMobileCommand) -> bool:
    return (
        row["command_type"] == command.command_type
        and row["command_version"] == command.command_version
        and row["payload_digest"] == command.payload_digest
        and row["actor_member_id"] == command.actor_member_id
    )


def _validate_claim(command: ClaimedMobileCommand) -> str | None:
    if command.command_type != "transaction.set_classification" or command.command_version != 1:
        return "UNSUPPORTED_COMMAND"
    payload = json.dumps(
        {"category_id": command.category_id, "subcategory_id": command.subcategory_id},
        separators=(",", ":"),
    ).encode()
    if hashlib.sha256(payload).hexdigest() != command.payload_digest:
        return "INVALID_PAYLOAD_DIGEST"
    return None


def _classification_error_code(error: ClassificationError) -> str:
    message = str(error)
    if "not found" in message or "not active" in message:
        return "TARGET_NOT_ACTIVE"
    return "INVALID_CLASSIFICATION"


def _record_check(
    connection: sqlite3.Connection,
    checked_at: datetime,
    error_code: str | None,
) -> None:
    connection.execute(
        """
        UPDATE mobile_command_settings
        SET last_checked_at = ?, last_error_code = ?, updated_at = ? WHERE id = 1
        """,
        (_timestamp(checked_at), error_code, _timestamp(checked_at)),
    )


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("mobile command timestamps must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
