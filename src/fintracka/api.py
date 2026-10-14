import base64
import binascii
import secrets
import sqlite3
import sys
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Callable, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator

from fintracka.backups import backup_database
from fintracka.budgets import (
    envelope_budget,
    set_envelope_allocation,
    set_envelope_month,
    set_tracking_target,
    tracking_budget,
    tracking_year,
)
from fintracka.db import connect, migrate
from fintracka.exports import export_excel, export_google
from fintracka.google_sheets import (
    authorize_google,
    build_google_gateway,
    google_status,
)
from fintracka.ids import new_id
from fintracka.imports import DuplicateImportError, ImportError as CSVImportError, commit_csv, preview_csv
from fintracka.jobs import JobRunner, recover_interrupted_jobs
from fintracka.keychain import KeychainSecrets, SecretStoreUnavailable
from fintracka.locks import ProcessLock
from fintracka.manual_cash import (
    ManualCashError,
    create_manual_cash,
    delete_manual_cash,
    update_manual_cash,
)
from fintracka.launchd import install_schedule, remove_schedule, schedule_status
from fintracka.ledger import (
    ConflictError,
    IntegrityError,
    apply_rules,
    categorize_transaction,
    confirm_transfer,
    create_rule,
    preview_rules,
    reconcile,
    set_splits,
    transfer_candidates,
    undo_categorization,
    update_transaction,
)
from fintracka.reports import (
    cash_flow,
    cash_flow_paths,
    ledger_entries,
    month_bounds,
    overview,
    spending_by_category,
    spending_by_owner,
)
from fintracka.readiness import filevault_enabled, readiness_report
from fintracka.security import LocalSessions, host_allowed, origin_allowed
from fintracka.savings import (
    ManualAssetError,
    create_manual_asset,
    deactivate_manual_asset,
    get_manual_asset,
    savings_summary,
    update_manual_asset,
)
from fintracka.plaid_adapter import PlaidAdapter
from fintracka.plaid_service import (
    PlaidNotConfigured,
    build_plaid_adapter,
    complete_plaid_connection,
    repair_plaid_connection,
    revoke_plaid_connection,
    sync_plaid_connections,
)
from fintracka.planning import (
    PlanningError,
    create_income_source,
    planning_snapshot,
    set_income_override,
    set_income_version,
    set_recurring_target,
    set_target_override,
)
from fintracka.subcategories import (
    SubcategoryError,
    assign_subcategory,
    create_subcategory,
    list_subcategories,
    reprocess_subcategory_rule,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BootstrapRequest(StrictModel):
    token: str


class CategoryCreate(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    category_type: Literal["income", "expense", "transfer"]
    reporting_behavior: Literal["ordinary", "expense_offset", "excluded", "income"]
    sort_order: int
    group_id: str | None = None


class CategoryGroupCreate(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    sort_order: int


class AccountPatch(StrictModel):
    expected_updated_at: str
    nickname: str | None = Field(default=None, max_length=120)
    include_overview: bool | None = None
    include_budget: bool | None = None
    include_net: bool | None = None
    include_export: bool | None = None
    include_savings: bool | None = None
    spending_owner: Literal["David", "Ariela", "Shared"] | None = None


class TransactionPatch(StrictModel):
    expected_updated_at: str
    category_id: str | None = None
    notes: str | None = Field(default=None, max_length=2_000)
    user_merchant: str | None = Field(default=None, max_length=300)
    spending_owner: Literal["David", "Ariela", "Shared"] | None = None


class BulkTransactionPatch(TransactionPatch):
    id: str


class BulkTransactionRequest(StrictModel):
    items: list[BulkTransactionPatch] = Field(min_length=1, max_length=500)


class TransactionResponse(StrictModel):
    id: str
    account_id: str
    local_date: str
    amount_minor: int
    currency: str
    description: str
    merchant: str | None
    category_id: str | None
    category: str | None
    category_source: str | None
    subcategory_id: str | None
    subcategory: str | None
    subcategory_source: str | None
    provider_category_confidence: str | None
    spending_owner: str | None
    spending_owner_effective: str | None
    notes: str | None
    pending: bool
    manual_cash: bool
    is_cash_withdrawal: bool
    updated_at: str


class TransactionPage(StrictModel):
    items: list[TransactionResponse]
    next_cursor: str | None


class CategorizeRequest(StrictModel):
    expected_updated_at: str
    category_id: str
    scope: Literal["one_time", "future", "past_and_future"]


class CategorizeResponse(StrictModel):
    transaction: TransactionResponse
    affected_count: int
    undo_id: str


class SubcategoryCreate(StrictModel):
    expected_updated_at: StrictStr
    category_id: StrictStr
    name: StrictStr = Field(min_length=1, max_length=80)


class SubcategoryAssign(StrictModel):
    expected_updated_at: StrictStr
    subcategory_id: StrictStr
    scope: Literal["one_time", "future", "past_and_future"]


class SubcategoryReprocess(StrictModel):
    expected_updated_at: StrictStr


class ManualAssetCreate(StrictModel):
    title: StrictStr = Field(min_length=1, max_length=120)
    kind: Literal["savings", "investment", "other"]
    owner: Literal["David", "Ariela", "Shared"]
    current_value_minor: StrictInt = Field(ge=0, le=10**15)
    as_of_date: StrictStr = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


class ManualAssetPatch(ManualAssetCreate):
    expected_updated_at: StrictStr


class PlannedIncomeCreate(StrictModel):
    title: StrictStr = Field(min_length=1, max_length=120)
    income_type: Literal["Salary", "Custom"]
    amount_minor: StrictInt = Field(ge=0, le=10**15)
    effective_month: StrictStr = Field(pattern=r"^\d{4}-\d{2}$")


class PlannedIncomePatch(PlannedIncomeCreate):
    expected_updated_at: StrictStr
    active: StrictBool


class PlanningOverride(StrictModel):
    expected_updated_at: StrictStr
    amount_minor: StrictInt | None = Field(default=None, ge=0, le=10**15)


class PlanningTargetUpdate(StrictModel):
    expected_updated_at: StrictStr
    effective_month: StrictStr = Field(pattern=r"^\d{4}-\d{2}$")
    amount_minor: StrictInt = Field(ge=0, le=10**15)


class ManualCashCreate(StrictModel):
    title: StrictStr = Field(min_length=1, max_length=300)
    amount_minor: StrictInt = Field(gt=0, le=10**15)
    category_id: StrictStr = Field(min_length=1, max_length=100)
    local_date: StrictStr | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    spending_owner: Literal["David", "Ariela", "Shared"] = "Shared"


class ManualCashPatch(StrictModel):
    expected_updated_at: StrictStr
    title: StrictStr = Field(min_length=1, max_length=300)
    amount_minor: StrictInt = Field(gt=0, le=10**15)
    category_id: StrictStr = Field(min_length=1, max_length=100)
    local_date: StrictStr = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    spending_owner: Literal["David", "Ariela", "Shared"]


class RuleConditions(StrictModel):
    description_contains: StrictStr | None = Field(default=None, min_length=1, max_length=300)
    description_equals: StrictStr | None = Field(default=None, min_length=1, max_length=300)
    merchant_contains: StrictStr | None = Field(default=None, min_length=1, max_length=300)
    merchant_equals: StrictStr | None = Field(default=None, min_length=1, max_length=300)
    direction: Literal["inflow", "outflow"] | None = None
    min_amount_minor: StrictInt | None = None
    max_amount_minor: StrictInt | None = None
    account_id: StrictStr | None = Field(default=None, min_length=1, max_length=100)
    pending: StrictBool | None = None

    @model_validator(mode="after")
    def validate_conditions(self):  # type: ignore[no-untyped-def]
        values = self.model_dump(exclude_none=True)
        if not values:
            raise ValueError("at least one rule condition is required")
        minimum = values.get("min_amount_minor")
        maximum = values.get("max_amount_minor")
        if minimum is not None and maximum is not None and minimum > maximum:
            raise ValueError("minimum amount must not exceed maximum amount")
        return self


class RuleCreate(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    priority: int
    conditions: RuleConditions
    category_id: str


class EmptyRequest(StrictModel):
    pass


class PlaidCompleteRequest(StrictModel):
    public_token: str = Field(min_length=1, max_length=1_000)


class SplitItem(StrictModel):
    amount_minor: int
    category_id: str | None = None
    notes: str | None = Field(default=None, max_length=500)


class SplitRequest(StrictModel):
    expected_updated_at: str
    splits: list[SplitItem] = Field(min_length=2, max_length=50)


class TransferConfirmRequest(StrictModel):
    transaction_a: str
    transaction_b: str


class ReconciliationCreate(StrictModel):
    account_id: str
    period_start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    period_end: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    opening_minor: int
    closing_minor: int
    cleared_cutoff: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


class TrackingTargetUpdate(StrictModel):
    category_id: str
    amount_minor: int = Field(ge=0)


class EnvelopeUpdate(StrictModel):
    starting_pool_minor: int
    category_id: str
    allocation_minor: int


class ExportRequest(StrictModel):
    target: Literal["excel", "google_sheets"]


class CSVImportRequest(StrictModel):
    account_id: str
    filename: str = Field(min_length=1, max_length=255)
    content_base64: str = Field(max_length=6_700_000)


def create_app(
    database_path: str | Path,
    *,
    bootstrap_token: str | None = None,
    static_directory: str | Path | None = None,
    plaid_adapter_factory: Callable[[sqlite3.Connection], PlaidAdapter] | None = None,
    google_secrets_factory: Callable[[], KeychainSecrets] = KeychainSecrets,
    google_authorizer: Callable[[dict[str, Any], list[str]], str] | None = None,
    google_authorization_gateway_factory: Callable[[str], Any] | None = None,
    google_export_gateway_factory: Callable[[sqlite3.Connection, KeychainSecrets], Any] | None = None,
    schedule_installer: Callable[[Path, Path, Path], Any] = install_schedule,
    schedule_remover: Callable[[Path], Any] = remove_schedule,
    schedule_status_reader: Callable[[Path], dict[str, bool]] = schedule_status,
    filevault_checker: Callable[[], bool] = filevault_enabled,
) -> FastAPI:
    path = Path(database_path)
    initial = connect(path)
    migrate(initial)
    recover_interrupted_jobs(initial)
    plaid_environment = _plaid_environment(initial)
    initial.close()
    sessions = LocalSessions(bootstrap_token or secrets.token_urlsafe(32))
    jobs = JobRunner(path)
    launch_agent = Path.home() / "Library" / "LaunchAgents" / "com.fintracka.sync.plist"

    @asynccontextmanager
    async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
        startup = connect(path)
        try:
            if _catch_up_due(startup):
                try:
                    plaid_adapter(startup)
                except (PlaidNotConfigured, SecretStoreUnavailable):
                    pass
                else:
                    def catch_up(connection: sqlite3.Connection) -> None:
                        with ProcessLock(path.parent / "fintracka.lock"):
                            sync_plaid_connections(connection, plaid_adapter(connection))

                    jobs.submit("plaid_sync", catch_up)
        finally:
            startup.close()
        try:
            yield
        finally:
            jobs.close()

    app = FastAPI(
        title="FinTracka",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.database_path = path
    app.state.sessions = sessions
    app.state.jobs = jobs

    @app.middleware("http")
    async def local_security(request: Request, call_next):  # type: ignore[no-untyped-def]
        nonce = secrets.token_urlsafe(18)
        if not host_allowed(request.headers.get("host", "")):
            return _secured(JSONResponse({"detail": "invalid host"}, status_code=400), nonce, plaid_environment)
        api_path = request.url.path
        exempt = api_path in {"/api/v1/health", "/api/v1/session/bootstrap"}
        session = sessions.get(request.cookies.get("fintracka_session"))
        if api_path.startswith("/api/v1") and not exempt and session is None:
            return _secured(JSONResponse({"detail": "local session required"}, status_code=401), nonce, plaid_environment)
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and not exempt:
            origin = request.headers.get("origin")
            if origin is None or not origin_allowed(origin):
                return _secured(JSONResponse({"detail": "invalid origin"}, status_code=403), nonce, plaid_environment)
            if session is None or not secrets.compare_digest(
                request.headers.get("x-csrf-token", ""), session.csrf_token
            ):
                return _secured(JSONResponse({"detail": "invalid CSRF token"}, status_code=403), nonce, plaid_environment)
        return _secured(await call_next(request), nonce, plaid_environment)

    def database() -> Iterator[sqlite3.Connection]:
        connection = connect(path)
        try:
            yield connection
        finally:
            connection.close()

    Database = Annotated[sqlite3.Connection, Depends(database)]

    def plaid_adapter(connection: sqlite3.Connection) -> PlaidAdapter:
        if plaid_adapter_factory is not None:
            return plaid_adapter_factory(connection)
        return build_plaid_adapter(connection, KeychainSecrets())

    @app.get("/api/v1/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/v1/session/bootstrap", status_code=204)
    def bootstrap(payload: BootstrapRequest, response: Response) -> None:
        created = sessions.bootstrap(payload.token)
        if created is None:
            raise HTTPException(status_code=401, detail="invalid bootstrap token")
        session_id, _ = created
        response.set_cookie(
            "fintracka_session",
            session_id,
            httponly=True,
            samesite="strict",
            secure=False,
            path="/",
        )

    @app.get("/api/v1/session/csrf")
    def csrf(request: Request) -> dict[str, str]:
        session = sessions.get(request.cookies.get("fintracka_session"))
        if session is None:
            raise HTTPException(status_code=401, detail="local session required")
        return {"csrf_token": session.csrf_token}

    @app.get("/api/v1/settings")
    def settings(database: Database) -> dict[str, str | bool]:
        google = google_status(database)
        scheduler = schedule_status_reader(launch_agent)
        return {
            "reporting_currency": "USD",
            "reporting_timezone": "America/New_York",
            "localhost_only": True,
            "live_data_ready": False,
            "google_configured": bool(google["configured"]),
            "google_authorized": bool(google["authorized"]),
            "schedule_installed": scheduler["installed"],
            "schedule_loaded": scheduler["loaded"],
        }

    @app.post("/api/v1/settings/schedule")
    def install_sync_schedule(payload: EmptyRequest) -> dict[str, bool]:
        del payload
        schedule_installer(launch_agent, Path(sys.executable), path.parent)
        return schedule_status_reader(launch_agent)

    @app.delete("/api/v1/settings/schedule", status_code=204)
    def remove_sync_schedule() -> None:
        schedule_remover(launch_agent)

    @app.get("/api/v1/settings/readiness")
    def readiness(database: Database) -> dict[str, object]:
        return readiness_report(
            database,
            path.parent,
            google_secrets_factory(),
            filevault_checker=filevault_checker,
            scheduler=schedule_status_reader(launch_agent),
        )

    @app.get("/api/v1/providers")
    def providers(database: Database) -> list[dict[str, str | bool]]:
        environment = _plaid_environment(database)
        configured = database.execute(
            "SELECT 1 FROM app_metadata WHERE key = ?",
            (f"plaid.{environment}.secret_ref",),
        ).fetchone() is not None
        return [
            {"id": "synthetic", "name": "Synthetic", "enabled": True},
            {"id": "plaid", "name": "Plaid", "enabled": configured, "environment": environment},
        ]

    @app.get("/api/v1/connections")
    def connections(database: Database) -> list[dict[str, str | None]]:
        return [
            dict(row)
            for row in database.execute(
                """
                SELECT pc.id, pc.provider, pc.environment, pc.status, i.name institution_name,
                       pc.last_success_at, pc.last_error_code, pc.updated_at
                FROM provider_connections pc
                LEFT JOIN institutions i ON i.id = pc.institution_id
                WHERE pc.provider != 'manual'
                ORDER BY pc.created_at, pc.id
                """
            )
        ]

    @app.post("/api/v1/connections/plaid/sessions")
    def create_plaid_session(payload: EmptyRequest, database: Database) -> dict[str, str]:
        del payload
        try:
            adapter = plaid_adapter(database)
            if adapter.environment == "production":
                existing = database.execute(
                    "SELECT 1 FROM provider_connections WHERE provider = 'plaid' AND environment = 'production' LIMIT 1"
                ).fetchone()
                if existing is None:
                    if not filevault_checker():
                        raise HTTPException(
                            status_code=409,
                            detail="FileVault must be enabled before a live bank connection",
                        )
                    with ProcessLock(path.parent / "fintracka.lock"):
                        backup_database(path, path.parent / "backups")
            session = adapter.create_link_session()
        except (PlaidNotConfigured, SecretStoreUnavailable) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {
            "link_token": session.link_token,
            "expires_at": session.expiration,
            "environment": session.environment,
        }

    @app.post("/api/v1/connections/plaid/complete", status_code=201)
    def complete_plaid(payload: PlaidCompleteRequest, database: Database) -> dict[str, str]:
        try:
            return complete_plaid_connection(database, plaid_adapter(database), payload.public_token)
        except (PlaidNotConfigured, SecretStoreUnavailable) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/api/v1/connections/{connection_id}/repair")
    def repair_plaid(connection_id: str, payload: EmptyRequest, database: Database) -> dict[str, str]:
        del payload
        try:
            session = repair_plaid_connection(database, plaid_adapter(database), connection_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except (PlaidNotConfigured, SecretStoreUnavailable) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {
            "link_token": session.link_token,
            "expires_at": session.expiration,
            "environment": session.environment,
        }

    @app.delete("/api/v1/connections/{connection_id}", status_code=204)
    def disconnect_plaid(connection_id: str, database: Database) -> None:
        try:
            revoke_plaid_connection(database, plaid_adapter(database), connection_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except (PlaidNotConfigured, SecretStoreUnavailable) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.get("/api/v1/accounts")
    def accounts(database: Database) -> list[dict[str, object]]:
        return [
            dict(row)
            for row in database.execute(
                """
                SELECT a.id, a.name, a.nickname, a.type, a.subtype, a.nature, a.currency,
                       a.status, a.include_overview, a.include_budget, a.include_net,
                       a.include_export, a.include_savings, a.spending_owner, a.updated_at,
                       (SELECT b.current_minor FROM account_balance_snapshots b WHERE b.account_id = a.id ORDER BY b.observed_at DESC, b.id DESC LIMIT 1) balance_minor
                FROM accounts a ORDER BY a.nature, a.name, a.id
                """
            )
        ]

    @app.patch("/api/v1/accounts/{account_id}")
    def patch_account(account_id: str, payload: AccountPatch, database: Database) -> dict[str, object]:
        supplied = payload.model_fields_set - {"expected_updated_at"}
        values: dict[str, object] = {}
        for field in supplied:
            value = getattr(payload, field)
            if field.startswith("include_") and value is None:
                raise HTTPException(status_code=422, detail=f"{field} cannot be null")
            if field == "spending_owner" and value is None:
                raise HTTPException(status_code=422, detail="spending_owner cannot be null")
            values[field] = int(value) if field.startswith("include_") else value
        now = _now()
        with _write_transaction(database):
            current = database.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
            if current is None:
                raise HTTPException(status_code=404, detail="account not found")
            if current["updated_at"] != payload.expected_updated_at:
                raise HTTPException(status_code=409, detail="account changed; refresh and retry")
            if not supplied:
                return dict(current)
            assignments = ", ".join(f"{field} = ?" for field in values)
            database.execute(
                f"UPDATE accounts SET {assignments}, updated_at = ? WHERE id = ?",
                (*values.values(), now, account_id),
            )
            database.execute(
                "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'user', 'account_update', 'account', ?, ?)",
                (new_id(), account_id, now),
            )
        return dict(database.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone())

    @app.get("/api/v1/accounts/{account_id}/balances")
    def account_balances(account_id: str, database: Database) -> list[dict[str, object]]:
        return [
            dict(row)
            for row in database.execute(
                "SELECT observed_at, current_minor, available_minor, currency, source FROM account_balance_snapshots WHERE account_id = ? ORDER BY observed_at, id",
                (account_id,),
            )
        ]

    @app.get("/api/v1/transactions", response_model=TransactionPage)
    def transactions(
        database: Database,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        cursor: str | None = None,
        search: Annotated[str | None, Query(max_length=200)] = None,
        account_id: str | None = None,
        category_id: str | None = None,
        subcategory_id: str | None = None,
        spending_owner: Literal["David", "Ariela", "Shared"] | None = None,
        include_transfers: bool = False,
    ) -> TransactionPage:
        clauses = ["t.tombstoned = 0"]
        parameters: list[object] = []
        if not include_transfers:
            clauses.append("COALESCE(c.category_type, '') != 'transfer'")
        if cursor:
            cursor_date, cursor_id = _decode_cursor(cursor)
            clauses.append("(t.local_date < ? OR (t.local_date = ? AND t.id < ?))")
            parameters.extend((cursor_date, cursor_date, cursor_id))
        if search:
            clauses.append("(t.provider_description LIKE ? ESCAPE '\\' OR COALESCE(t.user_merchant, t.provider_merchant, '') LIKE ? ESCAPE '\\' OR COALESCE(c.name, '') LIKE ? ESCAPE '\\' OR COALESCE(s.name, '') LIKE ? ESCAPE '\\')")
            escaped = "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            parameters.extend((escaped, escaped, escaped, escaped))
        if account_id:
            clauses.append("t.account_id = ?")
            parameters.append(account_id)
        if category_id == "uncategorized":
            clauses.append("t.category_id IS NULL")
        elif category_id == "review":
            clauses.append("t.category_source = 'provider' AND COALESCE(t.provider_category_confidence, 'UNKNOWN') NOT IN ('VERY_HIGH', 'HIGH')")
        elif category_id:
            clauses.append("t.category_id = ?")
            parameters.append(category_id)
        if subcategory_id:
            clauses.append("t.subcategory_id = ?")
            parameters.append(subcategory_id)
        if spending_owner:
            clauses.append("c.category_type = 'expense' AND COALESCE(t.spending_owner, a.spending_owner) = ?")
            parameters.append(spending_owner)
        parameters.append(limit + 1)
        rows = database.execute(
            f"""
            SELECT t.id, t.account_id, t.local_date, t.amount_minor, t.currency,
                   t.provider_description description,
                   COALESCE(t.user_merchant, t.provider_merchant) merchant,
                   t.category_id, c.name category, t.category_source,
                   t.subcategory_id, s.name subcategory, t.subcategory_source,
                   t.provider_category_confidence, t.spending_owner,
                   CASE WHEN c.category_type = 'expense' THEN COALESCE(t.spending_owner, a.spending_owner) END spending_owner_effective,
                   t.notes, t.pending, pc.provider = 'manual' manual_cash,
                   t.is_cash_withdrawal, t.updated_at
            FROM transactions t JOIN accounts a ON a.id = t.account_id
            JOIN provider_connections pc ON pc.id = a.connection_id
            LEFT JOIN categories c ON c.id = t.category_id
            LEFT JOIN subcategories s ON s.id = t.subcategory_id
            WHERE {' AND '.join(clauses)}
            ORDER BY t.local_date DESC, t.id DESC LIMIT ?
            """,
            parameters,
        ).fetchall()
        has_more = len(rows) > limit
        visible = rows[:limit]
        items = [TransactionResponse(**{**dict(row), "pending": bool(row["pending"])}) for row in visible]
        next_cursor = _encode_cursor(visible[-1]["local_date"], visible[-1]["id"]) if has_more else None
        return TransactionPage(items=items, next_cursor=next_cursor)

    @app.get("/api/v1/subcategories")
    def subcategories_route(
        database: Database, category_id: str | None = None
    ) -> list[dict[str, object]]:
        return list_subcategories(database, category_id)

    @app.post("/api/v1/subcategories", status_code=201)
    def create_subcategory_route(
        payload: SubcategoryCreate, database: Database
    ) -> dict[str, object]:
        try:
            with _write_transaction(database):
                _require_revision(
                    database,
                    "categories",
                    payload.category_id,
                    payload.expected_updated_at,
                    "category",
                )
                identifier = create_subcategory(database, payload.category_id, payload.name)
        except SubcategoryError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return next(row for row in list_subcategories(database) if row["id"] == identifier)

    @app.post("/api/v1/transactions/manual-cash", response_model=TransactionResponse, status_code=201)
    def create_manual_cash_route(payload: ManualCashCreate, database: Database) -> TransactionResponse:
        try:
            with _write_transaction(database):
                transaction_id = create_manual_cash(
                    database,
                    payload.title,
                    payload.amount_minor,
                    payload.category_id,
                    payload.local_date or date.today().isoformat(),
                    payload.spending_owner,
                )
        except ManualCashError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return _transaction_response(database, transaction_id)

    @app.patch("/api/v1/transactions/manual-cash/{transaction_id}", response_model=TransactionResponse)
    def patch_manual_cash_route(
        transaction_id: str, payload: ManualCashPatch, database: Database
    ) -> TransactionResponse:
        try:
            with _write_transaction(database):
                update_manual_cash(
                    database,
                    transaction_id,
                    payload.expected_updated_at,
                    payload.title,
                    payload.amount_minor,
                    payload.category_id,
                    payload.local_date,
                    payload.spending_owner,
                )
        except ManualCashError as error:
            raise HTTPException(status_code=_manual_cash_status(error), detail=str(error)) from error
        return _transaction_response(database, transaction_id)

    @app.delete("/api/v1/transactions/{transaction_id}", status_code=204)
    def delete_transaction_route(
        transaction_id: str, expected_updated_at: str, database: Database
    ) -> None:
        try:
            with _write_transaction(database):
                delete_manual_cash(database, transaction_id, expected_updated_at)
        except ManualCashError as error:
            raise HTTPException(status_code=_manual_cash_status(error), detail=str(error)) from error

    @app.patch("/api/v1/transactions/{transaction_id}", response_model=TransactionResponse)
    def patch_transaction(transaction_id: str, payload: TransactionPatch, database: Database) -> TransactionResponse:
        supplied = payload.model_fields_set - {"expected_updated_at"}
        with _write_transaction(database):
            current = database.execute(
                "SELECT updated_at FROM transactions WHERE id = ?", (transaction_id,)
            ).fetchone()
            if current is None:
                raise HTTPException(status_code=404, detail="transaction not found")
            if current["updated_at"] != payload.expected_updated_at:
                raise HTTPException(status_code=409, detail="transaction changed; refresh and retry")
            update_transaction(
                database,
                transaction_id,
                **{field: getattr(payload, field) for field in supplied},
            )
        row = _transaction(database, transaction_id)
        return TransactionResponse(**{**dict(row), "pending": bool(row["pending"])})

    @app.post("/api/v1/transactions/{transaction_id}/categorize", response_model=CategorizeResponse)
    def categorize_transaction_route(
        transaction_id: str,
        payload: CategorizeRequest,
        database: Database,
    ) -> CategorizeResponse:
        try:
            with _write_transaction(database):
                current = database.execute(
                    "SELECT updated_at FROM transactions WHERE id = ?", (transaction_id,)
                ).fetchone()
                if current is None:
                    raise HTTPException(status_code=404, detail="transaction not found")
                if current["updated_at"] != payload.expected_updated_at:
                    raise HTTPException(status_code=409, detail="transaction changed; refresh and retry")
                result = categorize_transaction(
                    database, transaction_id, payload.category_id, payload.scope
                )
        except IntegrityError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        row = _transaction(database, transaction_id)
        return CategorizeResponse(
            transaction=TransactionResponse(**{**dict(row), "pending": bool(row["pending"])}),
            affected_count=result.affected_count,
            undo_id=result.undo_id,
        )

    @app.post("/api/v1/transactions/{transaction_id}/subcategory")
    def assign_subcategory_route(
        transaction_id: str,
        payload: SubcategoryAssign,
        database: Database,
    ) -> dict[str, object]:
        try:
            with _write_transaction(database):
                _require_revision(
                    database,
                    "transactions",
                    transaction_id,
                    payload.expected_updated_at,
                    "transaction",
                )
                result = assign_subcategory(
                    database, transaction_id, payload.subcategory_id, payload.scope
                )
        except SubcategoryError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        row = _transaction(database, transaction_id)
        return {
            "transaction": TransactionResponse(
                **{**dict(row), "pending": bool(row["pending"])}
            ).model_dump(),
            "affected_count": result.affected_count,
            "undo_id": result.undo_id,
        }

    @app.post("/api/v1/subcategory-rules/{rule_id}/reprocess")
    def reprocess_subcategory_route(
        rule_id: str,
        payload: SubcategoryReprocess,
        database: Database,
    ) -> dict[str, int]:
        try:
            with _write_transaction(database):
                _require_revision(
                    database,
                    "transaction_subcategory_rules",
                    rule_id,
                    payload.expected_updated_at,
                    "subcategory rule",
                )
                count = reprocess_subcategory_rule(database, rule_id)
        except SubcategoryError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {"affected_count": count}

    @app.post("/api/v1/categorizations/{undo_id}/undo")
    def undo_categorization_route(
        undo_id: str,
        payload: EmptyRequest,
        database: Database,
    ) -> dict[str, int]:
        del payload
        try:
            with _write_transaction(database):
                restored = undo_categorization(database, undo_id)
        except IntegrityError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {"restored_count": restored}

    @app.post("/api/v1/transactions/bulk", response_model=list[TransactionResponse])
    def bulk_transactions(payload: BulkTransactionRequest, database: Database) -> list[TransactionResponse]:
        identifiers = [item.id for item in payload.items]
        if len(identifiers) != len(set(identifiers)):
            raise HTTPException(status_code=422, detail="bulk items must be unique")
        with _write_transaction(database):
            current = {
                row["id"]: row["updated_at"]
                for row in database.execute(
                    f"SELECT id, updated_at FROM transactions WHERE id IN ({','.join('?' for _ in identifiers)})",
                    identifiers,
                )
            }
            if set(current) != set(identifiers):
                raise HTTPException(status_code=404, detail="transaction not found")
            if any(current[item.id] != item.expected_updated_at for item in payload.items):
                raise HTTPException(status_code=409, detail="transaction changed; refresh and retry")
            for item in payload.items:
                supplied = item.model_fields_set - {"id", "expected_updated_at"}
                update_transaction(
                    database,
                    item.id,
                    **{field: getattr(item, field) for field in supplied},
                )
        return [
            TransactionResponse(**{**dict(row), "pending": bool(row["pending"])})
            for row in (_transaction(database, identifier) for identifier in identifiers)
        ]

    @app.post("/api/v1/transactions/{transaction_id}/split", response_model=TransactionResponse)
    def split_transaction(transaction_id: str, payload: SplitRequest, database: Database) -> TransactionResponse:
        try:
            set_splits(
                database,
                transaction_id,
                [(item.amount_minor, item.category_id, item.notes) for item in payload.splits],
                expected_updated_at=payload.expected_updated_at,
            )
        except ConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except IntegrityError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        row = _transaction(database, transaction_id)
        return TransactionResponse(**{**dict(row), "pending": bool(row["pending"])})

    @app.get("/api/v1/transfers/candidates")
    def transfer_candidate_route(database: Database) -> list[dict[str, object]]:
        return [asdict(candidate) for candidate in transfer_candidates(database)]

    @app.post("/api/v1/transfers/{candidate_id}/confirm", status_code=201)
    def transfer_confirm_route(
        candidate_id: str,
        payload: TransferConfirmRequest,
        database: Database,
    ) -> dict[str, str]:
        if candidate_id != payload.transaction_a:
            raise HTTPException(status_code=404, detail="transfer candidate not found")
        try:
            with _write_transaction(database):
                link_id = confirm_transfer(database, payload.transaction_a, payload.transaction_b)
            return {"id": link_id}
        except IntegrityError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/v1/category-groups")
    def category_groups(database: Database) -> list[dict[str, object]]:
        return [dict(row) for row in database.execute("SELECT * FROM category_groups ORDER BY sort_order, name")]

    @app.post("/api/v1/category-groups", status_code=201)
    def create_category_group(payload: CategoryGroupCreate, database: Database) -> dict[str, object]:
        group_id = new_id()
        now = _now()
        try:
            database.execute("BEGIN IMMEDIATE")
            database.execute(
                "INSERT INTO category_groups (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (group_id, payload.name, payload.sort_order, now, now),
            )
            database.execute(
                "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'user', 'category_group_create', 'category_group', ?, ?)",
                (new_id(), group_id, now),
            )
            database.commit()
        except sqlite3.IntegrityError as error:
            database.rollback()
            raise HTTPException(status_code=409, detail="category group conflicts with existing data") from error
        return dict(database.execute("SELECT * FROM category_groups WHERE id = ?", (group_id,)).fetchone())

    @app.get("/api/v1/categories")
    def categories(database: Database) -> list[dict[str, object]]:
        return [dict(row) for row in database.execute("SELECT * FROM categories ORDER BY sort_order, name")]

    @app.post("/api/v1/categories", status_code=201)
    def create_category(payload: CategoryCreate, database: Database) -> dict[str, object]:
        category_id = new_id()
        now = _now()
        try:
            with _write_transaction(database):
                database.execute(
                    "INSERT INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (category_id, payload.group_id, payload.name, payload.category_type, payload.reporting_behavior, payload.sort_order, now, now),
                )
                database.execute(
                    "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'user', 'category_create', 'category', ?, ?)",
                    (new_id(), category_id, now),
                )
        except sqlite3.IntegrityError as error:
            raise HTTPException(status_code=409, detail="category conflicts with existing data") from error
        return dict(database.execute("SELECT * FROM categories WHERE id = ?", (category_id,)).fetchone())

    @app.get("/api/v1/rules")
    def rules(database: Database) -> list[dict[str, object]]:
        return [
            dict(row)
            for row in database.execute(
                "SELECT r.id, r.name, r.priority, r.enabled, r.conditions_json, r.category_id, c.name category, r.updated_at FROM categorization_rules r JOIN categories c ON c.id = r.category_id ORDER BY r.priority, r.id"
            )
        ]

    @app.post("/api/v1/rules", status_code=201)
    def create_rule_route(payload: RuleCreate, database: Database) -> dict[str, object]:
        try:
            with _write_transaction(database):
                rule_id = create_rule(
                    database,
                    payload.name,
                    payload.priority,
                    payload.conditions.model_dump(exclude_none=True),
                    payload.category_id,
                )
        except (IntegrityError, sqlite3.IntegrityError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return dict(
            database.execute(
                "SELECT id, name, priority, enabled, conditions_json, category_id, updated_at FROM categorization_rules WHERE id = ?",
                (rule_id,),
            ).fetchone()
        )

    @app.post("/api/v1/rules/preview")
    def preview_rules_route(payload: EmptyRequest, database: Database) -> list[dict[str, str | int]]:
        del payload
        return preview_rules(database)

    @app.post("/api/v1/rules/reprocess")
    def reprocess_rules_route(payload: EmptyRequest, database: Database) -> dict[str, int]:
        del payload
        with _write_transaction(database):
            applied = apply_rules(database, reprocess=True)
        return {"applied_count": applied}

    @app.get("/api/v1/overview")
    def overview_route(database: Database, month: str) -> dict[str, int | None]:
        return asdict(overview(database, month))

    @app.get("/api/v1/reports/cash-flow")
    def cash_flow_route(database: Database, month: str) -> dict[str, int]:
        return asdict(cash_flow(database, month))

    @app.get("/api/v1/reports/spending")
    def spending_route(database: Database, month: str) -> list[dict[str, str | int]]:
        return spending_by_category(database, month)

    @app.get("/api/v1/reports/spending-owners")
    def spending_owners_route(database: Database, month: str) -> list[dict[str, str | int]]:
        return spending_by_owner(database, month)

    @app.get("/api/v1/reports/flow")
    def flow_route(database: Database, month: str) -> dict[str, object]:
        return cash_flow_paths(database, month)

    @app.get("/api/v1/reports/budget")
    def budget_report_route(database: Database, month: str) -> dict[str, object]:
        return {
            "month": month,
            "tracking": [asdict(row) for row in tracking_budget(database, month)],
            "envelope": asdict(envelope_budget(database, month)),
        }

    @app.get("/api/v1/reports/balances")
    def balance_report_route(database: Database) -> list[dict[str, object]]:
        return [
            dict(row)
            for row in database.execute(
                """
                SELECT b.id, b.account_id, a.name account, a.nature, b.observed_at,
                       b.current_minor, b.available_minor, b.currency, b.source
                FROM account_balance_snapshots b JOIN accounts a ON a.id = b.account_id
                WHERE a.include_net = 1
                ORDER BY b.observed_at, a.name, b.id
                """
            )
        ]

    @app.get("/api/v1/planning/{month}")
    def planning_route(
        month: str,
        database: Database,
        average_months: Annotated[int, Query(ge=1, le=12)] = 12,
        spending_owner: Literal["David", "Ariela", "Shared"] | None = None,
    ) -> dict[str, object]:
        try:
            return asdict(planning_snapshot(database, month, average_months, spending_owner))
        except PlanningError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/v1/savings/{month}")
    def savings_route(
        month: str,
        database: Database,
        owner: Literal["David", "Ariela", "Shared"] | None = None,
    ) -> dict[str, object]:
        try:
            return asdict(savings_summary(database, month, owner))
        except ManualAssetError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/api/v1/savings/assets", status_code=201)
    def create_manual_asset_route(
        payload: ManualAssetCreate, database: Database
    ) -> dict[str, object]:
        try:
            with _write_transaction(database):
                identifier = create_manual_asset(
                    database,
                    payload.title,
                    payload.kind,
                    payload.owner,
                    payload.current_value_minor,
                    payload.as_of_date,
                )
        except ManualAssetError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return get_manual_asset(database, identifier)

    @app.patch("/api/v1/savings/assets/{asset_id}")
    def update_manual_asset_route(
        asset_id: str, payload: ManualAssetPatch, database: Database
    ) -> dict[str, object]:
        try:
            with _write_transaction(database):
                update_manual_asset(
                    database,
                    asset_id,
                    payload.expected_updated_at,
                    payload.title,
                    payload.kind,
                    payload.owner,
                    payload.current_value_minor,
                    payload.as_of_date,
                )
        except ManualAssetError as error:
            raise HTTPException(status_code=_manual_asset_status(error), detail=str(error)) from error
        return get_manual_asset(database, asset_id)

    @app.delete("/api/v1/savings/assets/{asset_id}", status_code=204)
    def deactivate_manual_asset_route(
        asset_id: str, expected_updated_at: str, database: Database
    ) -> None:
        try:
            with _write_transaction(database):
                deactivate_manual_asset(database, asset_id, expected_updated_at)
        except ManualAssetError as error:
            raise HTTPException(status_code=_manual_asset_status(error), detail=str(error)) from error

    @app.get("/api/v1/planning/{month}/categories/{category_id}/transactions")
    def planning_category_transactions(
        month: str,
        category_id: str,
        database: Database,
        spending_owner: Literal["David", "Ariela", "Shared"] | None = None,
    ) -> list[dict[str, object]]:
        try:
            snapshot = planning_snapshot(database, month, 1, spending_owner)
        except PlanningError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        category = next((row for row in snapshot.categories if row.category_id == category_id), None)
        if category is None:
            raise HTTPException(status_code=404, detail="category not found")
        start, end = month_bounds(month)
        entries = [
            entry
            for entry in ledger_entries(database, start, end, account_flag="include_budget")
            if entry.category_id == category_id
            and entry.category_type == "expense"
            and entry.reporting_behavior != "excluded"
            and (spending_owner is None or entry.spending_owner == spending_owner)
        ]
        identifiers = sorted({entry.transaction_id for entry in entries})
        details = {
            row["id"]: row
            for row in database.execute(
                f"""
                SELECT t.id, t.provider_description,
                       COALESCE(t.user_merchant, t.provider_merchant) merchant,
                       t.notes, t.currency, t.subcategory_id, s.name subcategory
                FROM transactions t LEFT JOIN subcategories s ON s.id = t.subcategory_id
                WHERE t.id IN ({','.join('?' for _ in identifiers)})
                """,
                identifiers,
            )
        } if identifiers else {}
        return [
            {
                "id": f"{entry.transaction_id}:{index}",
                "transaction_id": entry.transaction_id,
                "local_date": entry.local_date,
                "description": details[entry.transaction_id]["provider_description"],
                "merchant": details[entry.transaction_id]["merchant"],
                "notes": details[entry.transaction_id]["notes"],
                "amount_minor": entry.amount_minor,
                "currency": details[entry.transaction_id]["currency"],
                "subcategory_id": details[entry.transaction_id]["subcategory_id"],
                "subcategory": details[entry.transaction_id]["subcategory"],
            }
            for index, entry in enumerate(entries)
        ]

    @app.post("/api/v1/planning/income-sources", status_code=201)
    def create_planned_income(payload: PlannedIncomeCreate, database: Database) -> dict[str, object]:
        try:
            with _write_transaction(database):
                source_id = create_income_source(
                    database, payload.title, payload.income_type, payload.amount_minor, payload.effective_month
                )
        except PlanningError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return _planned_income_version(database, source_id, payload.effective_month)

    @app.patch("/api/v1/planning/income-sources/{source_id}")
    def patch_planned_income(
        source_id: str, payload: PlannedIncomePatch, database: Database
    ) -> dict[str, object]:
        try:
            with _write_transaction(database):
                current = database.execute(
                    "SELECT updated_at FROM planning_income_sources WHERE id = ?", (source_id,)
                ).fetchone()
                if current is None:
                    raise HTTPException(status_code=404, detail="planned income source not found")
                if current["updated_at"] != payload.expected_updated_at:
                    raise HTTPException(status_code=409, detail="planned income source changed; refresh and retry")
                set_income_version(
                    database, source_id, payload.title, payload.income_type,
                    payload.amount_minor, payload.effective_month, payload.active,
                )
        except PlanningError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return _planned_income_version(database, source_id, payload.effective_month)

    @app.put("/api/v1/planning/income-sources/{source_id}/overrides/{month}")
    def update_income_override(
        source_id: str, month: str, payload: PlanningOverride, database: Database
    ) -> dict[str, object]:
        try:
            with _write_transaction(database):
                _require_revision(
                    database,
                    "planning_income_sources",
                    source_id,
                    payload.expected_updated_at,
                    "planned income source",
                )
                set_income_override(database, source_id, month, payload.amount_minor)
            return asdict(planning_snapshot(database, month, 12))
        except PlanningError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.put("/api/v1/planning/targets/{category_id}")
    def update_planning_target(
        category_id: str, payload: PlanningTargetUpdate, database: Database
    ) -> dict[str, object]:
        try:
            with _write_transaction(database):
                _require_revision(
                    database, "categories", category_id, payload.expected_updated_at, "planning target"
                )
                set_recurring_target(database, category_id, payload.amount_minor, payload.effective_month)
            return _planning_category(database, category_id, payload.effective_month)
        except PlanningError as error:
            raise HTTPException(status_code=422, detail=_planning_error_detail(error)) from error

    @app.put("/api/v1/planning/targets/{category_id}/overrides/{month}")
    def update_planning_target_override(
        category_id: str, month: str, payload: PlanningOverride, database: Database
    ) -> dict[str, object]:
        try:
            with _write_transaction(database):
                _require_revision(
                    database, "categories", category_id, payload.expected_updated_at, "planning target"
                )
                set_target_override(database, category_id, month, payload.amount_minor)
            return _planning_category(database, category_id, month)
        except PlanningError as error:
            raise HTTPException(status_code=422, detail=_planning_error_detail(error)) from error

    @app.get("/api/v1/budgets/tracking/{month}")
    def tracking_route(month: str, database: Database) -> list[dict[str, object]]:
        return [asdict(row) for row in tracking_budget(database, month)]

    @app.put("/api/v1/budgets/tracking/{month}")
    def update_tracking_route(
        month: str,
        payload: TrackingTargetUpdate,
        database: Database,
    ) -> list[dict[str, object]]:
        try:
            with _write_transaction(database):
                set_tracking_target(database, payload.category_id, month, payload.amount_minor)
            return [asdict(row) for row in tracking_budget(database, month)]
        except (ValueError, sqlite3.IntegrityError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/v1/budgets/tracking/{year}/year")
    def tracking_year_route(year: int, database: Database) -> list[dict[str, object]]:
        return [asdict(row) for row in tracking_year(database, year)]

    @app.get("/api/v1/budgets/envelope/{month}")
    def envelope_route(month: str, database: Database) -> dict[str, object]:
        return asdict(envelope_budget(database, month))

    @app.put("/api/v1/budgets/envelope/{month}")
    def update_envelope_route(
        month: str,
        payload: EnvelopeUpdate,
        database: Database,
    ) -> dict[str, object]:
        try:
            with _write_transaction(database):
                set_envelope_month(database, month, payload.starting_pool_minor)
                set_envelope_allocation(database, payload.category_id, month, payload.allocation_minor)
            return asdict(envelope_budget(database, month))
        except (ValueError, sqlite3.IntegrityError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/v1/sync-runs")
    def sync_runs(database: Database) -> list[dict[str, object]]:
        return [dict(row) for row in database.execute("SELECT * FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT 100")]

    @app.post("/api/v1/sync-runs", status_code=202)
    def start_sync(payload: EmptyRequest) -> dict[str, str]:
        del payload

        def work(connection: sqlite3.Connection) -> None:
            with ProcessLock(path.parent / "fintracka.lock"):
                sync_plaid_connections(connection, plaid_adapter(connection))

        try:
            check = connect(path)
            try:
                plaid_adapter(check)
            finally:
                check.close()
        except (PlaidNotConfigured, SecretStoreUnavailable) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {"job_id": jobs.submit("plaid_sync", work)}

    @app.get("/api/v1/sync-runs/{run_id}")
    def sync_run(run_id: str, database: Database) -> dict[str, object]:
        row = database.execute("SELECT * FROM sync_runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="sync run not found")
        result = dict(row)
        result["items"] = [
            dict(item)
            for item in database.execute(
                "SELECT * FROM sync_run_items WHERE sync_run_id = ? ORDER BY id", (run_id,)
            )
        ]
        return result

    @app.post("/api/v1/imports/csv/preview")
    def preview_csv_route(payload: CSVImportRequest, database: Database) -> dict[str, object]:
        content = _decode_csv(payload.content_base64)
        try:
            return asdict(preview_csv(database, content, account_id=payload.account_id))
        except (CSVImportError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/api/v1/imports/csv/commit", status_code=201)
    def commit_csv_route(payload: CSVImportRequest, database: Database) -> dict[str, object]:
        content = _decode_csv(payload.content_base64)
        try:
            return asdict(commit_csv(database, payload.account_id, payload.filename, content))
        except DuplicateImportError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except (CSVImportError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/api/v1/reconciliations", status_code=201)
    def create_reconciliation(payload: ReconciliationCreate, database: Database) -> dict[str, object]:
        try:
            period_start = date.fromisoformat(payload.period_start)
            period_end = date.fromisoformat(payload.period_end)
            cleared_cutoff = date.fromisoformat(payload.cleared_cutoff)
        except ValueError as error:
            raise HTTPException(status_code=422, detail="reconciliation dates must be valid ISO dates") from error
        if period_start > period_end:
            raise HTTPException(status_code=422, detail="period start must not follow period end")
        if not period_start <= cleared_cutoff <= period_end:
            raise HTTPException(status_code=422, detail="cleared cutoff must fall within the statement period")
        try:
            with _write_transaction(database):
                result = reconcile(
                    database,
                    payload.account_id,
                    payload.period_start,
                    payload.period_end,
                    payload.opening_minor,
                    payload.closing_minor,
                    payload.cleared_cutoff,
                )
            return asdict(result)
        except sqlite3.IntegrityError as error:
            raise HTTPException(status_code=422, detail="reconciliation data is invalid") from error

    @app.get("/api/v1/reconciliations")
    def reconciliations(database: Database) -> list[dict[str, object]]:
        return [dict(row) for row in database.execute("SELECT * FROM reconciliations ORDER BY created_at DESC, id DESC")]

    @app.post("/api/v1/exports", status_code=202)
    def start_export(payload: ExportRequest) -> dict[str, str]:
        destination = path.parent / "exports" / "FinTracka.xlsx"

        def work(connection: sqlite3.Connection) -> None:
            with ProcessLock(path.parent / "fintracka.lock"):
                if payload.target == "excel":
                    export_excel(connection, destination)
                else:
                    secrets_store = google_secrets_factory()
                    gateway = (
                        google_export_gateway_factory(connection, secrets_store)
                        if google_export_gateway_factory
                        else build_google_gateway(connection, secrets_store)
                    )
                    export_google(connection, gateway)

        if payload.target == "google_sheets":
            status_connection = connect(path)
            try:
                status = google_status(status_connection)
            finally:
                status_connection.close()
            if not status["authorized"]:
                raise HTTPException(status_code=409, detail="Google Sheets is not authorized")
        job_id = jobs.submit(f"{payload.target}_export", work)
        return {"job_id": job_id}

    @app.post("/api/v1/exports/google/authorize", status_code=202)
    def start_google_authorization(payload: EmptyRequest) -> dict[str, str]:
        del payload

        def work(connection: sqlite3.Connection) -> None:
            with ProcessLock(path.parent / "fintracka.lock"):
                authorize_google(
                    connection,
                    google_secrets_factory(),
                    oauth_authorizer=google_authorizer,
                    gateway_factory=google_authorization_gateway_factory,
                )

        check = connect(path)
        try:
            if not google_status(check)["configured"]:
                raise HTTPException(status_code=409, detail="Google desktop OAuth is not configured")
        finally:
            check.close()
        return {"job_id": jobs.submit("google_authorize", work)}

    @app.get("/api/v1/exports")
    def export_jobs(database: Database) -> list[dict[str, object]]:
        return [
            dict(row)
            for row in database.execute(
                "SELECT * FROM jobs WHERE kind IN ('excel_export', 'google_sheets_export', 'google_authorize') ORDER BY created_at DESC, id DESC LIMIT 100"
            )
        ]

    @app.post("/api/v1/backups", status_code=202)
    def start_backup(payload: EmptyRequest) -> dict[str, str]:
        del payload
        def work(_: sqlite3.Connection) -> None:
            with ProcessLock(path.parent / "fintracka.lock"):
                backup_database(path, path.parent / "backups")

        job_id = jobs.submit("backup", work)
        return {"job_id": job_id}

    @app.get("/api/v1/jobs/{job_id}")
    def job(job_id: str, database: Database) -> dict[str, object]:
        row = database.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="job not found")
        return dict(row)

    frontend = Path(static_directory) if static_directory else Path(__file__).parents[2] / "frontend" / "dist"
    if (frontend / "index.html").is_file():
        assets = frontend / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="frontend-assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def frontend_route(full_path: str):  # type: ignore[no-untyped-def]
            if full_path.startswith("api/") or full_path in {"openapi.json", "docs", "redoc"}:
                raise HTTPException(status_code=404, detail="not found")
            candidate = (frontend / full_path).resolve()
            if candidate.is_file() and frontend.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(frontend / "index.html")

    return app


def _transaction(connection: sqlite3.Connection, transaction_id: str) -> sqlite3.Row:
    row = connection.execute(
        """
        SELECT t.id, t.account_id, t.local_date, t.amount_minor, t.currency,
               t.provider_description description,
               COALESCE(t.user_merchant, t.provider_merchant) merchant,
               t.category_id, c.name category, t.category_source,
               t.subcategory_id, s.name subcategory, t.subcategory_source,
               t.provider_category_confidence, t.spending_owner,
               CASE WHEN c.category_type = 'expense' THEN COALESCE(t.spending_owner, a.spending_owner) END spending_owner_effective,
               t.notes, t.pending, pc.provider = 'manual' manual_cash,
               t.is_cash_withdrawal, t.updated_at
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        JOIN provider_connections pc ON pc.id = a.connection_id
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN subcategories s ON s.id = t.subcategory_id
        WHERE t.id = ?
        """,
        (transaction_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="transaction not found")
    return row


def _transaction_response(connection: sqlite3.Connection, transaction_id: str) -> TransactionResponse:
    row = _transaction(connection, transaction_id)
    return TransactionResponse(**{**dict(row), "pending": bool(row["pending"])})


def _manual_cash_status(error: ManualCashError) -> int:
    message = str(error)
    if "not a manual cash entry" in message:
        return 403
    if "changed" in message:
        return 409
    return 422


def _manual_asset_status(error: ManualAssetError) -> int:
    message = str(error)
    if "not found" in message:
        return 404
    if "changed" in message:
        return 409
    return 422


def _planning_error_detail(error: PlanningError) -> str | dict[str, object]:
    if error.minimum_minor is not None:
        return {"message": str(error), "minimum_minor": error.minimum_minor}
    return str(error)


def _planned_income_version(
    connection: sqlite3.Connection, source_id: str, effective_month: str
) -> dict[str, object]:
    row = connection.execute(
        """
        SELECT v.source_id, v.title, v.income_type, v.amount_minor, v.active,
               v.effective_month, s.updated_at
        FROM planning_income_versions v
        JOIN planning_income_sources s ON s.id = v.source_id
        WHERE v.source_id = ? AND v.effective_month = ?
        """,
        (source_id, effective_month),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="planned income source not found")
    result = dict(row)
    result["active"] = bool(result["active"])
    return result


def _planning_category(
    connection: sqlite3.Connection, category_id: str, month: str
) -> dict[str, object]:
    snapshot = planning_snapshot(connection, month, 12)
    for category in snapshot.categories:
        if category.category_id == category_id:
            return asdict(category)
    raise HTTPException(status_code=404, detail="category not found")


def _require_revision(
    connection: sqlite3.Connection,
    table: Literal[
        "planning_income_sources", "categories", "transactions", "transaction_subcategory_rules"
    ],
    entity_id: str,
    expected_updated_at: str,
    label: str,
) -> None:
    row = connection.execute(f"SELECT updated_at FROM {table} WHERE id = ?", (entity_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"{label} not found")
    if row["updated_at"] != expected_updated_at:
        raise HTTPException(status_code=409, detail=f"{label} changed; refresh and retry")


@contextmanager
def _write_transaction(connection: sqlite3.Connection) -> Iterator[None]:
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def _secured(response: Response, nonce: str, plaid_environment: str) -> Response:
    plaid_api = "production" if plaid_environment == "production" else "sandbox"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        f"script-src 'self' 'nonce-{nonce}' https://cdn.plaid.com/link/v2/stable/link-initialize.js; "
        f"style-src 'self' 'nonce-{nonce}'; style-src-attr 'unsafe-inline'; "
        "frame-src https://cdn.plaid.com/; "
        f"connect-src 'self' https://{plaid_api}.plaid.com/; "
        "frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = (
        "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
    )
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    return response


def _plaid_environment(connection: sqlite3.Connection) -> str:
    row = connection.execute(
        "SELECT value FROM app_metadata WHERE key = 'plaid.environment'"
    ).fetchone()
    return row[0] if row is not None and row[0] in {"sandbox", "production"} else "sandbox"


def _catch_up_due(
    connection: sqlite3.Connection,
    *,
    now: datetime | None = None,
) -> bool:
    active = connection.execute(
        "SELECT MAX(last_success_at) FROM provider_connections WHERE provider = 'plaid' AND status = 'active'"
    ).fetchone()
    if active is None:
        return False
    has_connection = connection.execute(
        "SELECT 1 FROM provider_connections WHERE provider = 'plaid' AND status = 'active' LIMIT 1"
    ).fetchone()
    if has_connection is None:
        return False
    running = connection.execute(
        "SELECT 1 FROM jobs WHERE kind = 'plaid_sync' AND status IN ('queued', 'running') LIMIT 1"
    ).fetchone()
    if running is not None:
        return False
    latest = active[0]
    if latest is None:
        return True
    try:
        observed = datetime.fromisoformat(str(latest).replace("Z", "+00:00"))
    except ValueError:
        return True
    current = now or datetime.now(timezone.utc)
    return current - observed > timedelta(hours=24)


def _encode_cursor(local_date: str, transaction_id: str) -> str:
    return base64.urlsafe_b64encode(f"{local_date}|{transaction_id}".encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[str, str]:
    try:
        decoded = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        local_date, transaction_id = decoded.split("|", 1)
        if len(local_date) != 10 or len(transaction_id) != 36:
            raise ValueError
        return local_date, transaction_id
    except (ValueError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=422, detail="invalid cursor") from error


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _decode_csv(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=422, detail="CSV content must be valid base64") from error
