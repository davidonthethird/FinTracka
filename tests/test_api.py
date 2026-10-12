from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from fintracka.api import create_app
from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.jobs import recover_interrupted_jobs
from fintracka.synthetic import create_synthetic_ledger, synthetic_batches
from fintracka.sync import apply_batch


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


def _category_payload(name: str = "Groceries") -> dict[str, str | int]:
    return {
        "name": name,
        "category_type": "expense",
        "reporting_behavior": "ordinary",
        "sort_order": 10,
    }
