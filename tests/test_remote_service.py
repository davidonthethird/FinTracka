from __future__ import annotations

import json
import socket
import ssl
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from urllib.error import HTTPError

import pytest

from e2e.server import seed_database
from fintracka.db import connect
from fintracka.keychain import KeychainSecrets, SecretStoreUnavailable
from fintracka.locks import ProcessLock
from fintracka.remote_client import RemotePublishError, RemotePublisherClient
from fintracka.remote_config import configure_remote, load_remote_settings
from fintracka.remote_service import publish_remote_snapshot


class FakeKeyring:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], str] = {}

    def set_password(self, service: str, account: str, password: str) -> None:
        self.values[(service, account)] = password

    def get_password(self, service: str, account: str) -> str | None:
        return self.values.get((service, account))

    def delete_password(self, service: str, account: str) -> None:
        self.values.pop((service, account), None)


class Response:
    def __init__(self, body: dict[str, object]) -> None:
        self.body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self) -> bytes:
        return self.body


def test_native_opener_uses_system_trust_and_keyword_timeout(monkeypatch) -> None:
    from fintracka.remote_client import _native_urlopen

    context = object()
    captured = {}
    protocols = []
    handlers = []
    class Opener:
        def open(self, request, **kwargs):
            captured.update(request=request, **kwargs)
            return Response({})
    monkeypatch.setattr(
        "truststore.SSLContext", lambda protocol: protocols.append(protocol) or context
    )
    monkeypatch.setattr(
        "fintracka.remote_client.urllib.request.build_opener",
        lambda *items: handlers.extend(items) or Opener(),
    )
    request = object()

    _native_urlopen(request, 15)

    assert captured == {"request": request, "timeout": 15}
    assert protocols == [ssl.PROTOCOL_TLS_CLIENT]
    assert handlers[0]._context is context


def test_client_sends_service_token_digest_and_accepts_idempotent_response() -> None:
    requests = []

    def open_request(request, timeout):
        requests.append((request, timeout))
        return Response({
            "snapshot_id": "snap-1", "source_sequence": 3,
            "published_at": "2026-10-27T12:00:00Z", "idempotent": True,
        })

    client = RemotePublisherClient(
        "https://publish.example.test", "client-id", "client-secret",
        opener=open_request, sleep=lambda _: None,
    )
    result = client.publish(b'{"snapshot_id":"snap-1"}', "abc123")

    request, timeout = requests[0]
    assert request.full_url == "https://publish.example.test/v1/snapshots"
    assert request.get_header("Cf-access-client-id") == "client-id"
    assert request.get_header("Cf-access-client-secret") == "client-secret"
    assert request.get_header("X-fintracka-digest") == "abc123"
    assert request.get_header("User-agent") == "FinTracka/0.1"
    assert timeout == 15
    assert result.idempotent is True


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (HTTPError("https://x", 401, "secret body", {}, BytesIO(b"do not expose")), "REMOTE_UNAUTHORIZED"),
        (HTTPError("https://x", 403, "secret body", {}, BytesIO(b"do not expose")), "REMOTE_FORBIDDEN"),
        (HTTPError("https://x", 409, "secret body", {}, BytesIO(b"do not expose")), "REMOTE_SEQUENCE_CONFLICT"),
        (HTTPError("https://x", 413, "secret body", {}, BytesIO(b"do not expose")), "REMOTE_TOO_LARGE"),
        (socket.timeout("private network detail"), "REMOTE_TIMEOUT"),
    ],
)
def test_client_maps_failures_without_exposing_response_body(failure, code) -> None:
    client = RemotePublisherClient(
        "https://publish.example.test", "id", "secret",
        opener=lambda request, timeout: (_ for _ in ()).throw(failure), sleep=lambda _: None,
    )

    with pytest.raises(RemotePublishError) as caught:
        client.publish(b"{}", "digest")

    assert caught.value.code == code
    assert "secret" not in str(caught.value)
    assert "private network" not in str(caught.value)


def test_client_retries_server_errors_twice() -> None:
    attempts = 0

    def open_request(request, timeout):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise HTTPError(request.full_url, 503, "private", {}, BytesIO(b"private"))
        return Response({
            "snapshot_id": "snap", "source_sequence": 1,
            "published_at": "2026-10-27T12:00:00Z", "idempotent": False,
        })

    result = RemotePublisherClient(
        "https://publish.example.test", "id", "secret",
        opener=open_request, sleep=lambda _: None,
    ).publish(b"{}", "digest")

    assert attempts == 3
    assert result.snapshot_id == "snap"


def test_client_rejects_redirect_without_forwarding_service_token() -> None:
    received: list[tuple[str | None, str | None]] = []

    class Destination(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            received.append((
                self.headers.get("CF-Access-Client-Id"),
                self.headers.get("CF-Access-Client-Secret"),
            ))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_: object) -> None:
            pass

    destination = ThreadingHTTPServer(("127.0.0.1", 0), Destination)

    class Source(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.send_response(302)
            self.send_header(
                "Location",
                f"http://127.0.0.1:{destination.server_port}/stolen",
            )
            self.end_headers()

        def log_message(self, *_: object) -> None:
            pass

    source = ThreadingHTTPServer(("127.0.0.1", 0), Source)
    threads = [
        threading.Thread(target=server.serve_forever, daemon=True)
        for server in (source, destination)
    ]
    for thread in threads:
        thread.start()
    try:
        client = RemotePublisherClient(
            f"http://127.0.0.1:{source.server_port}", "client-id", "client-secret"
        )
        with pytest.raises(RemotePublishError) as caught:
            client.publish(b"{}", "digest")
        assert caught.value.code == "REMOTE_HTTP_ERROR"
        assert received == []
    finally:
        source.shutdown()
        destination.shutdown()
        source.server_close()
        destination.server_close()


def _configured_database(tmp_path):
    path = tmp_path / "fintracka.sqlite3"
    seed_database(path)
    secrets = KeychainSecrets(FakeKeyring())
    connection = connect(path)
    configure_remote(
        connection, secrets,
        viewer_url="https://view.example.test",
        publisher_url="https://publish.example.test",
        access_client_id="client-id",
        access_client_secret="client-secret",
    )
    connection.close()
    return path, secrets


def test_publish_service_records_success_and_preserves_financial_rows(tmp_path) -> None:
    path, secrets = _configured_database(tmp_path)
    captured = {}

    class Client:
        def publish(self, payload, digest):
            document = json.loads(payload)
            captured.update(document)
            from fintracka.remote_client import PublishResult
            return PublishResult(document["snapshot_id"], document["source_sequence"], "2026-10-27T12:00:01Z", False)

    before = connect(path).execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    result = publish_remote_snapshot(
        path, secrets, reason="manual", client_factory=lambda settings, keychain: Client(),
        now=lambda: datetime(2026, 10, 27, 12, tzinfo=timezone.utc),
    )
    connection = connect(path)
    settings = load_remote_settings(connection)
    after = connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    run = connection.execute("SELECT * FROM remote_publication_runs ORDER BY started_at DESC LIMIT 1").fetchone()
    connection.close()

    assert result is not None and result.source_sequence == 1
    assert captured["schema_version"] == 2
    assert settings.last_snapshot_id == result.snapshot_id
    assert run["status"] == "succeeded"
    assert after == before


def test_manual_publish_is_allowed_before_automatic_publication_is_enabled(tmp_path) -> None:
    path, secrets = _configured_database(tmp_path)

    class Client:
        def publish(self, payload, digest):
            document = json.loads(payload)
            from fintracka.remote_client import PublishResult
            return PublishResult(
                document["snapshot_id"], document["source_sequence"],
                "2026-10-27T12:00:01Z", False,
            )

    connection = connect(path)
    assert load_remote_settings(connection).enabled is False
    connection.close()
    assert publish_remote_snapshot(
        path, secrets, reason="manual", client_factory=lambda settings, keychain: Client(),
        now=lambda: datetime(2026, 10, 27, 12, tzinfo=timezone.utc),
    ) is not None
    assert publish_remote_snapshot(
        path, secrets, reason="scheduled", client_factory=lambda settings, keychain: Client(),
    ) is None


def test_publish_service_disabled_does_not_construct_client(tmp_path) -> None:
    path = tmp_path / "fintracka.sqlite3"
    seed_database(path)

    assert publish_remote_snapshot(
        path, KeychainSecrets(FakeKeyring()), reason="manual",
        client_factory=lambda *_: pytest.fail("client must not be created"),
    ) is None


def test_publish_service_redacts_locked_keychain_failure(tmp_path) -> None:
    path, _ = _configured_database(tmp_path)

    class LockedSecrets:
        def get(self, reference):
            raise SecretStoreUnavailable("user password is private")

    with pytest.raises(RemotePublishError) as caught:
        publish_remote_snapshot(path, LockedSecrets(), reason="manual")

    connection = connect(path)
    assert load_remote_settings(connection).last_error_code == "REMOTE_CREDENTIALS_UNAVAILABLE"
    assert "password" not in str(caught.value)
    connection.close()


def test_publish_service_honors_concurrent_lock(tmp_path) -> None:
    path, secrets = _configured_database(tmp_path)
    with ProcessLock(tmp_path / "fintracka-remote.lock"):
        assert publish_remote_snapshot(path, secrets, reason="manual") is None
