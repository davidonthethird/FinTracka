from __future__ import annotations

import json
import re
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
    label_a: str
    label_b: str
    date_a: str
    date_b: str
    amount_minor: int
    currency: str
    confidence: str


@dataclass(frozen=True)
class ReconciliationResult:
    reconciliation_id: str
    status: str
    difference_minor: int


@dataclass(frozen=True)
class CategorizationResult:
    affected_count: int
    undo_id: str


_UNSET = object()


def update_transaction(
    connection: sqlite3.Connection,
    transaction_id: str,
    *,
    category_id: str | None | object = _UNSET,
    notes: str | None | object = _UNSET,
    user_merchant: str | None | object = _UNSET,
    spending_owner: str | None | object = _UNSET,
    archived: bool | object = _UNSET,
) -> None:
    row = connection.execute("SELECT * FROM transactions WHERE id = ?", (transaction_id,)).fetchone()
    if row is None:
        raise IntegrityError("transaction not found")
    changes: dict[str, Any] = {}
    if category_id is not _UNSET:
        changes["category_id"] = category_id
        changes["category_source"] = "manual" if category_id else None
        if row["subcategory_id"] is not None and not _subcategory_belongs_to_category(
            connection, row["subcategory_id"], category_id
        ):
            changes["subcategory_id"] = None
            changes["subcategory_source"] = None
    if notes is not _UNSET:
        changes["notes"] = notes
    if user_merchant is not _UNSET:
        changes["user_merchant"] = user_merchant
    if spending_owner is not _UNSET:
        if spending_owner not in {None, "David", "Ariela", "Shared"}:
            raise IntegrityError("invalid spending owner")
        changes["spending_owner"] = spending_owner
    if archived is not _UNSET:
        if not isinstance(archived, bool):
            raise IntegrityError("archived must be a boolean")
        if bool(row["user_archived"]) != archived:
            changes["user_archived"] = int(archived)
    if not changes:
        return
    now = _now()
    assignments = ", ".join(f"{column} = ?" for column in changes)
    connection.execute(
        f"UPDATE transactions SET {assignments}, updated_at = ? WHERE id = ?",
        (*changes.values(), now, transaction_id),
    )
    action = "transaction_restore" if archived is False else "transaction_archive" if archived is True else "transaction_update"
    _audit(connection, "user", action, "transaction", transaction_id, now)


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


def categorize_transaction(
    connection: sqlite3.Connection,
    transaction_id: str,
    category_id: str,
    scope: str,
) -> CategorizationResult:
    if scope not in {"one_time", "future", "past_and_future"}:
        raise IntegrityError("invalid categorization scope")
    transaction = connection.execute("SELECT * FROM transactions WHERE id = ?", (transaction_id,)).fetchone()
    if transaction is None:
        raise IntegrityError("transaction not found")
    if transaction["is_cash_withdrawal"]:
        scope = "one_time"
    if connection.execute("SELECT 1 FROM categories WHERE id = ? AND archived = 0", (category_id,)).fetchone() is None:
        raise IntegrityError("category not found")

    conditions = _learned_conditions(transaction)
    matching = [transaction]
    if scope == "past_and_future":
        matching = [
            row
            for row in connection.execute("SELECT * FROM transactions WHERE tombstoned = 0 AND user_archived = 0")
            if row["id"] == transaction_id
            or (
                row["category_source"] != "manual"
                and not row["is_cash_withdrawal"]
                and _matches(row, conditions)
            )
        ]

    now = _now()
    undo_id = new_id()
    rule_id: str | None = None
    prior_rule_category_id: str | None = None
    rule_created = 0
    if scope != "one_time":
        serialized = json.dumps(conditions, sort_keys=True)
        rule = connection.execute(
            "SELECT id, category_id FROM categorization_rules WHERE name LIKE 'Learned: %' AND conditions_json = ?",
            (serialized,),
        ).fetchone()
        if rule:
            rule_id = rule["id"]
            prior_rule_category_id = rule["category_id"]
            connection.execute(
                "UPDATE categorization_rules SET category_id = ?, enabled = 1, updated_at = ? WHERE id = ?",
                (category_id, now, rule_id),
            )
            _audit(connection, "user", "rule_update", "categorization_rule", rule_id, now)
        else:
            priority = connection.execute(
                "SELECT COALESCE(MIN(priority), 1) - 1 FROM categorization_rules"
            ).fetchone()[0]
            label = transaction["user_merchant"] or transaction["provider_merchant"] or transaction["provider_description"]
            rule_id = create_rule(connection, f"Learned: {label}"[:120], priority, conditions, category_id)
            rule_created = 1

    connection.execute(
        "INSERT INTO categorization_undo_batches (id, rule_id, prior_rule_category_id, rule_created, created_at) VALUES (?, ?, ?, ?, ?)",
        (undo_id, rule_id, prior_rule_category_id, rule_created, now),
    )
    connection.executemany(
        "INSERT INTO categorization_undo_items (batch_id, transaction_id, category_id, category_source) VALUES (?, ?, ?, ?)",
        [(undo_id, row["id"], row["category_id"], row["category_source"]) for row in matching],
    )
    for row in matching:
        source = "manual" if row["id"] == transaction_id else "rule"
        subcategory_id = (
            row["subcategory_id"]
            if _subcategory_belongs_to_category(connection, row["subcategory_id"], category_id)
            else None
        )
        connection.execute(
            """
            UPDATE transactions SET category_id = ?, category_source = ?, subcategory_id = ?,
                subcategory_source = CASE WHEN ? IS NULL THEN NULL ELSE subcategory_source END,
                updated_at = ? WHERE id = ?
            """,
            (category_id, source, subcategory_id, subcategory_id, now, row["id"]),
        )
        if source == "rule" and rule_id:
            connection.execute(
                "INSERT INTO rule_applications (id, rule_id, transaction_id, result, applied_at) VALUES (?, ?, ?, 'applied', ?)",
                (new_id(), rule_id, row["id"], now),
            )
        _audit(connection, "user" if source == "manual" else "rule", "category_assign", "transaction", row["id"], now)
    return CategorizationResult(len(matching), undo_id)


def undo_categorization(connection: sqlite3.Connection, undo_id: str) -> int:
    batch = connection.execute(
        "SELECT * FROM categorization_undo_batches WHERE id = ?", (undo_id,)
    ).fetchone()
    if batch is None or batch["used"]:
        raise IntegrityError("categorization change cannot be undone")
    items = connection.execute(
        "SELECT * FROM categorization_undo_items WHERE batch_id = ?", (undo_id,)
    ).fetchall()
    now = _now()
    for item in items:
        connection.execute(
            "UPDATE transactions SET category_id = ?, category_source = ?, updated_at = ? WHERE id = ?",
            (item["category_id"], item["category_source"], now, item["transaction_id"]),
        )
        _audit(connection, "user", "category_undo", "transaction", item["transaction_id"], now)
    if batch["rule_id"]:
        if batch["rule_created"]:
            connection.execute(
                "UPDATE categorization_rules SET enabled = 0, updated_at = ? WHERE id = ?",
                (now, batch["rule_id"]),
            )
        else:
            connection.execute(
                "UPDATE categorization_rules SET category_id = ?, updated_at = ? WHERE id = ?",
                (batch["prior_rule_category_id"], now, batch["rule_id"]),
            )
    connection.execute("UPDATE categorization_undo_batches SET used = 1 WHERE id = ?", (undo_id,))
    return len(items)


def _learned_conditions(transaction: sqlite3.Row) -> dict[str, str]:
    direction = "inflow" if transaction["amount_minor"] > 0 else "outflow"
    merchant = transaction["user_merchant"] or transaction["provider_merchant"]
    if merchant:
        return {"direction": direction, "merchant_equals": merchant}
    return {"description_equals": transaction["provider_description"], "direction": direction}


def _validate_rule_conditions(conditions: dict[str, Any]) -> None:
    allowed = {"description_contains", "description_equals", "merchant_contains", "merchant_equals", "direction", "min_amount_minor", "max_amount_minor", "account_id", "pending"}
    if not conditions or not set(conditions) <= allowed:
        raise IntegrityError("unsupported or empty rule conditions")
    for key in ("description_contains", "description_equals", "merchant_contains", "merchant_equals", "account_id"):
        if key in conditions and (not isinstance(conditions[key], str) or not conditions[key].strip()):
            raise IntegrityError(f"{key} must be a non-empty string")
    for key in ("min_amount_minor", "max_amount_minor"):
        if key in conditions and (not isinstance(conditions[key], int) or isinstance(conditions[key], bool)):
            raise IntegrityError(f"{key} must be an integer")
    if "pending" in conditions and not isinstance(conditions["pending"], bool):
        raise IntegrityError("pending must be a boolean")
    if "direction" in conditions and conditions["direction"] not in {"inflow", "outflow"}:
        raise IntegrityError("direction must be inflow or outflow")
    minimum = conditions.get("min_amount_minor")
    maximum = conditions.get("max_amount_minor")
    if isinstance(minimum, int) and isinstance(maximum, int) and minimum > maximum:
        raise IntegrityError("minimum amount must not exceed maximum amount")


def apply_rules(connection: sqlite3.Connection, *, reprocess: bool = False) -> int:
    rules = connection.execute(
        "SELECT id, conditions_json, category_id FROM categorization_rules WHERE enabled = 1 ORDER BY priority, id"
    ).fetchall()
    transactions = connection.execute(
        "SELECT * FROM transactions WHERE tombstoned = 0 AND user_archived = 0 ORDER BY local_date, id"
    ).fetchall()
    applied = 0
    now = _now()
    for transaction in transactions:
        if transaction["category_source"] == "manual" or transaction["is_cash_withdrawal"]:
            continue
        if transaction["category_id"] is not None and transaction["category_source"] != "provider" and not reprocess:
            continue
        for rule in rules:
            if not _matches(transaction, json.loads(rule["conditions_json"])):
                continue
            if transaction["category_id"] != rule["category_id"] or transaction["category_source"] != "rule" or reprocess:
                subcategory_id = (
                    transaction["subcategory_id"]
                    if _subcategory_belongs_to_category(
                        connection, transaction["subcategory_id"], rule["category_id"]
                    )
                    else None
                )
                connection.execute(
                    """
                    UPDATE transactions SET category_id = ?, category_source = 'rule',
                        subcategory_id = ?,
                        subcategory_source = CASE WHEN ? IS NULL THEN NULL ELSE subcategory_source END,
                        updated_at = ? WHERE id = ?
                    """,
                    (rule["category_id"], subcategory_id, subcategory_id, now, transaction["id"]),
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
        "SELECT * FROM transactions WHERE tombstoned = 0 AND user_archived = 0 AND category_source IS NOT 'manual' ORDER BY local_date, id"
    ).fetchall()
    claimed: set[str] = set()
    preview: list[dict[str, str | int]] = []
    for rule in rules:
        matches = [
            transaction["id"]
            for transaction in transactions
            if transaction["id"] not in claimed
            and not transaction["is_cash_withdrawal"]
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
               COALESCE(NULLIF(t.user_merchant, ''), NULLIF(t.provider_merchant, ''), t.provider_description) label,
               (SELECT external_id FROM transaction_external_ids e WHERE e.transaction_id = t.id ORDER BY CASE e.state WHEN 'posted' THEN 0 ELSE 1 END, e.external_id LIMIT 1) external_id
        FROM transactions t
        WHERE t.tombstoned = 0 AND t.user_archived = 0 AND t.pending = 0
          AND NOT EXISTS (
              SELECT 1 FROM transfer_links l
              WHERE l.status = 'confirmed' AND (l.transaction_a_id = t.id OR l.transaction_b_id = t.id)
          )
        ORDER BY t.local_date, t.id
        """
    ).fetchall()
    rejected = {
        (row["transaction_a_id"], row["transaction_b_id"])
        for row in connection.execute(
            "SELECT transaction_a_id, transaction_b_id FROM transfer_links WHERE status = 'rejected'"
        )
    }
    candidates: list[TransferCandidate] = []
    for index, left in enumerate(rows):
        for right in rows[index + 1 :]:
            if left["account_id"] == right["account_id"] or left["currency"] != right["currency"]:
                continue
            if left["amount_minor"] != -right["amount_minor"]:
                continue
            if tuple(sorted((left["id"], right["id"]))) in rejected:
                continue
            days = abs((date.fromisoformat(left["local_date"]) - date.fromisoformat(right["local_date"])).days)
            if days <= 3:
                candidates.append(
                    TransferCandidate(
                        left["id"],
                        right["id"],
                        left["external_id"] or left["id"],
                        right["external_id"] or right["id"],
                        left["label"],
                        right["label"],
                        left["local_date"],
                        right["local_date"],
                        abs(left["amount_minor"]),
                        left["currency"],
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
        "SELECT id, account_id, amount_minor, currency FROM transactions WHERE user_archived = 0 AND id IN (?, ?)",
        (transaction_a, transaction_b),
    ).fetchall()
    if len(rows) != 2 or rows[0]["account_id"] == rows[1]["account_id"]:
        raise IntegrityError("transfer transactions must use different owned accounts")
    if rows[0]["currency"] != rows[1]["currency"] or rows[0]["amount_minor"] != -rows[1]["amount_minor"]:
        raise IntegrityError("transfer amounts must be exact opposites")
    link_id = _create_transfer_link(
        connection,
        transaction_a,
        transaction_b,
        status="confirmed",
        reason="user confirmed exact owned-account match",
        actor="user",
        action="transfer_confirm",
    )
    confirm_learned_transfers(connection)
    return link_id


def reject_transfer(connection: sqlite3.Connection, transaction_a: str, transaction_b: str) -> str:
    if transaction_a == transaction_b:
        raise IntegrityError("a transfer requires two transactions")
    candidate = next(
        (
            item
            for item in transfer_candidates(connection)
            if {item.transaction_a, item.transaction_b} == {transaction_a, transaction_b}
        ),
        None,
    )
    if candidate is None:
        raise IntegrityError("transfer candidate not found")
    return _create_transfer_link(
        connection,
        transaction_a,
        transaction_b,
        status="rejected",
        reason="user kept transactions visible",
        actor="user",
        action="transfer_reject",
    )


def confirm_learned_transfers(connection: sqlite3.Connection) -> int:
    learned = {
        signature
        for row in connection.execute(
            "SELECT transaction_a_id, transaction_b_id FROM transfer_links WHERE status = 'confirmed'"
        )
        if (signature := _transfer_signature(connection, row["transaction_a_id"], row["transaction_b_id"]))
    }
    if not learned:
        return 0
    claimed = {
        identifier
        for row in connection.execute(
            "SELECT transaction_a_id, transaction_b_id FROM transfer_links WHERE status = 'confirmed'"
        )
        for identifier in (row["transaction_a_id"], row["transaction_b_id"])
    }
    count = 0
    for candidate in transfer_candidates(connection):
        if candidate.transaction_a in claimed or candidate.transaction_b in claimed:
            continue
        signature = _transfer_signature(connection, candidate.transaction_a, candidate.transaction_b)
        if signature not in learned:
            continue
        _create_transfer_link(
            connection,
            candidate.transaction_a,
            candidate.transaction_b,
            status="confirmed",
            reason="learned from confirmed account and counterparty pattern",
            actor="system",
            action="transfer_auto_confirm",
        )
        claimed.update((candidate.transaction_a, candidate.transaction_b))
        count += 1
    return count


def _create_transfer_link(
    connection: sqlite3.Connection,
    transaction_a: str,
    transaction_b: str,
    *,
    status: str,
    reason: str,
    actor: str,
    action: str,
) -> str:
    first, second = sorted((transaction_a, transaction_b))
    link_id = new_id()
    now = _now()
    connection.execute(
        "INSERT INTO transfer_links (id, transaction_a_id, transaction_b_id, status, confidence, reason, created_at, updated_at) VALUES (?, ?, ?, ?, 'high', ?, ?, ?)",
        (link_id, first, second, status, reason, now, now),
    )
    _audit(connection, actor, action, "transfer_link", link_id, now)
    return link_id


def _transfer_signature(
    connection: sqlite3.Connection, transaction_a: str, transaction_b: str
) -> tuple[str, str, str, str] | None:
    rows = connection.execute(
        """
        SELECT id, account_id, amount_minor,
               COALESCE(NULLIF(user_merchant, ''), NULLIF(provider_merchant, ''), provider_description) label
        FROM transactions WHERE id IN (?, ?)
        """,
        (transaction_a, transaction_b),
    ).fetchall()
    if len(rows) != 2:
        return None
    outgoing = next((row for row in rows if row["amount_minor"] < 0), None)
    incoming = next((row for row in rows if row["amount_minor"] > 0), None)
    if outgoing is None or incoming is None:
        return None
    outgoing_label = _normalized_counterparty(outgoing["label"])
    incoming_label = _normalized_counterparty(incoming["label"])
    if not outgoing_label or not incoming_label:
        return None
    return (
        outgoing["account_id"],
        incoming["account_id"],
        outgoing_label,
        incoming_label,
    )


def _normalized_counterparty(label: str) -> str:
    noise = {"ACH", "CREDIT", "DEBIT", "FROM", "MOBILE", "ONLINE", "PAYMENT", "TO", "TRANSFER", "WEB", "ZELLE"}
    return " ".join(
        word for word in re.findall(r"[A-Z0-9]+", label.upper())
        if word not in noise and not word.isdigit()
    )


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
          AND tombstoned = 0 AND user_archived = 0 AND pending = 0
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
        "description_equals": lambda value: str(value).casefold() == description,
        "merchant_contains": lambda value: str(value).casefold() in merchant,
        "merchant_equals": lambda value: str(value).casefold() == merchant,
        "direction": lambda value: (transaction["amount_minor"] > 0) is (value == "inflow"),
        "min_amount_minor": lambda value: transaction["amount_minor"] >= int(value),
        "max_amount_minor": lambda value: transaction["amount_minor"] <= int(value),
        "account_id": lambda value: transaction["account_id"] == value,
        "pending": lambda value: bool(transaction["pending"]) is bool(value),
    }
    return all(checks[key](value) for key, value in conditions.items())


def _subcategory_belongs_to_category(
    connection: sqlite3.Connection, subcategory_id: str | None, category_id: object
) -> bool:
    if subcategory_id is None or category_id is None or category_id is _UNSET:
        return False
    return connection.execute(
        "SELECT 1 FROM subcategories WHERE id = ? AND category_id = ? AND archived = 0",
        (subcategory_id, category_id),
    ).fetchone() is not None


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
