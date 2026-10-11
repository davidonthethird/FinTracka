from __future__ import annotations

import hmac
import secrets
from dataclasses import dataclass


@dataclass(frozen=True)
class Session:
    csrf_token: str


class LocalSessions:
    def __init__(self, bootstrap_token: str) -> None:
        self._bootstrap_token = bootstrap_token
        self._bootstrap_available = True
        self._sessions: dict[str, Session] = {}

    def bootstrap(self, token: str) -> tuple[str, Session] | None:
        if not self._bootstrap_available or not hmac.compare_digest(token, self._bootstrap_token):
            return None
        self._bootstrap_available = False
        session_id = secrets.token_urlsafe(32)
        session = Session(csrf_token=secrets.token_urlsafe(32))
        self._sessions[session_id] = session
        return session_id, session

    def get(self, session_id: str | None) -> Session | None:
        return self._sessions.get(session_id or "")


def host_allowed(host_header: str) -> bool:
    host = host_header.rsplit(":", 1)[0].strip("[]").casefold()
    return host in {"127.0.0.1", "localhost", "testserver", "::1"}


def origin_allowed(origin: str) -> bool:
    from urllib.parse import urlparse

    parsed = urlparse(origin)
    return parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "testserver", "::1"}

