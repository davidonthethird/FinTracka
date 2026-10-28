from __future__ import annotations

import calendar
import hashlib
import json
import sqlite3
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timezone
from typing import Any

from fintracka.ids import new_id
from fintracka.planning import planning_snapshot
from fintracka.remote_models import (
    RemoteCounts,
    RemoteOverview,
    RemotePlanningSnapshot,
    RemoteReportSnapshot,
    RemoteSavingsSnapshot,
    RemoteSnapshotV1,
    RemoteSourceFreshness,
    RemoteTransaction,
)
from fintracka.reports import cash_flow, cash_flow_paths, overview, spending_by_category, spending_by_owner
from fintracka.savings import savings_summary
from fintracka.savings_goals import savings_goal_overview


MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024
OWNERS = (None, "David", "Ariela", "Shared")


class SnapshotTooLargeError(ValueError):
    pass


def view_key(month: str, *, window: int | None = None, owner: str | None = None) -> str:
    """Return the only supported key format for month/window/owner read models."""
    parts = [month]
    if window is not None:
        parts.append(f"window={window}")
    parts.append(f"owner={owner or 'Combined'}")
    return "|".join(parts)


def build_remote_snapshot(
    connection: sqlite3.Connection,
    *,
    source_sequence: int,
    history_months: int,
    now: datetime,
    snapshot_id: str | None = None,
) -> RemoteSnapshotV1:
    if not 1 <= history_months <= 6:
        raise ValueError("history_months must be between 1 and 6")
    if source_sequence < 1:
        raise ValueError("source_sequence must be positive")
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")

    nested = connection.in_transaction
    boundary = "remote_snapshot_read"
    connection.execute(f"SAVEPOINT {boundary}" if nested else "BEGIN")
    try:
        month = now.date().strftime("%Y-%m")
        aggregate_months = _months_ending(month, 12)
        detail_months = _months_ending(month, history_months)
        history_start = detail_months[0] + "-01"
        year, number = map(int, detail_months[-1].split("-"))
        history_end = f"{detail_months[-1]}-{calendar.monthrange(year, number)[1]:02d}"

        sources = _sources(connection)
        transactions = _transactions(connection, history_start, history_end)
        overview_models = {
            item_month: RemoteOverview(**asdict(overview(connection, item_month)))
            for item_month in aggregate_months
        }
        planning_models: dict[str, RemotePlanningSnapshot] = {}
        for window in range(1, 13):
            for owner in OWNERS:
                value = planning_snapshot(connection, month, window, owner, today=now.date())
                planning_models[view_key(month, window=window, owner=owner)] = RemotePlanningSnapshot(
                    root=_json_value(value)
                )
        savings_models = {
            view_key(month, owner=owner): RemoteSavingsSnapshot(
                root=_savings_model(connection, month, owner)
            )
            for owner in OWNERS
        }
        reports_models = {
            view_key(item_month): RemoteReportSnapshot(
                root={
                    "cash_flow": _json_value(cash_flow(connection, item_month)),
                    "spending_by_category": spending_by_category(connection, item_month),
                    "spending_by_owner": spending_by_owner(connection, item_month),
                    **(
                        {"cash_flow_paths": _strip_private(cash_flow_paths(connection, item_month))}
                        if item_month in detail_months else {}
                    ),
                }
            )
            for item_month in aggregate_months
        }
        last_sync = max((source.last_success_at for source in sources if source.last_success_at), default=None)
        return RemoteSnapshotV1(
            schema_version=1,
            snapshot_id=snapshot_id or new_id(),
            source_sequence=source_sequence,
            captured_at=now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            source_last_sync_at=last_sync,
            sources=sources,
            history_start=history_start,
            history_end=history_end,
            overview=overview_models,
            transactions=transactions,
            planning=planning_models,
            savings=savings_models,
            reports=reports_models,
            counts=RemoteCounts(
                transactions=len(transactions),
                sources=len(sources),
                aggregate_months=len(aggregate_months),
                detailed_months=len(detail_months),
            ),
        )
    finally:
        if nested:
            connection.execute(f"ROLLBACK TO {boundary}")
            connection.execute(f"RELEASE {boundary}")
        else:
            connection.rollback()


def serialize_remote_snapshot(snapshot: RemoteSnapshotV1) -> bytes:
    payload = json.dumps(
        snapshot.model_dump(mode="json"),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    if len(payload) > MAX_SNAPSHOT_BYTES:
        raise SnapshotTooLargeError("remote snapshot exceeds 5 MiB")
    return payload


def snapshot_digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sources(connection: sqlite3.Connection) -> tuple[RemoteSourceFreshness, ...]:
    return tuple(
        RemoteSourceFreshness(
            name=row["name"] or "Connected source",
            status=row["status"],
            last_success_at=row["last_success_at"],
            error_code=row["last_error_code"],
        )
        for row in connection.execute(
            """
            SELECT COALESCE(i.name, pc.provider) name, pc.status, pc.last_success_at, pc.last_error_code
            FROM provider_connections pc LEFT JOIN institutions i ON i.id = pc.institution_id
            WHERE pc.provider != 'manual'
            ORDER BY COALESCE(i.name, pc.provider), pc.id
            """
        )
    )


def _transactions(
    connection: sqlite3.Connection, start: str, end: str
) -> tuple[RemoteTransaction, ...]:
    rows = connection.execute(
        """
        SELECT t.id, t.local_date, t.amount_minor, t.currency,
               t.provider_description description,
               COALESCE(NULLIF(t.user_merchant, ''), NULLIF(t.provider_merchant, '')) merchant,
               t.category_id, c.name category, t.subcategory_id, s.name subcategory,
               CASE WHEN c.category_type = 'expense' THEN COALESCE(t.spending_owner, a.spending_owner) END spending_owner,
               COALESCE(NULLIF(a.nickname, ''), a.name) account_name,
               a.type account_type, a.subtype account_subtype, a.mask account_mask,
               i.name institution_name, t.pending, pc.provider = 'manual' manual_cash,
               t.is_cash_withdrawal, t.updated_at
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        JOIN provider_connections pc ON pc.id = a.connection_id
        LEFT JOIN institutions i ON i.id = pc.institution_id
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN subcategories s ON s.id = t.subcategory_id
        WHERE t.local_date BETWEEN ? AND ? AND t.tombstoned = 0 AND t.user_archived = 0
          AND a.hidden = 0
          AND NOT EXISTS (
              SELECT 1 FROM transfer_links l
              WHERE l.status = 'confirmed'
                AND (l.transaction_a_id = t.id OR l.transaction_b_id = t.id)
                AND NOT (
                    t.amount_minor < 0 AND a.savings_pool IS NULL AND EXISTS (
                        SELECT 1 FROM transactions incoming
                        JOIN accounts destination ON destination.id = incoming.account_id
                        WHERE incoming.id = CASE WHEN l.transaction_a_id = t.id THEN l.transaction_b_id ELSE l.transaction_a_id END
                          AND incoming.amount_minor = -t.amount_minor
                          AND destination.savings_pool IN ('regular', 'retirement')
                    )
                )
          )
        ORDER BY t.local_date DESC, t.id DESC
        """,
        (start, end),
    )
    return tuple(
        RemoteTransaction(
            **{
                **dict(row),
                "pending": bool(row["pending"]),
                "manual_cash": bool(row["manual_cash"]),
                "is_cash_withdrawal": bool(row["is_cash_withdrawal"]),
            }
        )
        for row in rows
    )


def _savings_model(
    connection: sqlite3.Connection, month: str, owner: str | None
) -> dict[str, Any]:
    result = _json_value(savings_summary(connection, month, owner))
    initialized = connection.execute("SELECT 1 FROM savings_settings WHERE id = 1").fetchone()
    result["goal_ledger"] = (
        _json_value(savings_goal_overview(connection, month, owner)) if initialized else None
    )
    return result


def _months_ending(month: str, count: int) -> tuple[str, ...]:
    year, number = map(int, month.split("-"))
    result = []
    for offset in range(count - 1, -1, -1):
        absolute = year * 12 + number - 1 - offset
        result.append(f"{absolute // 12:04d}-{absolute % 12 + 1:02d}")
    return tuple(result)


def _json_value(value: Any) -> Any:
    if is_dataclass(value):
        return _json_value(asdict(value))
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in sorted(value.items(), key=lambda item: str(item[0]))}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    raise TypeError(f"unsupported snapshot value: {type(value).__name__}")


def _strip_private(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _strip_private(item)
            for key, item in value.items()
            if key not in {"notes"}
        }
    if isinstance(value, list):
        return [_strip_private(item) for item in value]
    return value
