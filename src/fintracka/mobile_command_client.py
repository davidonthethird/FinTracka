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
class MobileCommandStatus:
    id: str
    status: str


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

    def claim(self, limit: int = 10) -> tuple[ClaimedMobileCommand, ...]:
        if not 1 <= limit <= 10:
            raise ValueError("claim limit must be between 1 and 10")
        value = self._request("/api/v1/mobile/mac/commands/claim", {"limit": limit})
        root = _exact_dict(value, {"commands"})
        commands = root["commands"]
        if not isinstance(commands, list) or len(commands) > 10:
            raise MobileCommandClientError("MOBILE_INVALID_RESPONSE")
        return tuple(_claimed_command(item) for item in commands)

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

    def _request(self, path: str, value: object) -> object:
        payload = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()
        if len(payload) > MAX_REQUEST_BYTES:
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


def _claimed_command(value: object) -> ClaimedMobileCommand:
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


def _public_command(value: object) -> dict[str, object]:
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
