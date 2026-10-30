from __future__ import annotations

import json
import socket
import ssl
from io import BytesIO
from urllib.error import HTTPError

import pytest

from fintracka.mobile_command_client import (
    MobileCommandClient,
    MobileCommandClientError,
    _native_urlopen,
)
from fintracka.mobile_command_config import MobileCommandSettings


class Response:
    def __init__(self, body: object) -> None:
        self.body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self, limit: int = -1) -> bytes:
        return self.body if limit < 0 else self.body[:limit]


class Secrets:
    values = {"id-ref": "client-id.access", "secret-ref": "client-secret"}

    def get(self, reference: str) -> str | None:
        return self.values.get(reference)


def test_native_opener_uses_system_trust_and_rejects_redirects(monkeypatch) -> None:
    context = object()
    captured = {}
    handlers = []

    class Opener:
        def open(self, request, **kwargs):
            captured.update(request=request, **kwargs)
            return Response({})

    monkeypatch.setattr("truststore.SSLContext", lambda protocol: context)
    monkeypatch.setattr(
        "fintracka.mobile_command_client.urllib.request.build_opener",
        lambda *items: handlers.extend(items) or Opener(),
    )
    _native_urlopen(object(), 10)

    assert captured["timeout"] == 10
    assert handlers[0]._context is context
    assert any(type(item).__name__ == "_RejectRedirects" for item in handlers)
    assert ssl.PROTOCOL_TLS_CLIENT is not None


def test_claim_sends_dedicated_service_token_and_parses_strict_commands() -> None:
    requests = []

    def open_request(request, timeout):
        requests.append((request, timeout))
        return Response({"commands": [{
            "id": "command-1",
            "actor_member_id": "member-david",
            "command_type": "transaction.set_classification",
            "command_version": 1,
            "target_id": "transaction-1",
            "observed_revision": 2,
            "category_id": "category-1",
            "subcategory_id": None,
            "payload_digest": "a" * 64,
            "claim_token": "claim-token",
            "expires_at": "2026-11-30T12:00:00Z",
        }]})

    client = MobileCommandClient(
        "https://viewer.example.test", "client-id.access", "client-secret",
        opener=open_request, sleep=lambda _: None,
    )
    commands = client.claim(3)

    request, timeout = requests[0]
    assert request.full_url == "https://viewer.example.test/api/v1/mobile/mac/commands/claim"
    assert request.get_header("Cf-access-client-id") == "client-id.access"
    assert request.get_header("Cf-access-client-secret") == "client-secret"
    assert json.loads(request.data) == {"limit": 3}
    assert timeout == 10
    assert commands[0].target_id == "transaction-1"
    assert commands[0].payload_digest == "a" * 64


def test_complete_and_member_provisioning_use_bounded_exact_json() -> None:
    requests = []

    def open_request(request, timeout):
        requests.append(request)
        if request.full_url.endswith("/members"):
            return Response({"member_id": "member-david", "active": True})
        return Response({"command": terminal_command()})

    client = MobileCommandClient(
        "https://viewer.example.test", "id", "secret",
        opener=open_request, sleep=lambda _: None,
    )
    completed = client.complete("command-1", "claim-token", {
        "status": "applied",
        "category_id": "category-1",
        "subcategory_id": None,
        "classification_revision": 3,
    })
    client.upsert_member("member-david", "David", "david@example.test", active=True)

    assert completed.status == "applied"
    assert requests[0].full_url.endswith("/commands/command-1/complete")
    assert json.loads(requests[0].data)["claim_token"] == "claim-token"
    assert requests[1].full_url.endswith("/members")
    assert json.loads(requests[1].data) == {
        "member_id": "member-david", "display_name": "David",
        "email": "david@example.test", "active": True,
    }


def test_from_settings_requires_separate_available_credentials() -> None:
    client = MobileCommandClient.from_settings(settings(), Secrets())
    assert client.gateway_url == "https://viewer.example.test"

    with pytest.raises(MobileCommandClientError) as caught:
        MobileCommandClient.from_settings(
            MobileCommandSettings(**{**settings().__dict__, "access_client_secret_ref": None}),
            Secrets(),
        )
    assert caught.value.code == "MOBILE_COMMANDS_NOT_CONFIGURED"


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (HTTPError("https://x", 401, "private", {}, BytesIO(b"secret")), "MOBILE_UNAUTHORIZED"),
        (HTTPError("https://x", 403, "private", {}, BytesIO(b"secret")), "MOBILE_FORBIDDEN"),
        (HTTPError("https://x", 409, "private", {}, BytesIO(b"secret")), "MOBILE_CONFLICT"),
        (socket.timeout("private network detail"), "MOBILE_TIMEOUT"),
    ],
)
def test_failures_are_retried_only_when_safe_and_redacted(failure, code) -> None:
    client = MobileCommandClient(
        "https://viewer.example.test", "id", "secret",
        opener=lambda *_: (_ for _ in ()).throw(failure), sleep=lambda _: None,
    )
    with pytest.raises(MobileCommandClientError) as caught:
        client.claim(1)
    assert caught.value.code == code
    assert "private" not in str(caught.value)
    assert "secret" not in str(caught.value)


@pytest.mark.parametrize("body", [
    {"commands": [{"id": "only-an-id"}]},
    {"commands": [], "unexpected": True},
    {"commands": "not-a-list"},
])
def test_claim_rejects_malformed_or_extra_response_fields(body) -> None:
    client = MobileCommandClient(
        "https://viewer.example.test", "id", "secret",
        opener=lambda *_: Response(body), sleep=lambda _: None,
    )
    with pytest.raises(MobileCommandClientError) as caught:
        client.claim(1)
    assert caught.value.code == "MOBILE_INVALID_RESPONSE"


def test_client_rejects_oversized_response_and_invalid_limits() -> None:
    class Oversized(Response):
        def read(self, limit=-1):
            return b"x" * limit

    client = MobileCommandClient(
        "https://viewer.example.test", "id", "secret",
        opener=lambda *_: Oversized({}), sleep=lambda _: None,
    )
    with pytest.raises(MobileCommandClientError, match="MOBILE_INVALID_RESPONSE"):
        client.claim(1)
    with pytest.raises(ValueError, match="between 1 and 10"):
        client.claim(11)


def settings() -> MobileCommandSettings:
    return MobileCommandSettings(
        enabled=True,
        gateway_url="https://viewer.example.test",
        access_client_id_ref="id-ref",
        access_client_secret_ref="secret-ref",
        last_checked_at=None,
        last_error_code=None,
        updated_at="2026-10-30T12:00:00Z",
    )


def terminal_command() -> dict[str, object]:
    return {
        "id": "command-1",
        "actor_member_id": "member-david",
        "command_type": "transaction.set_classification",
        "command_version": 1,
        "target_id": "transaction-1",
        "observed_revision": 2,
        "category_id": "category-1",
        "subcategory_id": None,
        "status": "applied",
        "supersedes_command_id": None,
        "result": {
            "status": "applied", "category_id": "category-1",
            "subcategory_id": None, "classification_revision": 3,
        },
        "error_code": None,
        "created_at": "2026-10-30T12:00:00Z",
        "updated_at": "2026-10-30T12:01:00Z",
        "expires_at": "2026-11-30T12:00:00Z",
        "finished_at": "2026-10-30T12:01:00Z",
    }
