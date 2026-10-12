from __future__ import annotations

import sqlite3
from typing import Protocol


class SecretStoreUnavailable(RuntimeError):
    pass


class KeyringBackend(Protocol):
    def set_password(self, service: str, account: str, password: str) -> None: ...
    def get_password(self, service: str, account: str) -> str | None: ...
    def delete_password(self, service: str, account: str) -> None: ...


class KeychainSecrets:
    service = "com.fintracka.provider"

    def __init__(self, backend: KeyringBackend | None = None) -> None:
        if backend is None:
            try:
                import keyring
            except ImportError as error:
                raise SecretStoreUnavailable("macOS Keychain support is not installed") from error
            backend = keyring
        self.backend = backend

    def put(self, reference: str, secret: str) -> None:
        if not secret:
            raise ValueError("secret cannot be empty")
        try:
            self.backend.set_password(self.service, reference, secret)
        except Exception as error:
            raise SecretStoreUnavailable("could not write to macOS Keychain") from error

    def get(self, reference: str) -> str | None:
        try:
            return self.backend.get_password(self.service, reference)
        except Exception as error:
            raise SecretStoreUnavailable("could not read from macOS Keychain") from error

    def delete(self, reference: str) -> None:
        try:
            self.backend.delete_password(self.service, reference)
        except Exception as error:
            raise SecretStoreUnavailable("could not remove secret from macOS Keychain") from error


def store_secret_reference(
    connection: sqlite3.Connection,
    connection_id: str,
    keychain_service: str,
    keychain_account: str,
) -> None:
    connection.execute(
        "INSERT INTO connection_secret_refs (connection_id, keychain_service, keychain_account) VALUES (?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET keychain_service = excluded.keychain_service, keychain_account = excluded.keychain_account",
        (connection_id, keychain_service, keychain_account),
    )

