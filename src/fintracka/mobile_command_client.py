from __future__ import annotations

import json
import re
import socket
import ssl
import time
import urllib.request
from dataclasses import dataclass
from typing import Callable, Literal, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote

import truststore

from fintracka.keychain import KeychainSecrets, SecretStoreUnavailable
from fintracka.mobile_command_config import MobileCommandSettings
from fintracka.receipts import ReceiptError, receipt_digest


MAX_REQUEST_BYTES = 4_096
MAX_RESPONSE_BYTES = 64 * 1024
HEX_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
CategorizationScope = Literal["one_time", "future", "past_and_future"]
VALID_SCOPES = {"one_time", "future", "past_and_future"}


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        return None


def _native_urlopen(request: urllib.request.Request, timeout: int):  # type: ignore[no-untyped-def]
    context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=context),
        _RejectRedirects(),
    )
    return opener.open(request, timeout=timeout)


@dataclass(frozen=True)
class ClaimedMobileCommand:
    id: str
    actor_member_id: str
    command_type: str
    command_version: Literal[1, 2]
    target_id: str
    observed_revision: int
    category_id: str | None
    subcategory_id: str | None
    scope: CategorizationScope
    payload_digest: str
    claim_token: str
    expires_at: str


@dataclass(frozen=True)
class ClaimedReceiptSplitCommand:
    id: str
    actor_member_id: str
    command_type: Literal["transaction.apply_receipt_split"]
    command_version: Literal[1]
    target_id: str
    observed_revision: int
    receipt_draft_id: str
    receipt_revision: int
    allocation_digest: str
    payload_digest: str
    claim_token: str
    expires_at: str


ClaimedCommand = ClaimedMobileCommand | ClaimedReceiptSplitCommand


@dataclass(frozen=True)
class ImmutableReceiptRevision:
    id: str
    revision: int
    digest: str
    draft: dict[str, object]
    created_at: str


@dataclass(frozen=True)
class MobileCommandStatus:
    id: str
    status: str


@dataclass(frozen=True)
class ClaimedReceiptRefinement:
    id: str
    input_digest: str
    claim_token: str
    claimed_until: str


class MobileCommandClientError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class MobileCommandClient:
    def __init__(
        self,
        gateway_url: str,
        client_id: str,
        client_secret: str,
        *,
        opener: Callable[..., object] = _native_urlopen,
        sleep: Callable[[float], None] = time.sleep,
        timeout: int = 10,
    ) -> None:
        self.gateway_url = gateway_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.opener = opener
        self.sleep = sleep
        self.timeout = timeout

    @classmethod
    def from_settings(
        cls,
        settings: MobileCommandSettings,
        secrets: KeychainSecrets,
    ) -> "MobileCommandClient":
        if not all((
            settings.gateway_url,
            settings.access_client_id_ref,
            settings.access_client_secret_ref,
        )):
            raise MobileCommandClientError("MOBILE_COMMANDS_NOT_CONFIGURED")
        try:
            client_id = secrets.get(settings.access_client_id_ref)  # type: ignore[arg-type]
            client_secret = secrets.get(settings.access_client_secret_ref)  # type: ignore[arg-type]
        except SecretStoreUnavailable as error:
            raise MobileCommandClientError("MOBILE_CREDENTIALS_UNAVAILABLE") from error
        if not client_id or not client_secret:
            raise MobileCommandClientError("MOBILE_CREDENTIALS_UNAVAILABLE")
        return cls(settings.gateway_url, client_id, client_secret)  # type: ignore[arg-type]

    def claim(self, limit: int = 10) -> tuple[ClaimedCommand, ...]:
        if not 1 <= limit <= 10:
            raise ValueError("claim limit must be between 1 and 10")
        value = self._request("/api/v1/mobile/mac/commands/claim", {"limit": limit})
        root = _exact_dict(value, {"commands"})
        commands = root["commands"]
        if not isinstance(commands, list) or len(commands) > 10:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        return tuple(_claimed_command(item) for item in commands)

    def claim_receipt_refinements(self, limit: int = 3) -> tuple[ClaimedReceiptRefinement, ...]:
        if not 1 <= limit <= 3:
            raise ValueError("receipt refinement claim limit must be between 1 and 3")
        value = self._request("/api/v1/mobile/mac/receipt-refinements/claim", {"limit": limit})
        root = _exact_dict(value, {"refinements"})
        items = root["refinements"]
        if not isinstance(items, list) or len(items) > 3:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        return tuple(_claimed_receipt_refinement(item) for item in items)

    def active_receipt_refinement_ids(self) -> frozenset[str]:
        value = self._get("/api/v1/mobile/mac/receipt-refinements/active", maximum=64 * 1024)
        root = _exact_dict(value, {"refinement_ids"})
        items = root["refinement_ids"]
        if not isinstance(items, list) or len(items) > 100:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        return frozenset(_bounded_string(item, 128) for item in items)

    def complete_receipt_refinement(
        self, job_id: str, claim_token: str, input_digest: str, text: str, model_result: str,
    ) -> None:
        _bounded_string(job_id, 128)
        _bounded_string(claim_token, 128)
        _digest(input_digest)
        if not text or len(text) > 100_000 or not model_result or len(model_result) > 100_000:
            raise ValueError("receipt refinement result is invalid")
        value = self._request(
            f"/api/v1/mobile/mac/receipt-refinements/{quote(job_id, safe='')}/complete",
            {"claim_token": claim_token, "input_digest": input_digest, "text": text,
             "model_result": model_result}, maximum_request=256 * 1024,
        )
        if _exact_dict(value, {"status"}) != {"status": "completed"}:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")

    def fail_receipt_refinement(self, job_id: str, claim_token: str, error_code: str) -> str:
        if error_code not in {"MODEL_UNAVAILABLE", "VISION_FAILED", "INVALID_PACKAGE", "UNRECONCILED",
                              "PACKAGE_NOT_FOUND"}:
            raise ValueError("invalid receipt refinement error")
        value = self._request(
            f"/api/v1/mobile/mac/receipt-refinements/{quote(_bounded_string(job_id, 128), safe='')}/fail",
            {"claim_token": _bounded_string(claim_token, 128), "error_code": error_code},
        )
        status = _exact_dict(value, {"status"})["status"]
        if status not in {"pending", "failed", "completed"}:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        return status

    def get_receipt_revision(
        self, draft_id: str, revision: int, expected_digest: str,
    ) -> ImmutableReceiptRevision:
        _bounded_string(draft_id, 128)
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise ValueError("receipt revision must be positive")
        if HEX_DIGEST.fullmatch(expected_digest) is None:
            raise ValueError("invalid expected receipt digest")
        value = self._get(
            f"/api/v1/mobile/mac/receipts/{quote(draft_id, safe='')}?revision={revision}",
            maximum=300 * 1024,
        )
        root = _exact_dict(value, {"revision"})
        item = _exact_dict(root["revision"], {"id", "revision", "digest", "draft", "created_at"})
        digest = _bounded_string(item["digest"], 64)
        if item["id"] != draft_id or item["revision"] != revision or digest != expected_digest:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        if not isinstance(item["draft"], dict):
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        try:
            actual = receipt_digest(item["draft"])
        except ReceiptError as error:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE") from error
        if actual != digest:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        return ImmutableReceiptRevision(
            id=draft_id, revision=revision, digest=digest, draft=item["draft"],
            created_at=_bounded_string(item["created_at"], 40),
        )

    def complete(
        self,
        command_id: str,
        claim_token: str,
        result: Mapping[str, object],
    ) -> MobileCommandStatus:
        _bounded_string(command_id, 128)
        _bounded_string(claim_token, 128)
        value = self._request(
            f"/api/v1/mobile/mac/commands/{quote(command_id, safe='')}/complete",
            {"claim_token": claim_token, "result": dict(result)},
        )
        root = _exact_dict(value, {"command"})
        command = _public_command(root["command"])
        return MobileCommandStatus(id=command["id"], status=command["status"])

    def upsert_member(
        self,
        member_id: str,
        display_name: str,
        email: str,
        *,
        active: bool,
    ) -> None:
        value = self._request("/api/v1/mobile/mac/members", {
            "member_id": member_id,
            "display_name": display_name,
            "email": email,
            "active": active,
        })
        root = _exact_dict(value, {"member_id", "active"})
        if root != {"member_id": member_id, "active": active}:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")

    def _request(self, path: str, value: object, *, maximum_request: int = MAX_REQUEST_BYTES) -> object:
        payload = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()
        if len(payload) > maximum_request:
            raise ValueError("mobile command request is too large")
        request = urllib.request.Request(
            self.gateway_url + path,
            data=payload,
            method="POST",
            headers={
                "CF-Access-Client-Id": self.client_id,
                "CF-Access-Client-Secret": self.client_secret,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "FinTracka/0.1",
            },
        )
        for attempt in range(3):
            try:
                with self.opener(request, self.timeout) as response:  # type: ignore[attr-defined]
                    body = response.read(MAX_RESPONSE_BYTES + 1)  # type: ignore[attr-defined]
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
                    return json.loads(body)
            except MobileCommandClientError:
                raise
            except (json.JSONDecodeError, UnicodeDecodeError, TypeError, ValueError) as error:
                raise MobileCommandClientError("MOBILE_INVALID_RESPONSE") from error
            except HTTPError as error:
                if error.code >= 500 and attempt < 2:
                    self.sleep(0.25 * (attempt + 1))
                    continue
                raise MobileCommandClientError(_http_error_code(error.code)) from error
            except (socket.timeout, TimeoutError) as error:
                if attempt < 2:
                    self.sleep(0.25 * (attempt + 1))
                    continue
                raise MobileCommandClientError("MOBILE_TIMEOUT") from error
            except URLError as error:
                if attempt < 2:
                    self.sleep(0.25 * (attempt + 1))
                    continue
                raise MobileCommandClientError("MOBILE_NETWORK_ERROR") from error
        raise MobileCommandClientError("MOBILE_NETWORK_ERROR")

    def _request_no_content(self, path: str, value: object) -> None:
        payload = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()
        request = urllib.request.Request(self.gateway_url + path, data=payload, method="POST", headers={
            "CF-Access-Client-Id": self.client_id, "CF-Access-Client-Secret": self.client_secret,
            "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "FinTracka/0.1",
        })
        try:
            with self.opener(request, self.timeout) as response:  # type: ignore[attr-defined]
                if response.read(1):  # type: ignore[attr-defined]
                    raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        except MobileCommandClientError:
            raise
        except HTTPError as error:
            raise MobileCommandClientError(_http_error_code(error.code)) from error
        except (socket.timeout, TimeoutError) as error:
            raise MobileCommandClientError("MOBILE_TIMEOUT") from error
        except URLError as error:
            raise MobileCommandClientError("MOBILE_NETWORK_ERROR") from error

    def _get(self, path: str, *, maximum: int) -> object:
        request = urllib.request.Request(
            self.gateway_url + path,
            method="GET",
            headers={
                "CF-Access-Client-Id": self.client_id,
                "CF-Access-Client-Secret": self.client_secret,
                "Accept": "application/json",
                "User-Agent": "FinTracka/0.1",
            },
        )
        try:
            with self.opener(request, self.timeout) as response:  # type: ignore[attr-defined]
                body = response.read(maximum + 1)  # type: ignore[attr-defined]
                if len(body) > maximum:
                    raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
                return json.loads(body)
        except MobileCommandClientError:
            raise
        except HTTPError as error:
            raise MobileCommandClientError(_http_error_code(error.code)) from error
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError, ValueError) as error:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE") from error
        except (socket.timeout, TimeoutError) as error:
            raise MobileCommandClientError("MOBILE_TIMEOUT") from error
        except URLError as error:
            raise MobileCommandClientError("MOBILE_NETWORK_ERROR") from error


def _claimed_command(value: object) -> ClaimedCommand:
    if isinstance(value, dict) and value.get("command_type") == "transaction.apply_receipt_split":
        expected = {
            "id", "actor_member_id", "command_type", "command_version", "target_id",
            "observed_revision", "receipt_draft_id", "receipt_revision", "allocation_digest",
            "payload_digest", "claim_token", "expires_at",
        }
        item = _exact_dict(value, expected)
        if item["command_version"] != 1:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        observed = _nonnegative_int(item["observed_revision"])
        receipt_revision = _nonnegative_int(item["receipt_revision"])
        if receipt_revision < 1:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        allocation = _digest(item["allocation_digest"])
        return ClaimedReceiptSplitCommand(
            id=_bounded_string(item["id"], 128),
            actor_member_id=_bounded_string(item["actor_member_id"], 128),
            command_type="transaction.apply_receipt_split", command_version=1,
            target_id=_bounded_string(item["target_id"], 128), observed_revision=observed,
            receipt_draft_id=_bounded_string(item["receipt_draft_id"], 128),
            receipt_revision=receipt_revision, allocation_digest=allocation,
            payload_digest=_digest(item["payload_digest"]),
            claim_token=_bounded_string(item["claim_token"], 128),
            expires_at=_bounded_string(item["expires_at"], 40),
        )
    expected = {
        "id", "actor_member_id", "command_type", "command_version", "target_id",
        "observed_revision", "category_id", "subcategory_id", "payload_digest",
        "scope", "claim_token", "expires_at",
    }
    item = _exact_dict(value, expected)
    version = item["command_version"]
    if (
        item["command_type"] != "transaction.set_classification"
        or not isinstance(version, int)
        or isinstance(version, bool)
        or version not in {1, 2}
    ):
        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
    scope = item["scope"]
    if (
        not isinstance(scope, str)
        or scope not in VALID_SCOPES
        or (version == 1 and scope != "one_time")
    ):
        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
    if not isinstance(item["observed_revision"], int) or isinstance(item["observed_revision"], bool) or item["observed_revision"] < 0:
        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
    digest = _bounded_string(item["payload_digest"], 64)
    if HEX_DIGEST.fullmatch(digest) is None:
        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
    return ClaimedMobileCommand(
        id=_bounded_string(item["id"], 128),
        actor_member_id=_bounded_string(item["actor_member_id"], 128),
        command_type="transaction.set_classification",
        command_version=version,
        target_id=_bounded_string(item["target_id"], 128),
        observed_revision=item["observed_revision"],
        category_id=_nullable_id(item["category_id"]),
        subcategory_id=_nullable_id(item["subcategory_id"]),
        scope=scope,
        payload_digest=digest,
        claim_token=_bounded_string(item["claim_token"], 128),
        expires_at=_bounded_string(item["expires_at"], 40),
    )


def _claimed_receipt_refinement(value: object) -> ClaimedReceiptRefinement:
    item = _exact_dict(value, {"id", "input_digest", "claim_token", "claimed_until"})
    token = _bounded_string(item["claim_token"], 128)
    if re.fullmatch(r"[A-Za-z0-9_-]{43}", token) is None:
        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
    return ClaimedReceiptRefinement(
        id=_bounded_string(item["id"], 128), input_digest=_digest(item["input_digest"]),
        claim_token=token, claimed_until=_bounded_string(item["claimed_until"], 40),
    )


def _public_command(value: object) -> dict[str, object]:
    if isinstance(value, dict) and value.get("command_type") == "transaction.apply_receipt_split":
        item = _exact_dict(value, {
            "id", "actor_member_id", "command_type", "command_version", "target_id",
            "observed_revision", "receipt_draft_id", "receipt_revision", "allocation_digest",
            "status", "supersedes_command_id", "result", "error_code", "created_at",
            "updated_at", "expires_at", "finished_at",
        })
        if item["command_version"] != 1:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        _bounded_string(item["id"], 128)
        if item["status"] not in {"pending", "processing", "applied", "conflict", "rejected", "cancelled", "expired", "superseded"}:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        return item
    item = _exact_dict(value, {
        "id", "actor_member_id", "command_type", "command_version", "target_id",
        "observed_revision", "category_id", "subcategory_id", "status",
        "scope",
        "supersedes_command_id", "result", "error_code", "created_at", "updated_at",
        "expires_at", "finished_at",
    })
    statuses = {"pending", "processing", "applied", "conflict", "rejected", "cancelled", "expired", "superseded"}
    if item["status"] not in statuses:
        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
    if not isinstance(item["scope"], str) or item["scope"] not in VALID_SCOPES:
        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
    _bounded_string(item["id"], 128)
    return item


def _exact_dict(value: object, keys: set[str]) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
    return value


def _bounded_string(value: object, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
    return value


def _nullable_id(value: object) -> str | None:
    return None if value is None else _bounded_string(value, 128)


def _nonnegative_int(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
    return value


def _digest(value: object) -> str:
    digest = _bounded_string(value, 64)
    if HEX_DIGEST.fullmatch(digest) is None:
        raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
    return digest


def _http_error_code(status: int) -> str:
    return {
        400: "MOBILE_INVALID_REQUEST",
        401: "MOBILE_UNAUTHORIZED",
        403: "MOBILE_FORBIDDEN",
        404: "MOBILE_NOT_FOUND",
        409: "MOBILE_CONFLICT",
        413: "MOBILE_TOO_LARGE",
        429: "MOBILE_RATE_LIMITED",
    }.get(status, "MOBILE_SERVER_ERROR" if status >= 500 else "MOBILE_HTTP_ERROR")
