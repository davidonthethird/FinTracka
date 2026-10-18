from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timezone

from fintracka.ids import new_id


class ManualAssetError(ValueError):
    pass


@dataclass(frozen=True)
class BalancePoint:
    observed_at: str
    current_minor: int


@dataclass(frozen=True)
class SavingsAccount:
    account_id: str
    name: str
    owner: str
    balance_minor: int
    currency: str
    history: tuple[BalancePoint, ...]


@dataclass(frozen=True)
class ManualAsset:
    id: str
    title: str
    kind: str
    owner: str
    current_value_minor: int
    currency: str
    as_of_date: str
    updated_at: str


@dataclass(frozen=True)
class SavingsActivity:
    transaction_id: str
    account_id: str
    local_date: str
    title: str
    kind: str
    amount_minor: int
    owner: str


@dataclass(frozen=True)
class SavingsSummary:
    month: str
    owner: str | None
    connected_total_minor: int
    manual_savings_minor: int
    investments_minor: int
    other_assets_minor: int
    combined_total_minor: int
    contributions_minor: int
    withdrawals_minor: int
    earnings_minor: int
    accounts: tuple[SavingsAccount, ...]
    manual_assets: tuple[ManualAsset, ...]
    activity: tuple[SavingsActivity, ...]


def savings_summary(
    connection: sqlite3.Connection, month: str, owner: str | None = None
) -> SavingsSummary:
    _validate_month(month)
    _validate_owner(owner)
    owner_clause = " AND a.spending_owner = ?" if owner else ""
    account_parameters: tuple[str, ...] = (owner,) if owner else ()
    account_rows = connection.execute(
        f"""
        SELECT a.id, COALESCE(NULLIF(a.nickname, ''), a.name) name,
               a.spending_owner owner, a.currency,
               COALESCE((
                   SELECT b.current_minor FROM account_balance_snapshots b
                   WHERE b.account_id = a.id
                   ORDER BY b.observed_at DESC, b.id DESC LIMIT 1
               ), 0) balance_minor
        FROM accounts a
        WHERE a.include_savings = 1 AND a.status = 'active' AND a.hidden = 0 AND a.currency = 'USD'
              {owner_clause}
        ORDER BY name, a.id
        """,
        account_parameters,
    ).fetchall()
    accounts = tuple(
        SavingsAccount(
            row["id"],
            row["name"],
            row["owner"],
            row["balance_minor"],
            row["currency"],
            tuple(
                BalancePoint(point["observed_at"], point["current_minor"])
                for point in connection.execute(
                    """
                    SELECT observed_at, current_minor FROM account_balance_snapshots
                    WHERE account_id = ? ORDER BY observed_at, id
                    """,
                    (row["id"],),
                )
            ),
        )
        for row in account_rows
    )

    asset_clause = " AND owner = ?" if owner else ""
    assets = tuple(
        ManualAsset(**dict(row))
        for row in connection.execute(
            f"""
            SELECT id, title, kind, owner, current_value_minor, currency,
                   as_of_date, updated_at
            FROM manual_assets WHERE active = 1 {asset_clause}
            ORDER BY kind, title, id
            """,
            (owner,) if owner else (),
        )
    )
    account_ids = [row.account_id for row in accounts]
    activity: list[SavingsActivity] = []
    if account_ids:
        rows = connection.execute(
            f"""
            SELECT t.id, t.account_id, t.local_date,
                   COALESCE(NULLIF(t.user_merchant, ''), NULLIF(t.provider_merchant, ''),
                            t.provider_description) title,
                   t.amount_minor, COALESCE(t.spending_owner, a.spending_owner) owner,
                   c.category_type,
                   EXISTS (
                       SELECT 1 FROM transfer_links l
                       JOIN transactions other ON other.id = CASE
                           WHEN l.transaction_a_id = t.id THEN l.transaction_b_id
                           ELSE l.transaction_a_id END
                       JOIN accounts other_account ON other_account.id = other.account_id
                       WHERE l.status = 'confirmed'
                         AND (l.transaction_a_id = t.id OR l.transaction_b_id = t.id)
                         AND other_account.include_savings = 1 AND other_account.hidden = 0
                   ) internal_savings_transfer
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            LEFT JOIN categories c ON c.id = t.category_id
            WHERE t.account_id IN ({','.join('?' for _ in account_ids)})
              AND t.local_date BETWEEN ? AND ? AND t.tombstoned = 0 AND t.user_archived = 0 AND t.pending = 0
              AND t.currency = 'USD'
            ORDER BY t.local_date DESC, t.id DESC
            """,
            (*account_ids, month + "-01", _month_end(month)),
        ).fetchall()
        for row in rows:
            if row["category_type"] == "transfer":
                if row["internal_savings_transfer"]:
                    continue
                kind = "contribution" if row["amount_minor"] > 0 else "withdrawal"
            elif row["amount_minor"] > 0:
                kind = "earnings"
            else:
                kind = "expense"
            activity.append(
                SavingsActivity(
                    row["id"], row["account_id"], row["local_date"], row["title"],
                    kind, abs(row["amount_minor"]), row["owner"]
                )
            )

    connected = sum(row.balance_minor for row in accounts)
    manual_savings = sum(row.current_value_minor for row in assets if row.kind == "savings")
    investments = sum(row.current_value_minor for row in assets if row.kind == "investment")
    other_assets = sum(row.current_value_minor for row in assets if row.kind == "other")
    contributions = sum(row.amount_minor for row in activity if row.kind == "contribution")
    withdrawals = sum(row.amount_minor for row in activity if row.kind == "withdrawal")
    earnings = sum(row.amount_minor for row in activity if row.kind == "earnings")
    return SavingsSummary(
        month,
        owner,
        connected,
        manual_savings,
        investments,
        other_assets,
        connected + manual_savings + investments + other_assets,
        contributions,
        withdrawals,
        earnings,
        accounts,
        assets,
        tuple(activity),
    )


def create_manual_asset(
    connection: sqlite3.Connection,
    title: str,
    kind: str,
    owner: str,
    current_value_minor: int,
    as_of_date: str,
) -> str:
    title = _validate_asset(title, kind, owner, current_value_minor, as_of_date)
    identifier = new_id()
    now = _now()
    connection.execute(
        """
        INSERT INTO manual_assets
            (id, title, kind, owner, current_value_minor, currency, as_of_date,
             active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'USD', ?, 1, ?, ?)
        """,
        (identifier, title, kind, owner, current_value_minor, as_of_date, now, now),
    )
    after = dict(connection.execute("SELECT * FROM manual_assets WHERE id = ?", (identifier,)).fetchone())
    _audit(connection, "manual_asset_create", identifier, now, None, after)
    return identifier


def update_manual_asset(
    connection: sqlite3.Connection,
    identifier: str,
    expected_updated_at: str,
    title: str,
    kind: str,
    owner: str,
    current_value_minor: int,
    as_of_date: str,
) -> None:
    title = _validate_asset(title, kind, owner, current_value_minor, as_of_date)
    before = _asset(connection, identifier)
    _require_current(before, expected_updated_at)
    if not before["active"]:
        raise ManualAssetError("manual asset is inactive")
    now = _now()
    connection.execute(
        """
        UPDATE manual_assets SET title = ?, kind = ?, owner = ?, current_value_minor = ?,
            as_of_date = ?, updated_at = ? WHERE id = ?
        """,
        (title, kind, owner, current_value_minor, as_of_date, now, identifier),
    )
    after = dict(_asset(connection, identifier))
    _audit(connection, "manual_asset_update", identifier, now, dict(before), after)


def deactivate_manual_asset(
    connection: sqlite3.Connection, identifier: str, expected_updated_at: str
) -> None:
    before = _asset(connection, identifier)
    _require_current(before, expected_updated_at)
    if not before["active"]:
        return
    now = _now()
    connection.execute(
        "UPDATE manual_assets SET active = 0, updated_at = ? WHERE id = ?",
        (now, identifier),
    )
    after = dict(_asset(connection, identifier))
    _audit(connection, "manual_asset_deactivate", identifier, now, dict(before), after)


def get_manual_asset(connection: sqlite3.Connection, identifier: str) -> dict[str, object]:
    return dict(_asset(connection, identifier))


def _asset(connection: sqlite3.Connection, identifier: str) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM manual_assets WHERE id = ?", (identifier,)).fetchone()
    if row is None:
        raise ManualAssetError("manual asset not found")
    return row


def _require_current(row: sqlite3.Row, expected_updated_at: str) -> None:
    if row["updated_at"] != expected_updated_at:
        raise ManualAssetError("manual asset changed; refresh and retry")


def _validate_asset(
    title: str, kind: str, owner: str, current_value_minor: int, as_of_date: str
) -> str:
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120:
        raise ManualAssetError("title is required")
    if kind not in {"savings", "investment", "other"}:
        raise ManualAssetError("invalid asset kind")
    _validate_owner(owner)
    if (
        isinstance(current_value_minor, bool)
        or not isinstance(current_value_minor, int)
        or current_value_minor < 0
    ):
        raise ManualAssetError("asset value must be a nonnegative integer")
    try:
        date.fromisoformat(as_of_date)
    except (TypeError, ValueError) as error:
        raise ManualAssetError("date must use YYYY-MM-DD") from error
    return title.strip()


def _validate_owner(owner: str | None) -> None:
    if owner not in {None, "David", "Ariela", "Shared"}:
        raise ManualAssetError("invalid owner")


def _validate_month(month: str) -> None:
    try:
        parsed = date.fromisoformat(month + "-01")
    except (TypeError, ValueError) as error:
        raise ManualAssetError("month must use YYYY-MM") from error
    if parsed.strftime("%Y-%m") != month:
        raise ManualAssetError("month must use YYYY-MM")


def _month_end(month: str) -> str:
    year, number = (int(part) for part in month.split("-"))
    if number == 12:
        following = date(year + 1, 1, 1)
    else:
        following = date(year, number + 1, 1)
    return date.fromordinal(following.toordinal() - 1).isoformat()


def _audit(
    connection: sqlite3.Connection,
    action: str,
    identifier: str,
    now: str,
    before: dict[str, object] | None,
    after: dict[str, object] | None,
) -> None:
    connection.execute(
        """
        INSERT INTO audit_events
            (id, actor, action, entity_type, entity_id, occurred_at, before_json, after_json)
        VALUES (?, 'user', ?, 'manual_asset', ?, ?, ?, ?)
        """,
        (
            new_id(), action, identifier, now,
            json.dumps(before, sort_keys=True) if before is not None else None,
            json.dumps(after, sort_keys=True) if after is not None else None,
        ),
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
