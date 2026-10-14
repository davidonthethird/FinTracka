from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.keychain import KeychainSecrets, store_secret_reference
from fintracka.plaid_adapter import OfficialPlaidClient, PlaidAdapter, PlaidError, ProviderActionRequired
from fintracka.plaid_adapter import _transaction as normalize_transaction


def test_official_client_uses_certifi_ca_bundle(monkeypatch: pytest.MonkeyPatch) -> None:
    import certifi
    import plaid
    from plaid.api import plaid_api

    captured = None

    def api_client(configuration):  # type: ignore[no-untyped-def]
        nonlocal captured
        captured = configuration
        return object()

    monkeypatch.setattr(plaid, "ApiClient", api_client)
    monkeypatch.setattr(plaid_api, "PlaidApi", lambda _: object())

    OfficialPlaidClient("client", "secret", "production")

    assert captured is not None
    assert captured.ssl_ca_cert == certifi.where()


def test_keychain_keeps_secret_out_of_sqlite(tmp_path) -> None:
    connection = connect(tmp_path / "ledger.sqlite3")
    migrate(connection)
    connection_id = _connection(connection)
    backend = FakeKeyring()
    secrets = KeychainSecrets(backend)
    reference = f"connection:{connection_id}"
    secrets.put(reference, "access-secret-token")
    store_secret_reference(connection, connection_id, secrets.service, reference)

    assert secrets.get(reference) == "access-secret-token"
    dump = "\n".join(connection.iterdump())
    assert "access-secret-token" not in dump
    assert reference in dump
    secrets.delete(reference)
    assert secrets.get(reference) is None
    connection.close()


def test_link_requests_transactions_only_and_completion_returns_no_token() -> None:
    client = FakePlaidClient()
    secrets = KeychainSecrets(FakeKeyring())
    adapter = PlaidAdapter(client, secrets, environment="production", sleep=lambda _: None)

    session = adapter.create_link_session()
    connected = adapter.complete_link("public-sandbox-token", "connection:test")

    assert session.link_token == "link-token"
    assert session.environment == "production"
    assert client.link_requests[0]["products"] == ["transactions"]
    assert client.link_requests[0]["transactions"] == {"days_requested": 730}
    assert "auth" not in json.dumps(client.link_requests[0]).lower()
    assert connected.external_connection_id == "item-1"
    assert not hasattr(connected, "access_token")
    assert secrets.get("connection:test") == "access-secret-token"


def test_link_session_normalizes_sdk_datetime_expiration() -> None:
    client = FakePlaidClient()
    client.create_link_token = lambda _: {  # type: ignore[method-assign]
        "link_token": "link-token",
        "expiration": datetime(2026, 10, 13, tzinfo=timezone.utc),
    }

    session = PlaidAdapter(client, KeychainSecrets(FakeKeyring())).create_link_session()

    assert session.expiration == "2026-10-13T00:00:00Z"


def test_link_completion_revokes_item_when_keychain_write_fails() -> None:
    client = FakePlaidClient()
    adapter = PlaidAdapter(client, KeychainSecrets(FailingKeyring()), sleep=lambda _: None)

    with pytest.raises(Exception, match="Keychain"):
        adapter.complete_link("public-sandbox-token", "connection:test")

    assert client.removed == ["access-secret-token"]


def test_paginated_sync_normalizes_amounts_and_restarts_after_mutation() -> None:
    client = FakePlaidClient(
        sync_results=[
            _page("c1", has_more=True, external_id="first"),
            PlaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"),
            _page("c1", has_more=True, external_id="first"),
            _page("c2", has_more=False, external_id="second"),
        ]
    )
    secrets = KeychainSecrets(FakeKeyring())
    secrets.put("connection:test", "access-secret-token")
    adapter = PlaidAdapter(client, secrets, sleep=lambda _: None)

    batch = adapter.fetch_updates("connection:test", None)

    assert client.sync_cursors == [None, "c1", None, "c1"]
    assert [account.external_id for account in batch.accounts] == ["checking-1"]
    assert [transaction.external_id for transaction in batch.added] == ["first", "second"]
    assert [transaction.amount_minor for transaction in batch.added] == [-1234, -1234]
    assert batch.added[0].provider_category_primary == "FOOD_AND_DRINK"
    assert batch.added[0].provider_category_detailed == "FOOD_AND_DRINK_GROCERIES"
    assert batch.added[0].provider_category_confidence == "VERY_HIGH"
    assert batch.next_checkpoint == "c2"


@pytest.mark.parametrize(
    ("detailed", "description", "expected"),
    [
        ("CASH_WITHDRAWAL", "Bank transaction", True),
        ("CASH_ADVANCE", "Bank transaction", True),
        (None, "ATM WITHDRAWAL 1234", True),
        (None, "CASH & CARRY MARKET", False),
        (None, "CASHBACK REWARD", False),
    ],
)
def test_plaid_normalization_detects_only_cash_withdrawals(
    detailed: str | None, description: str, expected: bool
) -> None:
    normalized = normalize_transaction(
        {
            "transaction_id": "withdrawal",
            "account_id": "checking-1",
            "date": "2026-10-13",
            "amount": "20.00",
            "name": description,
            "personal_finance_category": {
                "primary": "LOAN_PAYMENTS" if detailed else "OTHER",
                "detailed": detailed,
                "confidence_level": "HIGH",
            },
        }
    )
    assert normalized.is_cash_withdrawal is expected


def test_transient_failures_retry_but_consent_errors_require_repair() -> None:
    transient = FakePlaidClient(
        sync_results=[PlaidError("RATE_LIMIT_EXCEEDED"), _page("c1", has_more=False)]
    )
    secrets = KeychainSecrets(FakeKeyring())
    secrets.put("connection:test", "access-secret-token")
    batch = PlaidAdapter(transient, secrets, sleep=lambda _: None).fetch_updates("connection:test", None)
    assert batch.next_checkpoint == "c1" and len(transient.sync_cursors) == 2

    expired = FakePlaidClient(sync_results=[PlaidError("ITEM_LOGIN_REQUIRED")])
    with pytest.raises(ProviderActionRequired, match="repair"):
        PlaidAdapter(expired, secrets, sleep=lambda _: None).fetch_updates("connection:test", None)


def test_repair_and_revoke_use_stored_secret() -> None:
    client = FakePlaidClient()
    secrets = KeychainSecrets(FakeKeyring())
    secrets.put("connection:test", "access-secret-token")
    adapter = PlaidAdapter(client, secrets, sleep=lambda _: None)

    adapter.repair_connection("connection:test")
    adapter.revoke("connection:test")
    assert client.link_requests[-1]["access_token"] == "access-secret-token"
    assert client.removed == ["access-secret-token"]
    assert secrets.get("connection:test") is None


def test_revoke_treats_already_removed_item_as_success() -> None:
    client = FakePlaidClient(remove_error=PlaidError("ITEM_NOT_FOUND"))
    secrets = KeychainSecrets(FakeKeyring())
    secrets.put("connection:test", "access-secret-token")

    PlaidAdapter(client, secrets, sleep=lambda _: None).revoke("connection:test")

    assert secrets.get("connection:test") is None


class FakeKeyring:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}

    def set_password(self, service: str, account: str, password: str) -> None:
        self.values[(service, account)] = password

    def get_password(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def delete_password(self, service: str, account: str) -> None:
        self.values.pop((service, account), None)


class FailingKeyring(FakeKeyring):
    def set_password(self, service: str, account: str, password: str) -> None:
        raise RuntimeError("locked")


class FakePlaidClient:
    def __init__(self, sync_results=None, remove_error: Exception | None = None) -> None:
        self.link_requests: list[dict[str, object]] = []
        self.sync_results = list(sync_results or [])
        self.sync_cursors: list[str | None] = []
        self.removed: list[str] = []
        self.account_requests: list[str] = []
        self.remove_error = remove_error

    def create_link_token(self, request: dict[str, object]) -> dict[str, str]:
        self.link_requests.append(request)
        return {"link_token": "link-token", "expiration": "2026-10-11T01:00:00Z"}

    def exchange_public_token(self, public_token: str) -> dict[str, str]:
        assert public_token == "public-sandbox-token"
        return {"access_token": "access-secret-token", "item_id": "item-1"}

    def sync(self, access_token: str, cursor: str | None) -> dict[str, object]:
        assert access_token == "access-secret-token"
        self.sync_cursors.append(cursor)
        result = self.sync_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    def accounts(self, access_token: str) -> dict[str, object]:
        self.account_requests.append(access_token)
        return {
            "accounts": [
                {
                    "account_id": "checking-1",
                    "name": "Checking",
                    "type": "depository",
                    "subtype": "checking",
                    "mask": "1234",
                    "balances": {
                        "current": 1000.0,
                        "available": 900.0,
                        "iso_currency_code": "USD",
                    },
                }
            ]
        }

    def remove_item(self, access_token: str) -> None:
        self.removed.append(access_token)
        if self.remove_error:
            raise self.remove_error

    def item(self, access_token: str) -> dict[str, object]:
        return {"item": {"item_id": "item-1", "institution_id": "ins_1"}}

    def institution(self, institution_id: str) -> dict[str, object]:
        return {"institution": {"institution_id": institution_id, "name": "Test Bank"}}


def _page(cursor: str, *, has_more: bool, external_id: str = "txn") -> dict[str, object]:
    return {
        "added": [
            {
                "transaction_id": external_id,
                "account_id": "checking-1",
                "datetime": "2026-10-10T12:00:00Z",
                "amount": "12.34",
                "iso_currency_code": "USD",
                "name": "Merchant",
                "merchant_name": "Merchant",
                "pending": False,
                "personal_finance_category": {
                    "primary": "FOOD_AND_DRINK",
                    "detailed": "FOOD_AND_DRINK_GROCERIES",
                    "confidence_level": "VERY_HIGH",
                },
            }
        ],
        "modified": [],
        "removed": [],
        "has_more": has_more,
        "next_cursor": cursor,
        "request_id": "redacted-by-hash",
    }


def _connection(connection) -> str:
    now = "2026-10-11T00:00:00Z"
    institution_id = new_id()
    connection_id = new_id()
    connection.execute(
        "INSERT INTO institutions (id, provider, external_id, name, created_at) VALUES (?, 'plaid', 'ins_1', 'Sandbox', ?)",
        (institution_id, now),
    )
    connection.execute(
        "INSERT INTO provider_connections (id, provider, external_connection_id, institution_id, status, created_at, updated_at) VALUES (?, 'plaid', 'item-1', ?, 'active', ?, ?)",
        (connection_id, institution_id, now, now),
    )
    return connection_id
