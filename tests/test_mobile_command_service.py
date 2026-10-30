from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace

from e2e.server import seed_database
from fintracka.db import connect
from fintracka.keychain import KeychainSecrets
from fintracka.locks import ProcessLock
from fintracka.mobile_command_client import (
    ClaimedMobileCommand,
    MobileCommandClientError,
)
from fintracka.mobile_command_config import (
    configure_mobile_commands,
    set_mobile_commands_enabled,
)
from fintracka.mobile_command_service import process_mobile_commands
from fintracka.remote_client import RemotePublishError


class FakeKeyring:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}

    def set_password(self, service: str, account: str, password: str) -> None:
        self.values[(service, account)] = password

    def get_password(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def delete_password(self, service: str, account: str) -> None:
        self.values.pop((service, account), None)


class Client:
    def __init__(self, batches=(), fail_completions: int = 0) -> None:
        self.batches = list(batches)
        self.fail_completions = fail_completions
        self.completions: list[tuple[str, str, dict[str, object]]] = []

    def claim(self, limit=10):
        return tuple(self.batches.pop(0)) if self.batches else ()

    def complete(self, command_id, claim_token, result):
        if self.fail_completions:
            self.fail_completions -= 1
            raise MobileCommandClientError("MOBILE_TIMEOUT")
        self.completions.append((command_id, claim_token, dict(result)))
        return SimpleNamespace(id=command_id, status=result["status"])


def test_empty_poll_is_safe_and_does_not_publish(tmp_path) -> None:
    path, secrets, transaction_id, category_id = configured_ledger(tmp_path)
    client = Client()
    publications = []

    result = process_mobile_commands(
        path, secrets,
        client_factory=lambda *_: client,
        publisher=lambda *_args, **_kwargs: publications.append(True),
    )

    assert (result.claimed, result.applied, result.published) == (0, 0, False)
    assert publications == []


def test_applies_once_with_receipt_audit_reconciliation_and_one_publish(
    tmp_path, monkeypatch,
) -> None:
    path, secrets, transaction_id, category_id = configured_ledger(tmp_path)
    command = claimed("command-applied", "claim-1", transaction_id, category_id)
    client = Client(((command,),))
    reconciled = []
    monkeypatch.setattr(
        "fintracka.mobile_command_service.reconcile_financial_mutations",
        lambda connection, ids=None: reconciled.extend(ids or []),
    )
    publications = []

    result = process_mobile_commands(
        path, secrets,
        client_factory=lambda *_: client,
        publisher=lambda *_args, **_kwargs: publications.append(True)
        or SimpleNamespace(published_at="2026-10-30T12:01:00Z"),
    )

    connection = connect(path)
    row = connection.execute(
        "SELECT category_id, classification_revision FROM transactions WHERE id = ?",
        (transaction_id,),
    ).fetchone()
    receipt = connection.execute(
        "SELECT status, applied_revision, snapshot_published_at FROM mobile_command_receipts WHERE command_id = ?",
        (command.id,),
    ).fetchone()
    audit = connection.execute(
        "SELECT actor, after_json FROM audit_events WHERE action = 'transaction_classification_set' AND entity_id = ?",
        (transaction_id,),
    ).fetchone()
    connection.close()

    assert (result.claimed, result.applied, result.acknowledged, result.published) == (1, 1, 1, True)
    assert tuple(row) == (category_id, 1)
    assert tuple(receipt) == ("applied", 1, "2026-10-30T12:01:00Z")
    assert audit["actor"] == "member:member-david"
    assert json.loads(audit["after_json"])["command_id"] == command.id
    assert reconciled == [transaction_id]
    assert len(publications) == 1
    assert client.completions[0][2]["status"] == "applied"


def test_stale_revision_returns_conflict_without_mutation(tmp_path) -> None:
    path, secrets, transaction_id, category_id = configured_ledger(tmp_path)
    command = claimed(
        "command-conflict", "claim-1", transaction_id, category_id,
        observed_revision=7,
    )
    client = Client(((command,),))

    result = process_mobile_commands(
        path, secrets, client_factory=lambda *_: client,
        publisher=lambda *_args, **_kwargs: None,
    )

    connection = connect(path)
    assert connection.execute(
        "SELECT classification_revision FROM transactions WHERE id = ?", (transaction_id,),
    ).fetchone()[0] == 0
    assert connection.execute(
        "SELECT status FROM mobile_command_receipts WHERE command_id = ?", (command.id,),
    ).fetchone()[0] == "conflict"
    connection.close()
    assert (result.conflicts, result.applied) == (1, 0)
    assert client.completions[0][2]["status"] == "conflict"


def test_invalid_digest_is_rejected_without_touching_financial_data(tmp_path) -> None:
    path, secrets, transaction_id, category_id = configured_ledger(tmp_path)
    command = ClaimedMobileCommand(
        **{**claimed("command-rejected", "claim-1", transaction_id, category_id).__dict__,
           "payload_digest": "0" * 64}
    )
    client = Client(((command,),))

    result = process_mobile_commands(
        path, secrets, client_factory=lambda *_: client,
        publisher=lambda *_args, **_kwargs: None,
    )

    assert (result.rejected, result.applied) == (1, 0)
    assert client.completions[0][2] == {
        "status": "rejected", "error_code": "INVALID_PAYLOAD_DIGEST",
    }


def test_unsupported_command_is_permanently_rejected(tmp_path) -> None:
    path, secrets, transaction_id, category_id = configured_ledger(tmp_path)
    original = claimed("command-unsupported", "claim-1", transaction_id, category_id)
    command = ClaimedMobileCommand(
        **{**original.__dict__, "command_type": "transaction.archive", "command_version": 2}
    )
    client = Client(((command,),))

    result = process_mobile_commands(
        path, secrets, client_factory=lambda *_: client,
        publisher=lambda *_args, **_kwargs: None,
    )

    assert result.rejected == 1
    assert client.completions[0][2] == {
        "status": "rejected", "error_code": "UNSUPPORTED_COMMAND",
    }


def test_receipt_prevents_reapply_after_completion_failure(tmp_path) -> None:
    path, secrets, transaction_id, category_id = configured_ledger(tmp_path)
    first = claimed("command-recovery", "claim-1", transaction_id, category_id)
    client = Client(((first,),), fail_completions=1)

    first_result = process_mobile_commands(
        path, secrets, client_factory=lambda *_: client,
        publisher=lambda *_args, **_kwargs: SimpleNamespace(
            published_at="2026-10-30T12:01:00Z"
        ),
    )
    client.batches.append((ClaimedMobileCommand(
        **{**first.__dict__, "claim_token": "claim-2"}
    ),))
    second_result = process_mobile_commands(
        path, secrets, client_factory=lambda *_: client,
        publisher=lambda *_args, **_kwargs: None,
    )

    connection = connect(path)
    revision = connection.execute(
        "SELECT classification_revision FROM transactions WHERE id = ?", (transaction_id,),
    ).fetchone()[0]
    receipts = connection.execute(
        "SELECT COUNT(*) FROM mobile_command_receipts WHERE command_id = ?", (first.id,),
    ).fetchone()[0]
    connection.close()
    assert first_result.applied == 1 and first_result.acknowledged == 0
    assert second_result.applied == 0 and second_result.acknowledged == 1
    assert revision == 1 and receipts == 1
    assert client.completions[-1][1] == "claim-2"


def test_receipt_insert_failure_rolls_back_classification(tmp_path) -> None:
    path, secrets, transaction_id, category_id = configured_ledger(tmp_path)
    connection = connect(path)
    connection.execute(
        """
        CREATE TRIGGER reject_mobile_receipt BEFORE INSERT ON mobile_command_receipts
        BEGIN SELECT RAISE(ABORT, 'forced receipt failure'); END
        """
    )
    connection.close()
    command = claimed("command-rollback", "claim-1", transaction_id, category_id)
    client = Client(((command,),))

    result = process_mobile_commands(
        path, secrets, client_factory=lambda *_: client,
        publisher=lambda *_args, **_kwargs: None,
    )

    connection = connect(path)
    assert connection.execute(
        "SELECT classification_revision FROM transactions WHERE id = ?", (transaction_id,),
    ).fetchone()[0] == 0
    assert connection.execute("SELECT COUNT(*) FROM mobile_command_receipts").fetchone()[0] == 0
    connection.close()
    assert result.failed == 1
    assert client.completions == []


def test_failed_publication_retries_next_run_without_reapplying(tmp_path) -> None:
    path, secrets, transaction_id, category_id = configured_ledger(tmp_path)
    command = claimed("command-publish", "claim-1", transaction_id, category_id)
    client = Client(((command,),))
    attempts = 0

    def publisher(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RemotePublishError("REMOTE_TIMEOUT")
        return SimpleNamespace(published_at="2026-10-30T12:02:00Z")

    first = process_mobile_commands(
        path, secrets, client_factory=lambda *_: client, publisher=publisher,
    )
    second = process_mobile_commands(
        path, secrets, client_factory=lambda *_: client, publisher=publisher,
    )

    connection = connect(path)
    receipt = connection.execute(
        "SELECT snapshot_published_at FROM mobile_command_receipts WHERE command_id = ?",
        (command.id,),
    ).fetchone()[0]
    revision = connection.execute(
        "SELECT classification_revision FROM transactions WHERE id = ?", (transaction_id,),
    ).fetchone()[0]
    connection.close()
    assert first.published is False and first.error_code == "REMOTE_TIMEOUT"
    assert second.published is True and attempts == 2
    assert receipt == "2026-10-30T12:02:00Z" and revision == 1


def test_global_financial_lock_skips_without_claiming(tmp_path) -> None:
    path, secrets, transaction_id, category_id = configured_ledger(tmp_path)
    client = Client(((claimed("command-lock", "claim-1", transaction_id, category_id),),))

    with ProcessLock(path.parent / "fintracka.lock"):
        result = process_mobile_commands(
            path, secrets, client_factory=lambda *_: client,
            publisher=lambda *_args, **_kwargs: None,
        )

    assert result.skipped is True
    assert len(client.batches) == 1


def configured_ledger(tmp_path):
    path = tmp_path / "ledger.sqlite3"
    seed_database(path)
    backend = FakeKeyring()
    secrets = KeychainSecrets(backend)
    connection = connect(path)
    configure_mobile_commands(
        connection,
        secrets,
        gateway_url="https://viewer.example.test",
        access_client_id="mobile-client-id",
        access_client_secret="mobile-client-secret",
    )
    set_mobile_commands_enabled(connection, True)
    transaction = connection.execute(
        "SELECT id, category_id FROM transactions WHERE tombstoned = 0 AND user_archived = 0 LIMIT 1"
    ).fetchone()
    category = connection.execute(
        "SELECT id FROM categories WHERE archived = 0 AND (? IS NULL OR id != ?) ORDER BY name LIMIT 1",
        (transaction["category_id"], transaction["category_id"]),
    ).fetchone()[0]
    connection.close()
    return path, secrets, transaction["id"], category


def claimed(
    command_id: str,
    claim_token: str,
    transaction_id: str,
    category_id: str,
    *,
    observed_revision: int = 0,
) -> ClaimedMobileCommand:
    payload = json.dumps(
        {"category_id": category_id, "subcategory_id": None},
        separators=(",", ":"),
    ).encode()
    return ClaimedMobileCommand(
        id=command_id,
        actor_member_id="member-david",
        command_type="transaction.set_classification",
        command_version=1,
        target_id=transaction_id,
        observed_revision=observed_revision,
        category_id=category_id,
        subcategory_id=None,
        payload_digest=hashlib.sha256(payload).hexdigest(),
        claim_token=claim_token,
        expires_at="2026-11-30T12:00:00Z",
    )
