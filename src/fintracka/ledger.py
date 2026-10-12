from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any

from fintracka.ids import new_id


class IntegrityError(ValueError):
    pass


class ConflictError(IntegrityError):
    pass


@dataclass(frozen=True)
class TransferCandidate:
    transaction_a: str
    transaction_b: str
    external_a: str
    external_b: str
    confidence: str


@dataclass(frozen=True)
class ReconciliationResult:
    reconciliation_id: str
    status: str
    difference_minor: int


_UNSET = object()


def update_transaction(
    connection: sqlite3.Connection,
    transaction_id: str,
    *,
    category_id: str | None | object = _UNSET,
    notes: str | None | object = _UNSET,
    user_merchant: str | None | object = _UNSET,
) -> None:
    row = connection.execute("SELECT * FROM transactions WHERE id = ?", (transaction_id,)).fetchone()
    if row is None:
        raise IntegrityError("transaction not found")
    changes: dict[str, Any] = {}
    if category_id is not _UNSET:
        changes["category_id"] = category_id
        changes["category_source"] = "manual" if category_id else None
    if notes is not _UNSET:
        changes["notes"] = notes
    if user_merchant is not _UNSET:
        changes["user_merchant"] = user_merchant
    if not changes:
        return
    now = _now()
    assignments = ", ".join(f"{column} = ?" for column in changes)
    connection.execute(
        f"UPDATE transactions SET {assignments}, updated_at = ? WHERE id = ?",
        (*changes.values(), now, transaction_id),
    )
    _audit(connection, "user", "transaction_update", "transaction", transaction_id, now)


def set_splits(
    connection: sqlite3.Connection,
    transaction_id: str,
    splits: list[tuple[int, str | None, str | None]],
    *,
    expected_updated_at: str | None = None,
) -> None:
    if len(splits) < 2:
        raise IntegrityError("a split requires at least two children")
    if any(amount == 0 for amount, _, _ in splits):
        raise IntegrityError("split amounts cannot be zero")
    now = _now()
    try:
        connection.execute("BEGIN IMMEDIATE")
        parent = connection.execute(
            "SELECT amount_minor, updated_at FROM transactions WHERE id = ?", (transaction_id,)
        ).fetchone()
        if parent is None:
            raise IntegrityError("transaction not found")
        if expected_updated_at is not None and parent["updated_at"] != expected_updated_at:
            raise ConflictError("transaction changed; refresh and retry")
        if sum(amount for amount, _, _ in splits) != parent["amount_minor"]:
            raise IntegrityError("split children must sum exactly to the parent")
        connection.execute("DELETE FROM transaction_splits WHERE parent_transaction_id = ?", (transaction_id,))
        connection.executemany(
            "INSERT INTO transaction_splits (id, parent_transaction_id, amount_minor, category_id, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            [(new_id(), transaction_id, amount, category, notes, now) for amount, category, notes in splits],
        )
        connection.execute(
            "UPDATE transactions SET has_splits = 1, updated_at = ? WHERE id = ?", (now, transaction_id)
        )
        _audit(connection, "user", "transaction_split", "transaction", transaction_id, now)
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def create_rule(
    connection: sqlite3.Connection,
    name: str,
    priority: int,
    conditions: dict[str, Any],
    category_id: str,
) -> str:
    _validate_rule_conditions(conditions)
    rule_id = new_id()
    now = _now()
    connection.execute(
        "INSERT INTO categorization_rules (id, name, priority, conditions_json, category_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (rule_id, name, priority, json.dumps(conditions, sort_keys=True), category_id, now, now),
    )
    _audit(connection, "user", "rule_create", "categorization_rule", rule_id, now)
    return rule_id


def _validate_rule_conditions(conditions: dict[str, Any]) -> None:
    allowed = {"description_contains", "merchant_contains", "min_amount_minor", "max_amount_minor", "account_id", "pending"}
    if not conditions or not set(conditions) <= allowed:
        raise IntegrityError("unsupported or empty rule conditions")
    for key in ("description_contains", "merchant_contains", "account_id"):
        if key in conditions and (not isinstance(conditions[key], str) or not conditions[key].strip()):
            raise IntegrityError(f"{key} must be a non-empty string")
    for key in ("min_amount_minor", "max_amount_minor"):
        if key in conditions and (not isinstance(conditions[key], int) or isinstance(conditions[key], bool)):
            raise IntegrityError(f"{key} must be an integer")
    if "pending" in conditions and not isinstance(conditions["pending"], bool):
        raise IntegrityError("pending must be a boolean")
    minimum = conditions.get("min_amount_minor")
    maximum = conditions.get("max_amount_minor")
    if isinstance(minimum, int) and isinstance(maximum, int) and minimum > maximum:
        raise IntegrityError("minimum amount must not exceed maximum amount")


def apply_rules(connection: sqlite3.Connection, *, reprocess: bool = False) -> int:
    rules = connection.execute(
        "SELECT id, conditions_json, category_id FROM categorization_rules WHERE enabled = 1 ORDER BY priority, id"
    ).fetchall()
    transactions = connection.execute(
        "SELECT * FROM transactions WHERE tombstoned = 0 ORDER BY local_date, id"
    ).fetchall()
    applied = 0
    now = _now()
    for transaction in transactions:
        if transaction["category_source"] == "manual":
            continue
        if transaction["category_id"] is not None and not reprocess:
            continue
        for rule in rules:
            if not _matches(transaction, json.loads(rule["conditions_json"])):
                continue
            if transaction["category_id"] != rule["category_id"] or transaction["category_source"] != "rule" or reprocess:
                connection.execute(
                    "UPDATE transactions SET category_id = ?, category_source = 'rule', updated_at = ? WHERE id = ?",
                    (rule["category_id"], now, transaction["id"]),
                )
                connection.execute(
                    "INSERT INTO rule_applications (id, rule_id, transaction_id, result, applied_at) VALUES (?, ?, ?, 'applied', ?)",
                    (new_id(), rule["id"], transaction["id"], now),
                )
                _audit(connection, "rule", "rule_apply", "transaction", transaction["id"], now)
                applied += 1
            break
    return applied


def preview_rules(connection: sqlite3.Connection) -> list[dict[str, str | int]]:
    rules = connection.execute(
        "SELECT id, name, priority, conditions_json FROM categorization_rules WHERE enabled = 1 ORDER BY priority, id"
    ).fetchall()
    transactions = connection.execute(
        "SELECT * FROM transactions WHERE tombstoned = 0 AND category_source IS NOT 'manual' ORDER BY local_date, id"
    ).fetchall()
    claimed: set[str] = set()
    preview: list[dict[str, str | int]] = []
    for rule in rules:
        matches = [
            transaction["id"]
            for transaction in transactions
            if transaction["id"] not in claimed
            and _matches(transaction, json.loads(rule["conditions_json"]))
        ]
        claimed.update(matches)
        preview.append(
            {
                "rule_id": rule["id"],
                "name": rule["name"],
                "priority": rule["priority"],
                "match_count": len(matches),
            }
        )
    return preview


def transfer_candidates(connection: sqlite3.Connection) -> list[TransferCandidate]:
    rows = connection.execute(
        """
        SELECT t.id, t.account_id, t.local_date, t.amount_minor, t.currency,
               (SELECT external_id FROM transaction_external_ids e WHERE e.transaction_id = t.id ORDER BY CASE e.state WHEN 'posted' THEN 0 ELSE 1 END, e.external_id LIMIT 1) external_id
        FROM transactions t
        WHERE t.tombstoned = 0 AND t.pending = 0
          AND NOT EXISTS (
              SELECT 1 FROM transfer_links l
              WHERE l.status = 'confirmed' AND (l.transaction_a_id = t.id OR l.transaction_b_id = t.id)
          )
        ORDER BY t.local_date, t.id
        """
    ).fetchall()
    candidates: list[TransferCandidate] = []
    for index, left in enumerate(rows):
        for right in rows[index + 1 :]:
            if left["account_id"] == right["account_id"] or left["currency"] != right["currency"]:
                continue
            if left["amount_minor"] != -right["amount_minor"]:
                continue
            days = abs((date.fromisoformat(left["local_date"]) - date.fromisoformat(right["local_date"])).days)
            if days <= 3:
                candidates.append(
                    TransferCandidate(
                        left["id"],
                        right["id"],
                        left["external_id"] or left["id"],
                        right["external_id"] or right["id"],
                        "high" if days <= 1 else "medium",
                    )
                )
    return candidates


def confirm_transfer(connection: sqlite3.Connection, transaction_a: str, transaction_b: str) -> str:
    if transaction_a == transaction_b:
        raise IntegrityError("a transfer requires two transactions")
    existing = connection.execute(
        "SELECT 1 FROM transfer_links WHERE status = 'confirmed' AND (transaction_a_id IN (?, ?) OR transaction_b_id IN (?, ?))",
        (transaction_a, transaction_b, transaction_a, transaction_b),
    ).fetchone()
    if existing:
        raise IntegrityError("transaction is already in a confirmed transfer")
    rows = connection.execute(
        "SELECT id, account_id, amount_minor, currency FROM transactions WHERE id IN (?, ?)",
        (transaction_a, transaction_b),
    ).fetchall()
    if len(rows) != 2 or rows[0]["account_id"] == rows[1]["account_id"]:
        raise IntegrityError("transfer transactions must use different owned accounts")
    if rows[0]["currency"] != rows[1]["currency"] or rows[0]["amount_minor"] != -rows[1]["amount_minor"]:
        raise IntegrityError("transfer amounts must be exact opposites")
    first, second = sorted((transaction_a, transaction_b))
    link_id = new_id()
    now = _now()
    connection.execute(
        "INSERT INTO transfer_links (id, transaction_a_id, transaction_b_id, status, confidence, reason, created_at, updated_at) VALUES (?, ?, ?, 'confirmed', 'high', 'user confirmed exact owned-account match', ?, ?)",
        (link_id, first, second, now, now),
    )
    _audit(connection, "user", "transfer_confirm", "transfer_link", link_id, now)
    return link_id


def reconcile(
    connection: sqlite3.Connection,
    account_id: str,
    period_start: str,
    period_end: str,
    opening_minor: int,
    closing_minor: int,
    cleared_cutoff: str,
) -> ReconciliationResult:
    activity = connection.execute(
        """
        SELECT COALESCE(SUM(amount_minor), 0)
        FROM transactions
        WHERE account_id = ? AND local_date BETWEEN ? AND ? AND local_date <= ?
          AND tombstoned = 0 AND pending = 0
        """,
        (account_id, period_start, period_end, cleared_cutoff),
    ).fetchone()[0]
    expected = opening_minor + activity
    difference = closing_minor - expected
    status = "balanced" if difference == 0 else "unbalanced"
    reconciliation_id = new_id()
    now = _now()
    connection.execute(
        "INSERT INTO reconciliations (id, account_id, period_start, period_end, opening_minor, closing_minor, cleared_cutoff, difference_minor, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (reconciliation_id, account_id, period_start, period_end, opening_minor, closing_minor, cleared_cutoff, difference, status, now),
    )
    if difference:
        connection.execute(
            "INSERT INTO reconciliation_issues (id, reconciliation_id, issue_type, detail) VALUES (?, ?, 'balance_difference', ?)",
            (new_id(), reconciliation_id, f"statement differs by {difference} minor units"),
        )
    _audit(connection, "user", "reconciliation_create", "reconciliation", reconciliation_id, now)
    return ReconciliationResult(reconciliation_id, status, difference)


def _matches(transaction: sqlite3.Row, conditions: dict[str, Any]) -> bool:
    description = transaction["provider_description"].casefold()
    merchant = (transaction["user_merchant"] or transaction["provider_merchant"] or "").casefold()
    checks = {
        "description_contains": lambda value: str(value).casefold() in description,
        "merchant_contains": lambda value: str(value).casefold() in merchant,
        "min_amount_minor": lambda value: transaction["amount_minor"] >= int(value),
        "max_amount_minor": lambda value: transaction["amount_minor"] <= int(value),
        "account_id": lambda value: transaction["account_id"] == value,
        "pending": lambda value: bool(transaction["pending"]) is bool(value),
    }
    return all(checks[key](value) for key, value in conditions.items())


def _audit(
    connection: sqlite3.Connection,
    actor: str,
    action: str,
    entity_type: str,
    entity_id: str,
    now: str,
) -> None:
    connection.execute(
        "INSERT INTO audit_events (id, actor, action, entity_type, entity_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
        (new_id(), actor, action, entity_type, entity_id, now),
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
