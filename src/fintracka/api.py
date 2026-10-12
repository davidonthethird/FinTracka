import base64
import binascii
import secrets
import sqlite3
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import asdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

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
from fintracka.exports import export_excel
from fintracka.ids import new_id
from fintracka.imports import DuplicateImportError, ImportError as CSVImportError, commit_csv, preview_csv
from fintracka.jobs import JobRunner, recover_interrupted_jobs
from fintracka.locks import ProcessLock
from fintracka.ledger import (
    ConflictError,
    IntegrityError,
    apply_rules,
    confirm_transfer,
    create_rule,
    preview_rules,
    reconcile,
    set_splits,
    transfer_candidates,
    update_transaction,
)
from fintracka.reports import cash_flow, overview, spending_by_category
from fintracka.security import LocalSessions, host_allowed, origin_allowed


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


class TransactionPatch(StrictModel):
    expected_updated_at: str
    category_id: str | None = None
    notes: str | None = Field(default=None, max_length=2_000)
    user_merchant: str | None = Field(default=None, max_length=300)


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
    notes: str | None
    pending: bool
    updated_at: str


class TransactionPage(StrictModel):
    items: list[TransactionResponse]
    next_cursor: str | None


class RuleConditions(StrictModel):
    description_contains: StrictStr | None = Field(default=None, min_length=1, max_length=300)
    merchant_contains: StrictStr | None = Field(default=None, min_length=1, max_length=300)
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
    target: Literal["excel"]


class CSVImportRequest(StrictModel):
    account_id: str
    filename: str = Field(min_length=1, max_length=255)
    content_base64: str = Field(max_length=6_700_000)


def create_app(
    database_path: str | Path,
    *,
    bootstrap_token: str | None = None,
    static_directory: str | Path | None = None,
) -> FastAPI:
    path = Path(database_path)
    initial = connect(path)
    migrate(initial)
    recover_interrupted_jobs(initial)
    initial.close()
    sessions = LocalSessions(bootstrap_token or secrets.token_urlsafe(32))
    jobs = JobRunner(path)

    @asynccontextmanager
    async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
        yield
        jobs.close()

    app = FastAPI(title="FinTracka", version="1.0.0", docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.database_path = path
    app.state.sessions = sessions
    app.state.jobs = jobs

    @app.middleware("http")
    async def local_security(request: Request, call_next):  # type: ignore[no-untyped-def]
        if not host_allowed(request.headers.get("host", "")):
            return _secured(JSONResponse({"detail": "invalid host"}, status_code=400))
        api_path = request.url.path
        exempt = api_path in {"/api/v1/health", "/api/v1/session/bootstrap"}
        session = sessions.get(request.cookies.get("fintracka_session"))
        if api_path.startswith("/api/v1") and not exempt and session is None:
            return _secured(JSONResponse({"detail": "local session required"}, status_code=401))
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and not exempt:
            origin = request.headers.get("origin")
            if origin is None or not origin_allowed(origin):
                return _secured(JSONResponse({"detail": "invalid origin"}, status_code=403))
            if session is None or not secrets.compare_digest(
                request.headers.get("x-csrf-token", ""), session.csrf_token
            ):
                return _secured(JSONResponse({"detail": "invalid CSRF token"}, status_code=403))
        return _secured(await call_next(request))

    def database() -> Iterator[sqlite3.Connection]:
        connection = connect(path)
        try:
            yield connection
        finally:
            connection.close()

    Database = Annotated[sqlite3.Connection, Depends(database)]

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
    def settings() -> dict[str, str | bool]:
        return {
            "reporting_currency": "USD",
            "reporting_timezone": "America/New_York",
            "localhost_only": True,
            "live_data_ready": False,
        }

    @app.get("/api/v1/providers")
    def providers() -> list[dict[str, str | bool]]:
        return [
            {"id": "synthetic", "name": "Synthetic", "enabled": True},
            {"id": "plaid_sandbox", "name": "Plaid Sandbox", "enabled": False},
        ]

    @app.get("/api/v1/connections")
    def connections(database: Database) -> list[dict[str, str | None]]:
        return [
            dict(row)
            for row in database.execute(
                "SELECT id, provider, status, last_success_at, last_error_code, updated_at FROM provider_connections ORDER BY created_at, id"
            )
        ]

    @app.get("/api/v1/accounts")
    def accounts(database: Database) -> list[dict[str, object]]:
        return [
            dict(row)
            for row in database.execute(
                """
                SELECT a.id, a.name, a.nickname, a.type, a.subtype, a.nature, a.currency,
                       a.status, a.include_overview, a.include_budget, a.include_net,
                       a.include_export, a.updated_at,
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
    ) -> TransactionPage:
        clauses = ["t.tombstoned = 0"]
        parameters: list[object] = []
        if cursor:
            cursor_date, cursor_id = _decode_cursor(cursor)
            clauses.append("(t.local_date < ? OR (t.local_date = ? AND t.id < ?))")
            parameters.extend((cursor_date, cursor_date, cursor_id))
        if search:
            clauses.append("(t.provider_description LIKE ? ESCAPE '\\' OR COALESCE(t.user_merchant, t.provider_merchant, '') LIKE ? ESCAPE '\\')")
            escaped = "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            parameters.extend((escaped, escaped))
        if account_id:
            clauses.append("t.account_id = ?")
            parameters.append(account_id)
        if category_id:
            clauses.append("t.category_id = ?")
            parameters.append(category_id)
        parameters.append(limit + 1)
        rows = database.execute(
            f"""
            SELECT t.id, t.account_id, t.local_date, t.amount_minor, t.currency,
                   t.provider_description description,
                   COALESCE(t.user_merchant, t.provider_merchant) merchant,
                   t.category_id, c.name category, t.notes, t.pending, t.updated_at
            FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
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
            return asdict(preview_csv(database, content))
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
                export_excel(connection, destination)

        job_id = jobs.submit("excel_export", work)
        return {"job_id": job_id}

    @app.get("/api/v1/exports")
    def export_jobs(database: Database) -> list[dict[str, object]]:
        return [
            dict(row)
            for row in database.execute(
                "SELECT * FROM jobs WHERE kind = 'excel_export' ORDER BY created_at DESC, id DESC LIMIT 100"
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
            if full_path.startswith("api/"):
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
               t.category_id, c.name category, t.notes, t.pending, t.updated_at
        FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.id = ?
        """,
        (transaction_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="transaction not found")
    return row


@contextmanager
def _write_transaction(connection: sqlite3.Connection) -> Iterator[None]:
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def _secured(response: Response) -> Response:
    response.headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    return response


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
