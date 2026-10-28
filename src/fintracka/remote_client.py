from __future__ import annotations

import json
import socket
import ssl
import time
import urllib.request
from dataclasses import dataclass
from typing import Callable
from urllib.error import HTTPError, URLError

import truststore

from fintracka.keychain import KeychainSecrets, SecretStoreUnavailable
from fintracka.remote_config import RemoteSettings


def _native_urlopen(request: urllib.request.Request, timeout: int):  # type: ignore[no-untyped-def]
    context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    return urllib.request.urlopen(request, timeout=timeout, context=context)


@dataclass(frozen=True)
class PublishResult:
    snapshot_id: str
    source_sequence: int
    published_at: str
    idempotent: bool


class RemotePublishError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class RemotePublisherClient:
    def __init__(
        self,
        publisher_url: str,
        client_id: str,
        client_secret: str,
        *,
        opener: Callable[..., object] = _native_urlopen,
        sleep: Callable[[float], None] = time.sleep,
        timeout: int = 15,
    ) -> None:
        self.publisher_url = publisher_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.opener = opener
        self.sleep = sleep
        self.timeout = timeout

    @classmethod
    def from_settings(
        cls, settings: RemoteSettings, secrets: KeychainSecrets
    ) -> "RemotePublisherClient":
        if not settings.publisher_url or not settings.access_client_id_ref or not settings.access_client_secret_ref:
            raise RemotePublishError("REMOTE_NOT_CONFIGURED")
        try:
            client_id = secrets.get(settings.access_client_id_ref)
            client_secret = secrets.get(settings.access_client_secret_ref)
        except SecretStoreUnavailable as error:
            raise RemotePublishError("REMOTE_CREDENTIALS_UNAVAILABLE") from error
        if not client_id or not client_secret:
            raise RemotePublishError("REMOTE_CREDENTIALS_UNAVAILABLE")
        return cls(settings.publisher_url, client_id, client_secret)

    def publish(self, payload: bytes, digest: str) -> PublishResult:
        body = self._request("POST", "/v1/snapshots", payload, digest)
        try:
            response = json.loads(body)
            return PublishResult(
                snapshot_id=str(response["snapshot_id"]),
                source_sequence=int(response["source_sequence"]),
                published_at=str(response["published_at"]),
                idempotent=bool(response["idempotent"]),
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise RemotePublishError("REMOTE_INVALID_RESPONSE") from error

    def purge(self) -> None:
        self._request("DELETE", "/v1/snapshots", None, None)

    def _request(
        self, method: str, path: str, payload: bytes | None, digest: str | None
    ) -> bytes:
        headers = {
            "CF-Access-Client-Id": self.client_id,
            "CF-Access-Client-Secret": self.client_secret,
            "Accept": "application/json",
            "User-Agent": "FinTracka/0.1",
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if digest is not None:
            headers["X-FinTracka-Digest"] = digest
        request = urllib.request.Request(
            self.publisher_url + path,
            data=payload,
            headers=headers,
            method=method,
        )
        for attempt in range(3):
            try:
                with self.opener(request, self.timeout) as response:  # type: ignore[attr-defined]
                    return response.read()  # type: ignore[no-any-return,attr-defined]
            except HTTPError as error:
                code = _http_error_code(error.code)
                if error.code >= 500 and attempt < 2:
                    self.sleep(0.25 * (attempt + 1))
                    continue
                raise RemotePublishError(code) from error
            except (socket.timeout, TimeoutError) as error:
                if attempt < 2:
                    self.sleep(0.25 * (attempt + 1))
                    continue
                raise RemotePublishError("REMOTE_TIMEOUT") from error
            except URLError as error:
                if attempt < 2:
                    self.sleep(0.25 * (attempt + 1))
                    continue
                raise RemotePublishError("REMOTE_NETWORK_ERROR") from error
        raise RemotePublishError("REMOTE_NETWORK_ERROR")


def _http_error_code(status: int) -> str:
    return {
        401: "REMOTE_UNAUTHORIZED",
        403: "REMOTE_FORBIDDEN",
        409: "REMOTE_SEQUENCE_CONFLICT",
        413: "REMOTE_TOO_LARGE",
    }.get(status, "REMOTE_SERVER_ERROR" if status >= 500 else "REMOTE_HTTP_ERROR")
