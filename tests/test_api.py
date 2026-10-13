from __future__ import annotations

import base64
import json
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from threading import Barrier

from fastapi.testclient import TestClient

import fintracka.api as api_module
from fintracka.api import create_app
from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.jobs import recover_interrupted_jobs
from fintracka.google_sheets import configure_google
from fintracka.keychain import KeychainSecrets
from fintracka.plaid_adapter import ConnectedItem, InstitutionInfo, LinkSession
from fintracka.plaid_service import complete_plaid_connection
from fintracka.providers import NormalizedAccount, NormalizedBalance, NormalizedTransaction, SyncBatch
from fintracka.synthetic import create_synthetic_ledger, synthetic_batches
from fintracka.sync import apply_batch


@dataclass
class FakePlaidAdapter:
    environment: str = "production"
    revoked: list[str] | None = None

    def __post_init__(self) -> None:
        if self.revoked is None:
            self.revoked = []

    def create_link_session(self) -> LinkSession:
        return LinkSession("link-production", "2026-10-12T14:00:00Z", "production")

    def complete_link(self, public_token: str, secret_reference: str) -> ConnectedItem:
        assert public_token == "public-production"
        return ConnectedItem("item-production", secret_reference)

    def connection_info(self, secret_reference: str) -> InstitutionInfo:
        assert secret_reference.startswith("plaid:production:connection:")
        return InstitutionInfo("ins_1", "Example Bank")

    def repair_connection(self, secret_reference: str) -> LinkSession:
        assert secret_reference.startswith("plaid:production:connection:")
        return LinkSession("link-repair", "2026-10-12T15:00:00Z", "production")

    def fetch_updates(self, secret_reference: str, checkpoint: str | None) -> SyncBatch:
        del secret_reference, checkpoint
        account = NormalizedAccount("checking-1", "Everyday Checking", "depository", "checking", "asset", "USD", None)
        return SyncBatch(
            accounts=(account,),
            balances=(NormalizedBalance("checking-1", "2026-10-12T12:00:00Z", 100_00, 90_00, "USD", "plaid"),),
            added=(NormalizedTransaction("txn-1", "checking-1", "2026-10-12T12:00:00Z", -12_34, "USD", "Corner Store", "Corner Store", False),),
            modified=(),
            removed=(),
            next_checkpoint="cursor-1",
            raw_response_hashes=("hash-1",),
        )

    def revoke(self, secret_reference: str) -> None:
        assert self.revoked is not None
        self.revoked.append(secret_reference)


class FakeKeyring:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}

    def set_password(self, service: str, account: str, password: str) -> None:
        self.values[(service, account)] = password

    def get_password(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def delete_password(self, service: str, account: str) -> None:
        self.values.pop((service, account), None)


class FakeGoogleGateway:
    def __init__(self) -> None:
        self.sheets: dict[str, list[list[object]]] = {}

    def create_workbook(self, names: tuple[str, ...]) -> str:
        assert "Transactions" in names
        return "google-workbook"

    def replace_sheet(self, name: str, rows: list[list[object]], batch_size: int) -> None:
        assert batch_size <= 500
        self.sheets[name] = rows

    def protect_sheet(self, name: str, warning: str) -> None:
        assert name in self.sheets and "overwritten" in warning


def test_health_security_headers_and_strict_host(tmp_path: Path) -> None:
    app = create_app(tmp_path / "ledger.sqlite3", bootstrap_token="bootstrap")
    with TestClient(app) as client:
        response = client.get("/api/v1/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        assert response.headers["content-security-policy"].startswith("default-src 'self'")
        assert client.get("/api/v1/health", headers={"host": "evil.example"}).status_code == 400


def test_bootstrap_cookie_csrf_and_origin_protect_mutations(tmp_path: Path) -> None:
    app = create_app(tmp_path / "ledger.sqlite3", bootstrap_token="bootstrap")
    with TestClient(app) as client:
        assert client.post("/api/v1/session/bootstrap", json={"token": "wrong"}).status_code == 401
        response = client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        assert response.status_code == 204
        cookie = response.headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=strict" in cookie
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]

        assert client.post("/api/v1/categories", json=_category_payload()).status_code == 403
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}
        assert client.post("/api/v1/categories", json=_category_payload(), headers=headers).status_code == 201
        assert client.post(
            "/api/v1/categories",
            json={**_category_payload("Extra"), "unexpected": True},
            headers=headers,
        ).status_code == 422
        assert client.post(
            "/api/v1/categories", json=_category_payload("Origin"), headers={**headers, "origin": "https://evil.example"}
        ).status_code == 403


def test_plaid_connection_api_uses_production_csp_and_sanitized_contracts(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection.execute(
        "INSERT INTO app_metadata (key, value) VALUES ('plaid.environment', 'production')"
    )
    connection.close()
    adapter = FakePlaidAdapter()
    app = create_app(
        path,
        bootstrap_token="bootstrap",
        plaid_adapter_factory=lambda _: adapter,
        filevault_checker=lambda: True,
    )

    with TestClient(app) as client:
        health = client.get("/api/v1/health")
        csp = health.headers["content-security-policy"]
        assert "https://cdn.plaid.com/link/v2/stable/link-initialize.js" in csp
        assert "frame-src https://cdn.plaid.com/" in csp
        assert "connect-src 'self' https://production.plaid.com/" in csp
        assert "https://sandbox.plaid.com/" not in csp
        assert "'nonce-" in csp
        assert "form-action 'self'" in csp
        assert health.headers["x-frame-options"] == "DENY"
        assert "payment=()" in health.headers["permissions-policy"]
        assert client.get("/openapi.json").status_code == 404

        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}

        assert client.post("/api/v1/connections/plaid/sessions", json={}).status_code == 403
        session = client.post(
            "/api/v1/connections/plaid/sessions", json={}, headers=headers
        )
        assert session.status_code == 200
        assert session.json() == {
            "link_token": "link-production",
            "expires_at": "2026-10-12T14:00:00Z",
            "environment": "production",
        }

        invalid = client.post(
            "/api/v1/connections/plaid/complete",
            json={"public_token": "public-production", "access_token": "must-not-be-accepted"},
            headers=headers,
        )
        assert invalid.status_code == 422
        completed = client.post(
            "/api/v1/connections/plaid/complete",
            json={"public_token": "public-production"},
            headers=headers,
        )
        assert completed.status_code == 201
        connection_payload = completed.json()
        assert connection_payload["institution_name"] == "Example Bank"
        assert connection_payload["environment"] == "production"
        assert "access_token" not in str(connection_payload)
        connection_id = connection_payload["id"]

        listed = client.get("/api/v1/connections").json()
        assert listed[0]["institution_name"] == "Example Bank"
        assert listed[0]["environment"] == "production"
        assert "keychain" not in str(listed).lower()
        assert "token" not in str(listed).lower()

        repair = client.post(
            f"/api/v1/connections/{connection_id}/repair", json={}, headers=headers
        )
        assert repair.status_code == 200
        assert repair.json() == {
            "link_token": "link-repair",
            "expires_at": "2026-10-12T15:00:00Z",
            "environment": "production",
        }

        sync = client.post("/api/v1/sync-runs", json={}, headers=headers)
        assert sync.status_code == 202
        assert _wait_for_job(client, sync.json()["job_id"])["status"] == "succeeded"
        transactions = client.get("/api/v1/transactions").json()["items"]
        assert [item["description"] for item in transactions] == ["Corner Store"]

        deleted = client.delete(f"/api/v1/connections/{connection_id}", headers=headers)
        assert deleted.status_code == 204
        assert adapter.revoked and adapter.revoked[0].startswith("plaid:production:connection:")
        assert client.get("/api/v1/connections").json()[0]["status"] == "revoked"


def test_first_production_link_creates_backup_and_filevault_is_a_hard_gate(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection.execute(
        "INSERT INTO app_metadata (key, value) VALUES ('plaid.environment', 'production')"
    )
    connection.close()
    adapter = FakePlaidAdapter()

    blocked = create_app(
        path,
        bootstrap_token="blocked",
        plaid_adapter_factory=lambda _: adapter,
        filevault_checker=lambda: False,
    )
    with TestClient(blocked) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "blocked"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        response = client.post(
            "/api/v1/connections/plaid/sessions",
            json={},
            headers={"origin": "http://testserver", "x-csrf-token": csrf},
        )
        assert response.status_code == 409
        assert not list((tmp_path / "backups").glob("*.sqlite3"))

    allowed = create_app(
        path,
        bootstrap_token="allowed",
        plaid_adapter_factory=lambda _: adapter,
        filevault_checker=lambda: True,
    )
    with TestClient(allowed) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "allowed"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        response = client.post(
            "/api/v1/connections/plaid/sessions",
            json={},
            headers={"origin": "http://testserver", "x-csrf-token": csrf},
        )
        assert response.status_code == 200
        backups = list((tmp_path / "backups").glob("fintracka-*.sqlite3"))
        assert len(backups) == 1 and backups[0].stat().st_mode & 0o777 == 0o600


def test_google_authorization_and_export_run_as_persisted_jobs(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    create_synthetic_ledger(connection, count=1)
    keychain = KeychainSecrets(FakeKeyring())
    configure_google(
        connection,
        keychain,
        json.dumps(
            {
                "installed": {
                    "client_id": "desktop.apps.googleusercontent.com",
                    "client_secret": "secret-local",
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": ["http://localhost"],
                }
            }
        ),
    )
    connection.close()
    gateway = FakeGoogleGateway()
    app = create_app(
        path,
        bootstrap_token="bootstrap",
        google_secrets_factory=lambda: keychain,
        google_authorizer=lambda config, scopes: json.dumps(
            {"refresh_token": "refresh-local", "client_id": config["installed"]["client_id"]}
        ),
        google_authorization_gateway_factory=lambda credentials: gateway,
        google_export_gateway_factory=lambda connection, secrets: gateway,
    )

    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}

        authorization = client.post(
            "/api/v1/exports/google/authorize", json={}, headers=headers
        )
        assert authorization.status_code == 202
        assert _wait_for_job(client, authorization.json()["job_id"])["status"] == "succeeded"
        google_export = client.post(
            "/api/v1/exports", json={"target": "google_sheets"}, headers=headers
        )
        assert google_export.status_code == 202
        assert _wait_for_job(client, google_export.json()["job_id"])["status"] == "succeeded"
        assert "Transactions" in gateway.sheets
        assert "refresh-local" not in str(client.get("/api/v1/exports").json())


def test_schedule_is_changed_only_by_explicit_csrf_protected_actions(tmp_path: Path) -> None:
    state = {"installed": False, "loaded": False}

    def install(destination: Path, python: Path, data: Path) -> None:
        del destination, python, data
        state.update(installed=True, loaded=True)

    def remove(destination: Path) -> None:
        del destination
        state.update(installed=False, loaded=False)

    app = create_app(
        tmp_path / "ledger.sqlite3",
        bootstrap_token="bootstrap",
        schedule_installer=install,
        schedule_remover=remove,
        schedule_status_reader=lambda destination: dict(state),
    )
    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}

        assert client.get("/api/v1/settings").json()["schedule_installed"] is False
        assert client.post("/api/v1/settings/schedule", json={}).status_code == 403
        assert client.post("/api/v1/settings/schedule", json={}, headers=headers).json()["loaded"] is True
        assert client.get("/api/v1/settings").json()["schedule_installed"] is True
        assert client.delete("/api/v1/settings/schedule", headers=headers).status_code == 204
        assert state == {"installed": False, "loaded": False}


def test_startup_queues_only_one_catch_up_sync_for_stale_live_connection(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    adapter = FakePlaidAdapter()
    complete_plaid_connection(connection, adapter, "public-production")
    connection.execute(
        "UPDATE provider_connections SET last_success_at = '2026-10-01T00:00:00Z'"
    )
    connection.close()

    app = create_app(path, bootstrap_token="first", plaid_adapter_factory=lambda _: adapter)
    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "first"})
        for _ in range(200):
            check = connect(path)
            row = check.execute(
                "SELECT id, status FROM jobs WHERE kind = 'plaid_sync' ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            check.close()
            if row is not None and row["status"] not in {"queued", "running"}:
                break
            time.sleep(0.01)
        assert row is not None and row["status"] == "succeeded"

    second = create_app(path, bootstrap_token="second", plaid_adapter_factory=lambda _: adapter)
    with TestClient(second):
        pass
    connection = connect(path)
    assert connection.execute(
        "SELECT COUNT(*) FROM jobs WHERE kind = 'plaid_sync'"
    ).fetchone()[0] == 1
    assert connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 1
    connection.close()


def test_transaction_pagination_and_optimistic_conflict(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    apply_batch(connection, connection_id, synthetic_batches([connection_id])[connection_id])
    fun_id = connection.execute("SELECT id FROM categories WHERE name = 'Fun'").fetchone()[0]
    categorized_id = connection.execute(
        "SELECT id FROM transactions WHERE provider_description NOT LIKE '%Fun%' LIMIT 1"
    ).fetchone()[0]
    connection.execute("UPDATE transactions SET category_id = ? WHERE id = ?", (fun_id, categorized_id))
    connection.close()
    app = create_app(path, bootstrap_token="bootstrap")

    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        first = client.get("/api/v1/transactions", params={"limit": 1}).json()
        second = client.get(
            "/api/v1/transactions", params={"limit": 1, "cursor": first["next_cursor"]}
        ).json()
        assert len(first["items"]) == len(second["items"]) == 1
        assert first["items"][0]["id"] != second["items"][0]["id"]
        uncategorized = client.get(
            "/api/v1/transactions", params={"category_id": "uncategorized"}
        ).json()["items"]
        assert uncategorized
        assert all(item["category_id"] is None for item in uncategorized)
        category_search = client.get(
            "/api/v1/transactions", params={"search": "Fun"}
        ).json()["items"]
        assert any(item["id"] == categorized_id for item in category_search)

        transaction = first["items"][0]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}
        changed = client.patch(
            f"/api/v1/transactions/{transaction['id']}",
            json={"expected_updated_at": transaction["updated_at"], "notes": "Reviewed"},
            headers=headers,
        )
        assert changed.status_code == 200 and changed.json()["notes"] == "Reviewed"
        stale = client.patch(
            f"/api/v1/transactions/{transaction['id']}",
            json={"expected_updated_at": transaction["updated_at"], "notes": "Stale"},
            headers=headers,
        )
        assert stale.status_code == 409


def test_spending_owner_account_default_override_and_filter(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    apply_batch(connection, connection_id, synthetic_batches([connection_id])[connection_id])
    account = connection.execute(
        "SELECT id, updated_at FROM accounts WHERE provider_account_id = 'checking-1'"
    ).fetchone()
    groceries = connection.execute("SELECT id FROM categories WHERE name = 'Groceries'").fetchone()[0]
    salary = connection.execute("SELECT id FROM categories WHERE name = 'Salary'").fetchone()[0]
    grocery_id = connection.execute(
        "SELECT transaction_id FROM transaction_external_ids WHERE external_id = 'groceries-1'"
    ).fetchone()[0]
    paycheck_id = connection.execute(
        "SELECT transaction_id FROM transaction_external_ids WHERE external_id = 'paycheck-1'"
    ).fetchone()[0]
    connection.execute("UPDATE transactions SET category_id = ? WHERE id = ?", (groceries, grocery_id))
    connection.execute("UPDATE transactions SET category_id = ? WHERE id = ?", (salary, paycheck_id))
    connection.close()
    app = create_app(path, bootstrap_token="bootstrap")

    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}
        changed = client.patch(
            f"/api/v1/accounts/{account['id']}",
            json={"expected_updated_at": account["updated_at"], "spending_owner": "Ariela"},
            headers=headers,
        )
        assert changed.status_code == 200 and changed.json()["spending_owner"] == "Ariela"

        rows = client.get("/api/v1/transactions", params={"limit": 20}).json()["items"]
        grocery = next(row for row in rows if row["id"] == grocery_id)
        paycheck = next(row for row in rows if row["id"] == paycheck_id)
        assert grocery["spending_owner_effective"] == "Ariela"
        assert paycheck["spending_owner_effective"] is None

        override = client.patch(
            f"/api/v1/transactions/{grocery_id}",
            json={"expected_updated_at": grocery["updated_at"], "spending_owner": "Shared"},
            headers=headers,
        )
        assert override.status_code == 200
        shared = client.get(
            "/api/v1/transactions", params={"spending_owner": "Shared"}
        ).json()["items"]
        assert [row["id"] for row in shared] == [grocery_id]


def test_inline_categorization_learns_past_and_future_merchant_matches(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    batch = synthetic_batches([connection_id])[connection_id]
    first = NormalizedTransaction(
        "coffee-old", "checking-1", "2026-10-01T12:00:00Z", -500, "USD", "CAFE 01", "Corner Cafe"
    )
    second = NormalizedTransaction(
        "coffee-new", "checking-1", "2026-10-02T12:00:00Z", -650, "USD", "CAFE 02", "Corner Cafe"
    )
    apply_batch(connection, connection_id, SyncBatch(accounts=batch.accounts, added=(first, second,), next_checkpoint="p1"))
    transaction = connection.execute(
        "SELECT id, updated_at FROM transactions WHERE provider_description = 'CAFE 02'"
    ).fetchone()
    dining_id = connection.execute("SELECT id FROM categories WHERE name = 'Dining'").fetchone()[0]
    connection.close()
    app = create_app(path, bootstrap_token="bootstrap")

    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        response = client.post(
            f"/api/v1/transactions/{transaction['id']}/categorize",
            json={
                "expected_updated_at": transaction["updated_at"],
                "category_id": dining_id,
                "scope": "past_and_future",
            },
            headers={"origin": "http://testserver", "x-csrf-token": csrf},
        )
        assert response.status_code == 200
        assert response.json()["affected_count"] == 2
        undo_id = response.json()["undo_id"]

    connection = connect(path)
    rows = connection.execute(
        "SELECT provider_description, category_source FROM transactions ORDER BY provider_description"
    ).fetchall()
    assert [tuple(row) for row in rows] == [("CAFE 01", "rule"), ("CAFE 02", "manual")]
    assert connection.execute("SELECT COUNT(*) FROM categorization_rules").fetchone()[0] == 1

    future = NormalizedTransaction(
        "coffee-future", "checking-1", "2026-10-03T12:00:00Z", -700, "USD", "CAFE 03", "Corner Cafe"
    )
    apply_batch(connection, connection_id, SyncBatch(added=(future,), next_checkpoint="p2"))
    assert connection.execute(
        "SELECT c.name FROM transactions t JOIN categories c ON c.id = t.category_id "
        "WHERE t.provider_description = 'CAFE 03'"
    ).fetchone()[0] == "Dining"
    connection.close()

    undo_app = create_app(path, bootstrap_token="undo-bootstrap")
    with TestClient(undo_app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "undo-bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        undone = client.post(
            f"/api/v1/categorizations/{undo_id}/undo",
            json={},
            headers={"origin": "http://testserver", "x-csrf-token": csrf},
        )
        assert undone.status_code == 200 and undone.json()["restored_count"] == 2

    connection = connect(path)
    assert connection.execute(
        "SELECT COUNT(*) FROM transactions WHERE category_id IS NOT NULL"
    ).fetchone()[0] == 1
    assert connection.execute(
        "SELECT enabled FROM categorization_rules WHERE name LIKE 'Learned: %'"
    ).fetchone()[0] == 0
    connection.close()


def test_cash_flow_report_includes_clickable_transaction_drilldowns(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1, demo=True)[0]
    apply_batch(connection, connection_id, synthetic_batches([connection_id])[connection_id])
    connection.close()
    app = create_app(path, bootstrap_token="bootstrap")

    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        response = client.get("/api/v1/reports/flow", params={"month": "2026-10"})

    assert response.status_code == 200
    report = response.json()
    assert any(node["label"] == "Income" for node in report["nodes"])
    assert any(node["label"] == "Groceries" for node in report["nodes"])
    assert all(link["amount_minor"] > 0 for link in report["links"])
    groceries = next(node for node in report["nodes"] if node["label"] == "Groceries")
    assert groceries["entry_ids"]
    assert {entry["id"] for entry in report["entries"]} >= set(groceries["entry_ids"])
    assert all(entry["currency"] == "USD" for entry in report["entries"])


def test_concurrent_account_edits_allow_only_one_expected_version(
    tmp_path: Path,
    monkeypatch,
) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    apply_batch(connection, connection_id, synthetic_batches([connection_id])[connection_id])
    account = dict(connection.execute("SELECT id, updated_at FROM accounts LIMIT 1").fetchone())
    connection.close()
    app = create_app(path, bootstrap_token="bootstrap")
    rendezvous = Barrier(2)

    def simultaneous_now() -> str:
        rendezvous.wait(timeout=5)
        return "2026-10-12T13:00:00.000000Z"

    monkeypatch.setattr(api_module, "_now", simultaneous_now)
    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}

        def update(nickname: str) -> int:
            return client.patch(
                f"/api/v1/accounts/{account['id']}",
                json={"expected_updated_at": account["updated_at"], "nickname": nickname},
                headers=headers,
            ).status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = sorted(executor.map(update, ("First", "Second")))

    assert statuses == [200, 409]


def test_running_jobs_are_marked_interrupted_on_startup(tmp_path: Path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    connection.execute(
        "INSERT INTO jobs (id, kind, status, created_at, started_at) VALUES (?, 'sync', 'running', '2026-10-11T00:00:00Z', '2026-10-11T00:00:01Z')",
        (new_id(),),
    )
    assert recover_interrupted_jobs(connection) == 1
    assert connection.execute("SELECT status FROM jobs").fetchone()[0] == "interrupted"
    connection.close()


def test_production_frontend_and_router_fallback_are_served(tmp_path: Path) -> None:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "index.html").write_text("<title>FinTracka</title>", encoding="utf-8")
    app = create_app(
        tmp_path / "ledger.sqlite3",
        bootstrap_token="bootstrap",
        static_directory=frontend,
    )
    with TestClient(app) as client:
        assert "<title>FinTracka</title>" in client.get("/").text
        assert "<title>FinTracka</title>" in client.get("/transactions").text
        assert client.get("/api/v1/missing").status_code == 401


def test_rule_split_and_transfer_workflow_routes(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    apply_batch(connection, connection_id, synthetic_batches([connection_id])[connection_id])
    transaction = connection.execute(
        "SELECT id, updated_at, amount_minor FROM transactions WHERE amount_minor < 0 LIMIT 1"
    ).fetchone()
    connection.close()
    app = create_app(path, bootstrap_token="bootstrap")
    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}
        category = client.post("/api/v1/categories", json=_category_payload(), headers=headers).json()
        rule = client.post(
            "/api/v1/rules",
            json={"name": "Markets", "priority": 10, "conditions": {"description_contains": "MARKET"}, "category_id": category["id"]},
            headers=headers,
        )
        assert rule.status_code == 201
        assert client.post("/api/v1/rules/preview", json={}, headers=headers).json()[0]["match_count"] == 1
        assert client.post(
            f"/api/v1/transactions/{transaction['id']}/split",
            json={
                "expected_updated_at": transaction["updated_at"],
                "splits": [
                    {"amount_minor": -4000, "category_id": category["id"], "notes": "Food"},
                    {"amount_minor": transaction["amount_minor"] + 4000, "category_id": category["id"], "notes": "Other"},
                ],
            },
            headers=headers,
        ).status_code == 200

        invalid_rule = client.post(
            "/api/v1/rules",
            json={"name": "Broken", "priority": 11, "conditions": {"min_amount_minor": "oops"}, "category_id": category["id"]},
            headers=headers,
        )
        assert invalid_rule.status_code == 422
        assert client.post("/api/v1/rules/preview", json={}, headers=headers).status_code == 200


def test_management_reports_reconciliation_and_local_operation_jobs(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection_ids = create_synthetic_ledger(connection, count=1, demo=True)
    apply_batch(connection, connection_ids[0], synthetic_batches(connection_ids)[connection_ids[0]])
    account = dict(connection.execute("SELECT id, updated_at FROM accounts WHERE provider_account_id = 'checking-1'").fetchone())
    transactions = [dict(row) for row in connection.execute("SELECT id, updated_at FROM transactions ORDER BY id LIMIT 2")]
    activity = connection.execute(
        "SELECT SUM(amount_minor) FROM transactions WHERE account_id = ? AND local_date BETWEEN '2026-10-01' AND '2026-10-31'",
        (account["id"],),
    ).fetchone()[0]
    connection.close()

    app = create_app(path, bootstrap_token="bootstrap")
    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}

        changed = client.patch(
            f"/api/v1/accounts/{account['id']}",
            json={"expected_updated_at": account["updated_at"], "nickname": "Daily cash", "include_export": False},
            headers=headers,
        )
        assert changed.status_code == 200
        assert changed.json()["nickname"] == "Daily cash" and changed.json()["include_export"] == 0

        bulk = client.post(
            "/api/v1/transactions/bulk",
            json={"items": [{"id": item["id"], "expected_updated_at": item["updated_at"], "notes": "Checked"} for item in transactions]},
            headers=headers,
        )
        assert bulk.status_code == 200 and len(bulk.json()) == 2
        assert all(item["notes"] == "Checked" for item in bulk.json())

        group = client.post(
            "/api/v1/category-groups",
            json={"name": "Goals", "sort_order": 90},
            headers=headers,
        )
        assert group.status_code == 201
        assert any(item["name"] == "Goals" for item in client.get("/api/v1/category-groups").json())
        encoded = base64.b64encode(
            b"date,amount,currency,description\n2026-11-01,-12.34,USD,Imported lunch\n"
        ).decode()
        import_payload = {"account_id": account["id"], "filename": "statement.csv", "content_base64": encoded}
        preview = client.post("/api/v1/imports/csv/preview", json=import_payload, headers=headers)
        assert preview.status_code == 200 and preview.json()["row_count"] == 1
        assert client.post("/api/v1/imports/csv/commit", json=import_payload, headers=headers).status_code == 201
        assert client.post("/api/v1/imports/csv/commit", json=import_payload, headers=headers).status_code == 409
        oversized = {**import_payload, "content_base64": "A" * 6_700_001}
        assert client.post("/api/v1/imports/csv/preview", json=oversized, headers=headers).status_code == 422
        assert client.get("/api/v1/reports/budget", params={"month": "2026-10"}).status_code == 200
        assert client.get("/api/v1/reports/balances").json()

        category = client.get("/api/v1/categories").json()[0]
        tracking = client.put(
            "/api/v1/budgets/tracking/2026-11",
            json={"category_id": category["id"], "amount_minor": 45_000},
            headers=headers,
        )
        assert tracking.status_code == 200
        assert any(row["target_minor"] == 45_000 for row in tracking.json())
        envelope = client.put(
            "/api/v1/budgets/envelope/2026-11",
            json={"starting_pool_minor": 100_000, "category_id": category["id"], "allocation_minor": 30_000},
            headers=headers,
        )
        assert envelope.status_code == 200
        assert envelope.json()["available_to_assign_minor"] == 70_000

        reconciliation = client.post(
            "/api/v1/reconciliations",
            json={
                "account_id": account["id"],
                "period_start": "2026-10-01",
                "period_end": "2026-10-31",
                "opening_minor": 0,
                "closing_minor": activity,
                "cleared_cutoff": "2026-10-31",
            },
            headers=headers,
        )
        assert reconciliation.status_code == 201 and reconciliation.json()["status"] == "balanced"

        export_job = client.post("/api/v1/exports", json={"target": "excel"}, headers=headers)
        backup_job = client.post("/api/v1/backups", json={}, headers=headers)
        assert export_job.status_code == backup_job.status_code == 202
        assert _wait_for_job(client, export_job.json()["job_id"])["status"] == "succeeded"
        assert _wait_for_job(client, backup_job.json()["job_id"])["status"] == "succeeded"
        assert (tmp_path / "exports" / "FinTracka.xlsx").is_file()
        assert list((tmp_path / "backups").glob("fintracka-*.sqlite3"))


def test_planning_api_manages_income_targets_and_returns_complete_snapshot(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    shopping = connection.execute("SELECT id FROM categories WHERE name = 'Shopping'").fetchone()[0]
    tzedaka = connection.execute("SELECT id FROM categories WHERE name = 'Tzedaka'").fetchone()[0]
    connection.close()
    app = create_app(path, bootstrap_token="bootstrap")

    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}
        salary_payload = {
            "title": "Paycheck",
            "income_type": "Salary",
            "amount_minor": 590_001,
            "effective_month": "2026-10",
        }
        assert client.post("/api/v1/planning/income-sources", json=salary_payload).status_code == 403
        salary = client.post(
            "/api/v1/planning/income-sources", json=salary_payload, headers=headers
        )
        assert salary.status_code == 201
        assert set(salary.json()) == {
            "source_id", "title", "income_type", "amount_minor", "active", "effective_month", "updated_at"
        }
        custom = client.post(
            "/api/v1/planning/income-sources",
            json={"title": "Rental", "income_type": "Custom", "amount_minor": 110_000, "effective_month": "2026-10"},
            headers=headers,
        )
        assert custom.status_code == 201
        target = client.put(
            f"/api/v1/planning/targets/{shopping}",
            json={"effective_month": "2026-10", "amount_minor": 40_000},
            headers=headers,
        )
        assert target.status_code == 200

        result = client.get("/api/v1/planning/2026-10", params={"average_months": 12})
        assert result.status_code == 200
        body = result.json()
        assert body["planned_income_total_minor"] == 700_001
        assert body["salary_total_minor"] == 590_001
        assert body["tzedaka_minimum_minor"] == 59_001
        assert {row["income_type"] for row in body["incomes"]} == {"Salary", "Custom"}
        shopping_row = next(row for row in body["categories"] if row["category_id"] == shopping)
        assert set(shopping_row) >= {
            "historical_average_minor", "target_minor", "actual_minor", "remaining_minor",
            "status", "trend", "transaction_ids",
        }
        assert shopping_row["target_minor"] == 40_000 and len(shopping_row["trend"]) == 12
        assert body["surplus_shortfall_minor"] == body["planned_income_total_minor"] - body["target_total_minor"]

        below = client.put(
            f"/api/v1/planning/targets/{tzedaka}",
            json={"effective_month": "2026-10", "amount_minor": 59_000},
            headers=headers,
        )
        assert below.status_code == 422
        assert below.json()["detail"] == {
            "message": "Tzedaka target is below the Salary minimum",
            "minimum_minor": 59_001,
        }
        assert "sql" not in below.text.lower()


def test_planning_api_rejects_invalid_values_unexpected_fields_and_stale_edits(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    app = create_app(path, bootstrap_token="bootstrap")
    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}
        for params in (
            {"average_months": 0},
            {"average_months": 13},
            {"average_months": 3, "spending_owner": "Nobody"},
        ):
            assert client.get("/api/v1/planning/2026-10", params=params).status_code == 422
        assert client.get("/api/v1/planning/not-a-month", params={"average_months": 3}).status_code == 422
        invalid_payloads = [
            {"title": "Pay", "income_type": "Other", "amount_minor": 100, "effective_month": "2026-10"},
            {"title": "Pay", "income_type": "Salary", "amount_minor": -1, "effective_month": "2026-10"},
            {"title": "Pay", "income_type": "Salary", "amount_minor": 10**16, "effective_month": "2026-10"},
            {"title": "Pay", "income_type": "Salary", "amount_minor": 100, "effective_month": "2026-10", "secret": "no"},
        ]
        for payload in invalid_payloads:
            assert client.post("/api/v1/planning/income-sources", json=payload, headers=headers).status_code == 422
        created = client.post(
            "/api/v1/planning/income-sources",
            json={"title": "Pay", "income_type": "Salary", "amount_minor": 100, "effective_month": "2026-10"},
            headers=headers,
        ).json()
        stale = client.patch(
            f"/api/v1/planning/income-sources/{created['source_id']}",
            json={
                "expected_updated_at": "2000-01-01T00:00:00Z", "title": "Changed",
                "income_type": "Salary", "amount_minor": 100, "effective_month": "2026-11", "active": True,
            },
            headers=headers,
        )
        assert stale.status_code == 409


def test_manual_cash_api_defaults_edits_deletes_and_protects_provider_rows(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    apply_batch(connection, connection_id, synthetic_batches([connection_id])[connection_id])
    provider_id = connection.execute(
        "SELECT id FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE connection_id = ?) LIMIT 1",
        (connection_id,),
    ).fetchone()[0]
    shopping = connection.execute("SELECT id FROM categories WHERE name = 'Shopping'").fetchone()[0]
    connection.close()
    app = create_app(path, bootstrap_token="bootstrap")

    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}
        created = client.post(
            "/api/v1/transactions/manual-cash",
            json={"title": "Cash purchase", "amount_minor": 2_500, "category_id": shopping},
            headers=headers,
        )
        assert created.status_code == 201
        item = created.json()
        assert item["manual_cash"] is True and item["spending_owner_effective"] == "Shared"
        assert item["local_date"] == date.today().isoformat()
        listed = client.get("/api/v1/transactions", params={"search": "Cash purchase"}).json()["items"]
        assert [row["id"] for row in listed] == [item["id"]]
        edited = client.patch(
            f"/api/v1/transactions/manual-cash/{item['id']}",
            json={
                "expected_updated_at": item["updated_at"], "title": "Edited cash", "amount_minor": 2_000,
                "category_id": shopping, "local_date": "2026-10-12", "spending_owner": "David",
            },
            headers=headers,
        )
        assert edited.status_code == 200
        assert edited.json()["amount_minor"] == -2_000
        assert client.delete(
            f"/api/v1/transactions/{item['id']}",
            params={"expected_updated_at": edited.json()["updated_at"]},
            headers=headers,
        ).status_code == 204
        assert client.delete(
            f"/api/v1/transactions/{provider_id}",
            params={"expected_updated_at": "anything"},
            headers=headers,
        ).status_code == 403


def test_withdrawal_api_exposes_marker_and_forces_single_categorization(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    withdrawal = NormalizedTransaction(
        "atm-api", "checking-1", "2026-10-13T12:00:00Z", -5_000, "USD", "ATM WITHDRAWAL",
        is_cash_withdrawal=True,
    )
    apply_batch(connection, connection_id, SyncBatch(added=(withdrawal,), next_checkpoint="atm"))
    transaction = dict(connection.execute(
        "SELECT id, updated_at FROM transactions WHERE provider_description = 'ATM WITHDRAWAL'"
    ).fetchone())
    shopping = connection.execute("SELECT id FROM categories WHERE name = 'Shopping'").fetchone()[0]
    connection.close()
    app = create_app(path, bootstrap_token="bootstrap")
    with TestClient(app) as client:
        client.post("/api/v1/session/bootstrap", json={"token": "bootstrap"})
        csrf = client.get("/api/v1/session/csrf").json()["csrf_token"]
        headers = {"origin": "http://testserver", "x-csrf-token": csrf}
        row = client.get("/api/v1/transactions", params={"search": "ATM WITHDRAWAL"}).json()["items"][0]
        assert row["is_cash_withdrawal"] is True
        result = client.post(
            f"/api/v1/transactions/{transaction['id']}/categorize",
            json={"expected_updated_at": transaction["updated_at"], "category_id": shopping, "scope": "past_and_future"},
            headers=headers,
        )
        assert result.status_code == 200 and result.json()["affected_count"] == 1


def _category_payload(name: str = "Test expense") -> dict[str, str | int]:
    return {
        "name": name,
        "category_type": "expense",
        "reporting_behavior": "ordinary",
        "sort_order": 10,
    }


def _wait_for_job(client: TestClient, job_id: str) -> dict[str, object]:
    for _ in range(200):
        response = client.get(f"/api/v1/jobs/{job_id}")
        if response.status_code == 200 and response.json()["status"] not in {"queued", "running"}:
            return response.json()
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not finish")
