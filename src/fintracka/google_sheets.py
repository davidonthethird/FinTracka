from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any, Protocol

from fintracka.exports import SHEET_ORDER
from fintracka.ids import new_id
from fintracka.keychain import KeychainSecrets, SecretStoreUnavailable

DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"
CLIENT_CONFIG_REF = "google:oauth:client_config"
CREDENTIALS_REF = "google:oauth:credentials"
PROTECTION_DESCRIPTION = "FinTracka managed range — edited locally in FinTracka; overwritten on sync."


class GoogleNotConfigured(RuntimeError):
    pass


class WorkbookCreator(Protocol):
    def create_workbook(self, names: tuple[str, ...]) -> str: ...


def configure_google(
    connection: sqlite3.Connection,
    secrets: KeychainSecrets,
    client_configuration_json: str,
) -> None:
    try:
        configuration = json.loads(client_configuration_json)
        installed = configuration["installed"]
        required = {"client_id", "client_secret", "auth_uri", "token_uri", "redirect_uris"}
        if not isinstance(installed, dict) or not required.issubset(installed):
            raise ValueError
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise ValueError("Google OAuth configuration must be a desktop-app client JSON file") from error
    normalized = json.dumps(configuration, separators=(",", ":"), sort_keys=True)
    secrets.put(CLIENT_CONFIG_REF, normalized)
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            "INSERT INTO app_metadata (key, value) VALUES ('google.client_config_ref', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (CLIENT_CONFIG_REF,),
        )
        connection.execute(
            "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'user', 'google_configure', 'provider', 'google_sheets', ?)",
            (new_id(), _now()),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def authorize_google(
    connection: sqlite3.Connection,
    secrets: KeychainSecrets,
    *,
    oauth_authorizer: Callable[[dict[str, Any], list[str]], str] | None = None,
    gateway_factory: Callable[[str], WorkbookCreator] | None = None,
) -> str:
    configuration = _client_configuration(connection, secrets)
    authorizer = oauth_authorizer or _official_authorize
    credentials_json = authorizer(configuration, [DRIVE_FILE_SCOPE])
    if not credentials_json:
        raise RuntimeError("Google authorization did not return refresh credentials")
    old_credentials = secrets.get(CREDENTIALS_REF)
    secrets.put(CREDENTIALS_REF, credentials_json)
    try:
        gateway = gateway_factory(credentials_json) if gateway_factory else _official_gateway(credentials_json, secrets, "")
        workbook_id = gateway.create_workbook(SHEET_ORDER)
        now = _now()
        connection.execute("BEGIN IMMEDIATE")
        connection.executemany(
            "INSERT INTO app_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (
                ("google.credentials_ref", CREDENTIALS_REF),
                ("google.workbook_id", workbook_id),
                ("google.authorized_at", now),
            ),
        )
        target = connection.execute(
            "SELECT id FROM export_targets WHERE target_type = 'google_sheets' ORDER BY created_at LIMIT 1"
        ).fetchone()
        if target is None:
            connection.execute(
                "INSERT INTO export_targets (id, target_type, destination_ref, enabled, created_at, updated_at) VALUES (?, 'google_sheets', ?, 1, ?, ?)",
                (new_id(), workbook_id, now, now),
            )
        else:
            connection.execute(
                "UPDATE export_targets SET destination_ref = ?, enabled = 1, updated_at = ? WHERE id = ?",
                (workbook_id, now, target[0]),
            )
        connection.execute(
            "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'user', 'google_authorize', 'export', ?, ?)",
            (new_id(), workbook_id, now),
        )
        connection.commit()
        return workbook_id
    except Exception:
        connection.rollback()
        if old_credentials is None:
            try:
                secrets.delete(CREDENTIALS_REF)
            except SecretStoreUnavailable:
                pass
        else:
            secrets.put(CREDENTIALS_REF, old_credentials)
        raise


def build_google_gateway(
    connection: sqlite3.Connection,
    secrets: KeychainSecrets,
    *,
    service_builder: Callable[[object], object] | None = None,
) -> "GoogleSheetsGateway":
    status = google_status(connection)
    workbook_id = status["workbook_id"]
    if not status["authorized"] or not isinstance(workbook_id, str):
        raise GoogleNotConfigured("Google Sheets is not authorized")
    credentials_json = secrets.get(CREDENTIALS_REF)
    if credentials_json is None:
        raise GoogleNotConfigured("Google refresh credentials are missing from macOS Keychain")
    return _official_gateway(credentials_json, secrets, workbook_id, service_builder=service_builder)


def _official_gateway(
    credentials_json: str,
    secrets: KeychainSecrets,
    workbook_id: str,
    *,
    service_builder: Callable[[object], object] | None = None,
) -> "GoogleSheetsGateway":
    credentials = _load_credentials(credentials_json)
    if getattr(credentials, "expired", False):
        refresh_token = getattr(credentials, "refresh_token", None)
        if not refresh_token:
            raise GoogleNotConfigured("Google authorization must be renewed")
        from google.auth.transport.requests import Request

        credentials.refresh(Request())
        secrets.put(CREDENTIALS_REF, credentials.to_json())
    if service_builder is None:
        from googleapiclient.discovery import build

        service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
    else:
        service = service_builder(credentials)
    return GoogleSheetsGateway(service, workbook_id)


def google_status(connection: sqlite3.Connection) -> dict[str, bool | str | None]:
    values = dict(
        connection.execute(
            "SELECT key, value FROM app_metadata WHERE key IN ('google.client_config_ref', 'google.credentials_ref', 'google.workbook_id')"
        )
    )
    return {
        "configured": values.get("google.client_config_ref") == CLIENT_CONFIG_REF,
        "authorized": values.get("google.credentials_ref") == CREDENTIALS_REF
        and bool(values.get("google.workbook_id")),
        "workbook_id": values.get("google.workbook_id"),
    }


class GoogleSheetsGateway:
    def __init__(self, service: object, spreadsheet_id: str) -> None:
        self.service = service
        self.spreadsheet_id = spreadsheet_id

    def create_workbook(self, names: tuple[str, ...]) -> str:
        sheets = [
            {"properties": {"title": name, "hidden": name == "_FinTrackaMetadata"}}
            for name in names
        ]
        response = (
            self.service.spreadsheets()  # type: ignore[attr-defined]
            .create(
                body={"properties": {"title": "FinTracka"}, "sheets": sheets},
                fields="spreadsheetId",
            )
            .execute()
        )
        return str(response["spreadsheetId"])

    def replace_sheet(self, name: str, rows: list[list[object]], batch_size: int) -> None:
        resource = self.service.spreadsheets().values()  # type: ignore[attr-defined]
        sheet = _sheet_range(name)
        resource.clear(spreadsheetId=self.spreadsheet_id, range=sheet, body={}).execute()
        for index in range(0, len(rows), batch_size):
            resource.update(
                spreadsheetId=self.spreadsheet_id,
                range=f"{sheet}!A{index + 1}",
                valueInputOption="RAW",
                body={"values": rows[index : index + batch_size]},
            ).execute()

    def protect_sheet(self, name: str, warning: str) -> None:
        spreadsheets = self.service.spreadsheets()  # type: ignore[attr-defined]
        metadata = spreadsheets.get(
            spreadsheetId=self.spreadsheet_id,
            fields="sheets(properties(sheetId,title),protectedRanges(protectedRangeId,description))",
        ).execute()
        selected = next(
            (sheet for sheet in metadata.get("sheets", []) if sheet["properties"]["title"] == name),
            None,
        )
        if selected is None:
            raise RuntimeError(f"Google workbook is missing sheet {name}")
        requests = [
            {"deleteProtectedRange": {"protectedRangeId": item["protectedRangeId"]}}
            for item in selected.get("protectedRanges", [])
            if str(item.get("description", "")).startswith("FinTracka managed range")
        ]
        requests.append(
            {
                "addProtectedRange": {
                    "protectedRange": {
                        "range": {"sheetId": selected["properties"]["sheetId"]},
                        "description": PROTECTION_DESCRIPTION,
                        "warningOnly": True,
                    }
                }
            }
        )
        spreadsheets.batchUpdate(
            spreadsheetId=self.spreadsheet_id,
            body={"requests": requests},
        ).execute()


def _client_configuration(
    connection: sqlite3.Connection, secrets: KeychainSecrets
) -> dict[str, Any]:
    reference = connection.execute(
        "SELECT value FROM app_metadata WHERE key = 'google.client_config_ref'"
    ).fetchone()
    value = secrets.get(reference[0]) if reference else None
    if value is None:
        raise GoogleNotConfigured("Google desktop OAuth is not configured")
    return json.loads(value)


def _official_authorize(configuration: dict[str, Any], scopes: list[str]) -> str:
    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_config(configuration, scopes=scopes)
    credentials = flow.run_local_server(
        host="127.0.0.1",
        port=0,
        open_browser=True,
        authorization_prompt_message="Opening Google authorization in your browser…",
        success_message="Google Sheets is authorized. You can close this tab and return to FinTracka.",
    )
    return credentials.to_json()


def _load_credentials(credentials_json: str):  # type: ignore[no-untyped-def]
    from google.oauth2.credentials import Credentials

    return Credentials.from_authorized_user_info(json.loads(credentials_json), [DRIVE_FILE_SCOPE])


def _sheet_range(name: str) -> str:
    return "'" + name.replace("'", "''") + "'"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
