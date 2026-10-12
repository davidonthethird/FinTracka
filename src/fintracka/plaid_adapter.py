from __future__ import annotations

import hashlib
import json
import random
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Literal, Protocol

from fintracka.keychain import KeychainSecrets, SecretStoreUnavailable
from fintracka.money import minor_units
from fintracka.providers import NormalizedAccount, NormalizedBalance, NormalizedTransaction, SyncBatch


class PlaidError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class ProviderActionRequired(RuntimeError):
    pass


class PlaidClient(Protocol):
    def create_link_token(self, request: dict[str, object]) -> dict[str, str]: ...
    def exchange_public_token(self, public_token: str) -> dict[str, str]: ...
    def accounts(self, access_token: str) -> dict[str, object]: ...
    def item(self, access_token: str) -> dict[str, object]: ...
    def institution(self, institution_id: str) -> dict[str, object]: ...
    def sync(self, access_token: str, cursor: str | None) -> dict[str, object]: ...
    def remove_item(self, access_token: str) -> None: ...


class OfficialPlaidClient:
    """Narrow wrapper around the generated official SDK used by the tested adapter."""

    def __init__(self, client_id: str, secret: str, environment: Literal["sandbox", "production"]) -> None:
        import plaid
        from plaid.api import plaid_api

        hosts = {"sandbox": plaid.Environment.Sandbox, "production": plaid.Environment.Production}
        configuration = plaid.Configuration(
            host=hosts[environment],
            api_key={"clientId": client_id, "secret": secret},
        )
        self._api = plaid_api.PlaidApi(plaid.ApiClient(configuration))

    def create_link_token(self, request: dict[str, object]) -> dict[str, object]:
        from plaid.model.country_code import CountryCode
        from plaid.model.link_token_create_request import LinkTokenCreateRequest
        from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
        from plaid.model.products import Products

        values = dict(request)
        values["user"] = LinkTokenCreateRequestUser(**values["user"])
        values["country_codes"] = [CountryCode(code) for code in values["country_codes"]]
        if "products" in values:
            values["products"] = [Products(product) for product in values["products"]]
        return self._invoke("link_token_create", LinkTokenCreateRequest(**values))

    def exchange_public_token(self, public_token: str) -> dict[str, object]:
        from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest

        return self._invoke(
            "item_public_token_exchange",
            ItemPublicTokenExchangeRequest(public_token=public_token),
        )

    def accounts(self, access_token: str) -> dict[str, object]:
        from plaid.model.accounts_get_request import AccountsGetRequest

        return self._invoke("accounts_get", AccountsGetRequest(access_token=access_token))

    def item(self, access_token: str) -> dict[str, object]:
        from plaid.model.item_get_request import ItemGetRequest

        return self._invoke("item_get", ItemGetRequest(access_token=access_token))

    def institution(self, institution_id: str) -> dict[str, object]:
        from plaid.model.country_code import CountryCode
        from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest

        return self._invoke(
            "institutions_get_by_id",
            InstitutionsGetByIdRequest(institution_id=institution_id, country_codes=[CountryCode("US")]),
        )

    def sync(self, access_token: str, cursor: str | None) -> dict[str, object]:
        from plaid.model.transactions_sync_request import TransactionsSyncRequest

        values = {"access_token": access_token, "count": 500}
        if cursor is not None:
            values["cursor"] = cursor
        return self._invoke("transactions_sync", TransactionsSyncRequest(**values))

    def remove_item(self, access_token: str) -> None:
        from plaid.model.item_remove_request import ItemRemoveRequest

        self._invoke("item_remove", ItemRemoveRequest(access_token=access_token))

    def _invoke(self, method: str, request):  # type: ignore[no-untyped-def]
        try:
            response = getattr(self._api, method)(request)
            return response.to_dict()
        except Exception as error:
            code = _plaid_error_code(error)
            if code:
                raise PlaidError(code) from error
            raise


@dataclass(frozen=True)
class LinkSession:
    link_token: str
    expiration: str
    environment: Literal["sandbox", "production"]


@dataclass(frozen=True)
class ConnectedItem:
    external_connection_id: str
    secret_reference: str


@dataclass(frozen=True)
class InstitutionInfo:
    external_id: str
    name: str


class PlaidAdapter:
    _TRANSIENT = {"RATE_LIMIT_EXCEEDED", "INTERNAL_SERVER_ERROR", "INSTITUTION_DOWN"}
    _REPAIR = {"ITEM_LOGIN_REQUIRED", "ACCESS_NOT_GRANTED", "ITEM_LOCKED", "USER_PERMISSION_REVOKED"}
    _MUTATION = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"

    def __init__(
        self,
        client: PlaidClient,
        secrets: KeychainSecrets,
        *,
        environment: Literal["sandbox", "production"] = "sandbox",
        sleep: Callable[[float], None] = time.sleep,
        jitter: Callable[[], float] = random.random,
    ) -> None:
        self.client = client
        self.secrets = secrets
        self.environment = environment
        self.sleep = sleep
        self.jitter = jitter

    def create_link_session(self) -> LinkSession:
        response = self._retry(
            lambda: self.client.create_link_token(
                {
                    "client_name": "FinTracka",
                    "language": "en",
                    "country_codes": ["US"],
                    "products": ["transactions"],
                    "user": {"client_user_id": "local-user"},
                }
            )
        )
        return LinkSession(response["link_token"], response["expiration"], self.environment)

    def complete_link(self, public_token: str, secret_reference: str) -> ConnectedItem:
        response = self._retry(lambda: self.client.exchange_public_token(public_token))
        access_token = response["access_token"]
        try:
            self.secrets.put(secret_reference, access_token)
        except SecretStoreUnavailable:
            try:
                self._retry(lambda: self.client.remove_item(access_token))
            except Exception:
                pass
            raise
        return ConnectedItem(response["item_id"], secret_reference)

    def repair_connection(self, secret_reference: str) -> LinkSession:
        access_token = self._secret(secret_reference)
        response = self._retry(
            lambda: self.client.create_link_token(
                {
                    "client_name": "FinTracka",
                    "language": "en",
                    "country_codes": ["US"],
                    "access_token": access_token,
                    "user": {"client_user_id": "local-user"},
                }
            )
        )
        return LinkSession(response["link_token"], response["expiration"], self.environment)

    def connection_info(self, secret_reference: str) -> InstitutionInfo:
        access_token = self._secret(secret_reference)
        item_response = self._retry(lambda: self.client.item(access_token))
        item = item_response["item"]
        institution_id = str(item["institution_id"])
        response = self._retry(lambda: self.client.institution(institution_id))
        institution = response["institution"]
        return InstitutionInfo(institution_id, str(institution["name"]))

    def fetch_updates(self, secret_reference: str, checkpoint: str | None) -> SyncBatch:
        access_token = self._secret(secret_reference)
        account_response = self._retry(lambda: self.client.accounts(access_token))
        observed_at = str(account_response.get("observed_at") or _now())
        accounts: dict[str, NormalizedAccount] = {}
        balances: dict[str, NormalizedBalance] = {}
        for raw_account in account_response.get("accounts", []):
            account, balance = _account(raw_account, observed_at)
            accounts[account.external_id] = account
            balances[account.external_id] = balance
        account_hash = hashlib.sha256(
            json.dumps(account_response, sort_keys=True, default=str, separators=(",", ":")).encode()
        ).hexdigest()
        for restart in range(3):
            cursor = checkpoint
            added: list[NormalizedTransaction] = []
            modified: list[NormalizedTransaction] = []
            removed: list[str] = []
            hashes: list[str] = [account_hash]
            try:
                while True:
                    response = self._retry(lambda: self.client.sync(access_token, cursor))
                    hashes.append(
                        hashlib.sha256(
                            json.dumps(response, sort_keys=True, default=str, separators=(",", ":")).encode()
                        ).hexdigest()
                    )
                    observed_at = str(response.get("observed_at") or _now())
                    for raw_account in response.get("accounts", []):
                        account, balance = _account(raw_account, observed_at)
                        accounts[account.external_id] = account
                        balances[account.external_id] = balance
                    added.extend(_transaction(item) for item in response.get("added", []))
                    modified.extend(_transaction(item) for item in response.get("modified", []))
                    removed.extend(
                        item["transaction_id"] if isinstance(item, dict) else str(item)
                        for item in response.get("removed", [])
                    )
                    cursor = str(response["next_cursor"])
                    if not response.get("has_more"):
                        return SyncBatch(
                            accounts=tuple(accounts.values()),
                            balances=tuple(balances.values()),
                            added=tuple(added),
                            modified=tuple(modified),
                            removed=tuple(removed),
                            next_checkpoint=cursor,
                            raw_response_hashes=tuple(hashes),
                        )
            except PlaidError as error:
                if error.code == self._MUTATION and restart < 2:
                    continue
                raise
        raise RuntimeError("Plaid pagination could not stabilize")

    def revoke(self, secret_reference: str) -> None:
        access_token = self._secret(secret_reference)
        try:
            self._retry(lambda: self.client.remove_item(access_token))
        except PlaidError as error:
            if error.code != "ITEM_NOT_FOUND":
                raise
        self.secrets.delete(secret_reference)

    def _secret(self, reference: str) -> str:
        value = self.secrets.get(reference)
        if value is None:
            raise SecretStoreUnavailable("provider credential is missing from macOS Keychain")
        return value

    def _retry(self, operation):  # type: ignore[no-untyped-def]
        for attempt in range(5):
            try:
                return operation()
            except PlaidError as error:
                if error.code in self._REPAIR:
                    raise ProviderActionRequired("connection requires repair") from error
                if error.code not in self._TRANSIENT or attempt == 4:
                    raise
                self.sleep((0.25 * (2**attempt)) + (0.1 * self.jitter()))
        raise AssertionError("retry loop exhausted")


def _account(raw: dict[str, object], observed_at: str) -> tuple[NormalizedAccount, NormalizedBalance]:
    account_type = str(raw["type"])
    currency = str(raw.get("balances", {}).get("iso_currency_code") or "USD")  # type: ignore[union-attr]
    account = NormalizedAccount(
        external_id=str(raw["account_id"]),
        name=str(raw["name"]),
        account_type=account_type,
        subtype=str(raw.get("subtype")) if raw.get("subtype") is not None else None,
        nature="liability" if account_type in {"credit", "loan"} else "asset",
        currency=currency,
        mask=str(raw.get("mask")) if raw.get("mask") is not None else None,
    )
    raw_balances = raw.get("balances", {})
    current = abs(minor_units(str(raw_balances["current"]), currency))  # type: ignore[index]
    available_raw = raw_balances.get("available")  # type: ignore[union-attr]
    available = abs(minor_units(str(available_raw), currency)) if available_raw is not None else None
    return account, NormalizedBalance(account.external_id, observed_at, current, available, currency, "plaid")


def _transaction(raw: dict[str, object]) -> NormalizedTransaction:
    currency = str(raw.get("iso_currency_code") or "USD")
    occurred_at = raw.get("datetime") or raw.get("authorized_datetime")
    if occurred_at is None:
        occurred_at = f"{raw.get('date')}T12:00:00-04:00"
    return NormalizedTransaction(
        external_id=str(raw["transaction_id"]),
        account_external_id=str(raw["account_id"]),
        occurred_at=str(occurred_at),
        amount_minor=-minor_units(str(raw["amount"]), currency),
        currency=currency,
        description=str(raw.get("name") or ""),
        merchant=str(raw["merchant_name"]) if raw.get("merchant_name") is not None else None,
        pending=bool(raw.get("pending", False)),
        pending_external_id=str(raw["pending_transaction_id"])
        if raw.get("pending_transaction_id") is not None
        else None,
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _plaid_error_code(error: Exception) -> str | None:
    body = getattr(error, "body", None)
    if not body:
        return None
    try:
        parsed = json.loads(body)
    except (TypeError, json.JSONDecodeError):
        return None
    value = parsed.get("error_code")
    return str(value) if value else None
