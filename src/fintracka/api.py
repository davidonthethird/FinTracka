import base64
import secrets
import sqlite3
from collections.abc import Iterator
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from fintracka.budgets import envelope_budget, tracking_budget, tracking_year
from fintracka.db import connect, migrate
from fintracka.ids import new_id
from fintracka.jobs import JobRunner, recover_interrupted_jobs
from fintracka.ledger import (
    IntegrityError,
    apply_rules,
    confirm_transfer,
    create_rule,
    preview_rules,
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


class TransactionPatch(StrictModel):
    expected_updated_at: str
    category_id: str | None = None
    notes: str | None = Field(default=None, max_length=2_000)
    user_merchant: str | None = Field(default=None, max_length=300)


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


class RuleCreate(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    priority: int
    conditions: dict[str, str | int | bool]
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
    app = FastAPI(title="FinTracka", version="1.0.0", docs_url=None, redoc_url=None)
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
        current = database.execute(
            "SELECT updated_at FROM transactions WHERE id = ?", (transaction_id,)
        ).fetchone()
        if current is None:
            raise HTTPException(status_code=404, detail="transaction not found")
        if current["updated_at"] != payload.expected_updated_at:
            raise HTTPException(status_code=409, detail="transaction changed; refresh and retry")
        supplied = payload.model_fields_set - {"expected_updated_at"}
        update_transaction(
            database,
            transaction_id,
            **{field: getattr(payload, field) for field in supplied},
        )
        row = _transaction(database, transaction_id)
        return TransactionResponse(**{**dict(row), "pending": bool(row["pending"])})

    @app.post("/api/v1/transactions/{transaction_id}/split", response_model=TransactionResponse)
    def split_transaction(transaction_id: str, payload: SplitRequest, database: Database) -> TransactionResponse:
        current = database.execute(
            "SELECT updated_at FROM transactions WHERE id = ?", (transaction_id,)
        ).fetchone()
        if current is None:
            raise HTTPException(status_code=404, detail="transaction not found")
        if current["updated_at"] != payload.expected_updated_at:
            raise HTTPException(status_code=409, detail="transaction changed; refresh and retry")
        try:
            set_splits(
                database,
                transaction_id,
                [(item.amount_minor, item.category_id, item.notes) for item in payload.splits],
            )
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
        del candidate_id
        try:
            return {"id": confirm_transfer(database, payload.transaction_a, payload.transaction_b)}
        except IntegrityError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/v1/categories")
    def categories(database: Database) -> list[dict[str, object]]:
        return [dict(row) for row in database.execute("SELECT * FROM categories ORDER BY sort_order, name")]

    @app.post("/api/v1/categories", status_code=201)
    def create_category(payload: CategoryCreate, database: Database) -> dict[str, object]:
        category_id = new_id()
        now = _now()
        try:
            database.execute(
                "INSERT INTO categories (id, group_id, name, category_type, reporting_behavior, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (category_id, payload.group_id, payload.name, payload.category_type, payload.reporting_behavior, payload.sort_order, now, now),
            )
        except sqlite3.IntegrityError as error:
            raise HTTPException(status_code=409, detail="category conflicts with existing data") from error
        database.execute(
            "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, 'user', 'category_create', 'category', ?, ?)",
            (new_id(), category_id, now),
        )
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
            rule_id = create_rule(
                database,
                payload.name,
                payload.priority,
                payload.conditions,
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
        return {"applied_count": apply_rules(database, reprocess=True)}

    @app.get("/api/v1/overview")
    def overview_route(database: Database, month: str) -> dict[str, int]:
        return asdict(overview(database, month))

    @app.get("/api/v1/reports/cash-flow")
    def cash_flow_route(database: Database, month: str) -> dict[str, int]:
        return asdict(cash_flow(database, month))

    @app.get("/api/v1/reports/spending")
    def spending_route(database: Database, month: str) -> list[dict[str, str | int]]:
        return spending_by_category(database, month)

    @app.get("/api/v1/budgets/tracking/{month}")
    def tracking_route(month: str, database: Database) -> list[dict[str, object]]:
        return [asdict(row) for row in tracking_budget(database, month)]

    @app.get("/api/v1/budgets/tracking/{year}/year")
    def tracking_year_route(year: int, database: Database) -> list[dict[str, object]]:
        return [asdict(row) for row in tracking_year(database, year)]

    @app.get("/api/v1/budgets/envelope/{month}")
    def envelope_route(month: str, database: Database) -> dict[str, object]:
        return asdict(envelope_budget(database, month))

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
