from __future__ import annotations

import base64
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from threading import Barrier

from fastapi.testclient import TestClient

import fintracka.api as api_module
from fintracka.api import create_app
from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.jobs import recover_interrupted_jobs
from fintracka.plaid_adapter import ConnectedItem, InstitutionInfo, LinkSession
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
    app = create_app(path, bootstrap_token="bootstrap", plaid_adapter_factory=lambda _: adapter)

    with TestClient(app) as client:
        health = client.get("/api/v1/health")
        csp = health.headers["content-security-policy"]
        assert "https://cdn.plaid.com/link/v2/stable/link-initialize.js" in csp
        assert "frame-src https://cdn.plaid.com/" in csp
        assert "connect-src 'self' https://production.plaid.com/" in csp
        assert "https://sandbox.plaid.com/" not in csp
        assert "'nonce-" in csp

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


def test_transaction_pagination_and_optimistic_conflict(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite3"
    connection = connect(path)
    migrate(connection)
    connection_id = create_synthetic_ledger(connection, count=1)[0]
    apply_batch(connection, connection_id, synthetic_batches([connection_id])[connection_id])
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


def _category_payload(name: str = "Groceries") -> dict[str, str | int]:
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
