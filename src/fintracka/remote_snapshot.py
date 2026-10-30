from __future__ import annotations

import calendar
import hashlib
import json
import sqlite3
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fintracka.ids import new_id
from fintracka.planning import planning_snapshot
from fintracka.remote_models import (
    RemoteCounts,
    RemoteOverview,
    RemotePlanningSnapshot,
    RemoteReportSnapshot,
    RemoteSavingsSnapshot,
    RemoteCapabilities,
    RemoteSnapshot,
    RemoteSnapshotV2,
    RemoteSourceFreshness,
    RemoteTaxonomy,
    RemoteTaxonomyCategory,
    RemoteTaxonomySubcategory,
    RemoteTransactionV2,
)
from fintracka.reports import cash_flow, cash_flow_paths, overview, spending_by_category, spending_by_owner
from fintracka.savings import savings_summary
from fintracka.savings_goals import savings_goal_overview


MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024
OWNERS = (None, "David", "Ariela", "Shared")
REPORTING_ZONE = ZoneInfo("America/New_York")


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
    mobile_commands_enabled: bool = False,
) -> RemoteSnapshotV2:
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
        reporting_date = now.astimezone(REPORTING_ZONE).date()
        month = reporting_date.strftime("%Y-%m")
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
                value = planning_snapshot(connection, month, window, owner, today=reporting_date)
                planning_models[view_key(month, window=window, owner=owner)] = RemotePlanningSnapshot(
                    **_planning_model(value)
                )
        savings_models = {
            view_key(month, owner=owner): RemoteSavingsSnapshot(
                **_savings_model(connection, month, owner)
            )
            for owner in OWNERS
        }
        reports_models = {
            view_key(item_month): RemoteReportSnapshot(
                **{
                    "cash_flow": _json_value(cash_flow(connection, item_month)),
                    "spending_by_category": spending_by_category(connection, item_month),
                    "spending_by_owner": spending_by_owner(connection, item_month),
                    **({"cash_flow_paths": _cash_flow_paths_model(connection, item_month)}
                       if item_month in detail_months else {}),
                }
            )
            for item_month in aggregate_months
        }
        last_sync = max((source.last_success_at for source in sources if source.last_success_at), default=None)
        return RemoteSnapshotV2(
            schema_version=2,
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
            capabilities=RemoteCapabilities(
                commands=(
                    {"transaction.set_classification": (1,)}
                    if mobile_commands_enabled
                    else {}
                )
            ),
            taxonomy=_taxonomy(connection),
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


def serialize_remote_snapshot(snapshot: RemoteSnapshot) -> bytes:
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
) -> tuple[RemoteTransactionV2, ...]:
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
               t.is_cash_withdrawal, t.updated_at, t.classification_revision
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
        RemoteTransactionV2(
            **{
                **dict(row),
                "pending": bool(row["pending"]),
                "manual_cash": bool(row["manual_cash"]),
                "is_cash_withdrawal": bool(row["is_cash_withdrawal"]),
            }
        )
        for row in rows
    )


def _taxonomy(connection: sqlite3.Connection) -> RemoteTaxonomy:
    categories = tuple(
        RemoteTaxonomyCategory(**dict(row))
        for row in connection.execute(
            """
            SELECT c.id, c.name, c.category_type, c.reporting_behavior,
                   c.group_id, g.name AS 'group', c.sort_order
            FROM categories c
            LEFT JOIN category_groups g ON g.id = c.group_id
            WHERE c.archived = 0
            ORDER BY COALESCE(g.sort_order, 2147483647), c.sort_order, c.name, c.id
            """
        )
    )
    category_ids = {item.id for item in categories}
    if not category_ids:
        return RemoteTaxonomy(categories=(), subcategories=())
    placeholders = ",".join("?" for _ in category_ids)
    subcategories = tuple(
        RemoteTaxonomySubcategory(**dict(row))
        for row in connection.execute(
            f"""
            SELECT id, category_id, name, sort_order
            FROM subcategories
            WHERE archived = 0 AND category_id IN ({placeholders})
            ORDER BY category_id, sort_order, name, id
            """,
            tuple(sorted(category_ids)),
        )
    )
    return RemoteTaxonomy(categories=categories, subcategories=subcategories)


def _savings_model(
    connection: sqlite3.Connection, month: str, owner: str | None
) -> dict[str, Any]:
    summary = savings_summary(connection, month, owner)
    result = {
        "month": summary.month,
        "owner": summary.owner,
        "connected_total_minor": summary.connected_total_minor,
        "manual_savings_minor": summary.manual_savings_minor,
        "investments_minor": summary.investments_minor,
        "other_assets_minor": summary.other_assets_minor,
        "combined_total_minor": summary.combined_total_minor,
        "contributions_minor": summary.contributions_minor,
        "withdrawals_minor": summary.withdrawals_minor,
        "earnings_minor": summary.earnings_minor,
        "accounts": [
            {
                "account_id": item.account_id,
                "name": item.name,
                "owner": item.owner,
                "balance_minor": item.balance_minor,
                "pool": item.pool,
            }
            for item in summary.accounts
        ],
        "manual_assets": [
            {
                "id": item.id,
                "title": item.title,
                "kind": item.kind,
                "owner": item.owner,
                "current_value_minor": item.current_value_minor,
                "savings_pool": item.savings_pool,
            }
            for item in summary.manual_assets
        ],
        "activity": [
            {
                "transaction_id": item.transaction_id,
                "local_date": item.local_date,
                "title": item.title,
                "kind": item.kind,
                "amount_minor": item.amount_minor,
                "owner": item.owner,
            }
            for item in summary.activity
        ],
    }
    initialized = connection.execute("SELECT 1 FROM savings_settings WHERE id = 1").fetchone()
    result["goal_ledger"] = (
        _goal_ledger_model(savings_goal_overview(connection, month, owner)) if initialized else None
    )
    return result


def _planning_model(value: Any) -> dict[str, Any]:
    return {
        "month": value.month,
        "target_total_minor": value.target_total_minor,
        "actual_total_minor": value.actual_total_minor,
        "remaining_total_minor": value.remaining_total_minor,
        "planned_income_total_minor": value.planned_income_total_minor,
        "surplus_shortfall_minor": value.surplus_shortfall_minor,
        "categories": [
            {
                "category_id": item.category_id,
                "category": item.category,
                "historical_average_minor": item.historical_average_minor,
                "target_minor": item.target_minor,
                "actual_minor": item.actual_minor,
                "remaining_minor": item.remaining_minor,
                "status": item.status,
                "percent_used_basis_points": item.percent_used_basis_points,
                "subcategories": [
                    {"subcategory": child.subcategory, "actual_minor": child.actual_minor}
                    for child in item.subcategories
                ],
                "trend": [
                    {"month": point.month, "amount_minor": point.amount_minor}
                    for point in item.trend[-12:]
                ],
                "transaction_ids": list(item.transaction_ids),
            }
            for item in value.categories
        ],
    }


def _goal_ledger_model(value: Any) -> dict[str, Any]:
    return {
        "regular_minor": value.regular_minor,
        "retirement_minor": value.retirement_minor,
        "combined_minor": value.combined_minor,
        "goals": [
            {
                "goal_id": goal.goal_id,
                "name": goal.name,
                "pool": goal.pool,
                "owner": goal.owner,
                "balance_minor": goal.balance_minor,
                "monthly_target_minor": goal.monthly_target_minor,
                "monthly_saved_minor": goal.monthly_saved_minor,
                "monthly_funded_basis_points": goal.monthly_funded_basis_points,
                "overall_target_minor": goal.overall_target_minor,
                "overall_remaining_minor": goal.overall_remaining_minor,
                "months": [
                    {
                        "month": point.month,
                        "additions_minor": point.additions_minor,
                        "spending_draw_minor": point.spending_draw_minor,
                        "closing_minor": point.closing_minor,
                    }
                    for point in goal.months[-12:]
                ],
            }
            for goal in value.goals
        ],
    }


def _cash_flow_paths_model(connection: sqlite3.Connection, month: str) -> dict[str, Any]:
    value = cash_flow_paths(connection, month)
    return {
        "month": value["month"],
        "nodes": [
            {key: item[key] for key in ("id", "label", "kind", "amount_minor", "entry_ids")}
            for item in value["nodes"]
        ],
        "links": [
            {key: item[key] for key in ("source", "target", "amount_minor", "entry_ids")}
            for item in value["links"]
        ],
        "entries": [
            {key: item[key] for key in (
                "id", "transaction_id", "local_date", "merchant", "description", "category",
                "category_id", "subcategory_id", "subcategory", "amount_minor", "currency",
                "spending_owner",
            )}
            for item in value["entries"]
        ],
    }


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
